import { db } from '../web/services/db.js';
import { createDMRound, completeDMRound } from '../web/services/master-db.js';
import { sseManager } from '../web/services/sse-manager.js';
import { BrowserContextPool } from './browser-context-pool.js';
import { sendInstagramDM, type DMProgressCallback } from './dm-platforms/instagram-dm.js';
import { sendTwitterDM } from './dm-platforms/twitter-dm.js';
import { sendTikTokDM } from './dm-platforms/tiktok-dm.js';
import pLimit from 'p-limit';

export class DMEngine {
  private activeCampaigns = new Map<string, boolean>(); // campaignId -> running
  private pool: BrowserContextPool;
  private _engagementEngine: any = null;

  constructor(pool: BrowserContextPool) {
    this.pool = pool;
  }

  /** Lazily set engagement engine to avoid circular deps */
  setEngagementEngine(engine: any): void {
    this._engagementEngine = engine;
  }

  /** Process a campaign -- parallel account execution */
  async processCampaign(campaignId: string): Promise<void> {
    if (this.activeCampaigns.get(campaignId)) {
      throw new Error('Campaign already running');
    }
    this.activeCampaigns.set(campaignId, true);

    try {
      const campaign = db.prepare('SELECT * FROM dm_campaigns WHERE id = ?').get(campaignId) as any;
      if (!campaign) throw new Error('Campaign not found');

      db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
        .run('active', new Date().toISOString(), campaignId);

      // Reset any stuck 'processing' items back to 'pending' (from previous interrupted runs)
      const stuckReset = db.prepare(
        `UPDATE dm_action_queue SET execute_status = 'pending', account_username = NULL WHERE campaign_id = ? AND execute_status = 'processing'`
      ).run(campaignId);
      if (stuckReset.changes > 0) {
        console.log(`[DMEngine] Reset ${stuckReset.changes} stuck processing items to pending`);
      }

      // Get all active accounts for this campaign's platform
      const accounts = db.prepare(
        `SELECT * FROM dm_accounts WHERE platform = ? AND status = 'active' ORDER BY daily_sent ASC`
      ).all(campaign.platform) as any[];

      if (accounts.length === 0) {
        console.warn('[DMEngine] No active accounts available');
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('paused', new Date().toISOString(), campaignId);
        return;
      }

      // Launch parallel account processing (each account sequential, accounts in parallel)
      const accountLimit = pLimit(accounts.length);
      const accountTasks = accounts.map(account =>
        accountLimit(() => this.processAccountLoop(campaignId, campaign, account))
      );

      await Promise.allSettled(accountTasks);

      // Retry failed items (up to max_retries)
      const retryable = db.prepare(
        `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND execute_status = 'failed' AND retry_count < ?`
      ).get(campaignId, campaign.max_retries || 2) as any;

      if (retryable.cnt > 0) {
        console.log(`[DMEngine] Retrying ${retryable.cnt} failed targets...`);
        db.prepare(
          `UPDATE dm_action_queue SET execute_status = 'pending', account_username = NULL WHERE campaign_id = ? AND execute_status = 'failed' AND retry_count < ?`
        ).run(campaignId, campaign.max_retries || 2);
        // Re-run with retries
        const retryAccounts = db.prepare(
          `SELECT * FROM dm_accounts WHERE platform = ? AND status = 'active' ORDER BY daily_sent ASC`
        ).all(campaign.platform) as any[];
        if (retryAccounts.length > 0) {
          const retryLimit = pLimit(retryAccounts.length);
          await Promise.allSettled(retryAccounts.map(a => retryLimit(() => this.processAccountLoop(campaignId, campaign, a))));
        }
      }

      // Check if all items processed
      const remaining = db.prepare(
        `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND execute_status = 'pending'`
      ).get(campaignId) as any;

      if (remaining.cnt === 0) {
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', new Date().toISOString(), campaignId);
      } else {
        // Still pending items, keep active
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('active', new Date().toISOString(), campaignId);
      }

      console.log(`[DMEngine] Campaign ${campaign.name}: ${remaining.cnt} remaining`);
    } finally {
      this.activeCampaigns.delete(campaignId);
    }
  }

  /** Per-account sequential processing loop */
  private async processAccountLoop(campaignId: string, campaign: any, account: any): Promise<void> {
    let sentCount = 0;
    let failedCount = 0;
    let engagedCount = 0;

    // Create a new round for this account
    const roundId = createDMRound(campaignId, account.username, 0);

    try {
      let sessionSentCount = 0;

      while (this.activeCampaigns.get(campaignId)) {
        // Get next matching target for this account
        const item = this.getMatchingTarget(campaignId, campaign, account);
        if (!item) {
          console.log(`[DMEngine] @${account.username}: no more matching targets`);
          break;
        }

        // Check daily limit
        const accountState = db.prepare(
          `SELECT daily_sent, daily_limit FROM dm_accounts WHERE id = ?`
        ).get(account.id) as any;
        if (accountState.daily_sent >= accountState.daily_limit) {
          console.log(`[DMEngine] @${account.username}: daily limit reached (${accountState.daily_sent}/${accountState.daily_limit})`);
          break;
        }

        // Mark as processing, assign to this account
        db.prepare('UPDATE dm_action_queue SET execute_status = ?, account_username = ?, round_id = ? WHERE id = ?')
          .run('processing', account.username, roundId, item.id);

        sseManager.broadcast('campaign:' + campaignId, 'status', {
          phase: 'processing',
          message: `@${item.recipient_username} 처리 중...`,
          recipient: item.recipient_username,
        });

        // Step 1: Engagement before DM (if enabled)
        const engageBeforeDm = account.engage_before_dm || 0;
        if (engageBeforeDm && this._engagementEngine) {
          try {
            sseManager.broadcast('campaign:' + campaignId, 'step', {
              phase: 'engage_start',
              step: 'engage_start',
              recipient: item.recipient_username,
              account: account.username,
              detail: `@${item.recipient_username} 프로필 방문 → 좋아요/댓글 진행 중...`,
            });
            const engResult = await this._engagementEngine.engageWithInfluencer(
              campaign.platform,
              account.username,
              item.influencer_key,
              campaignId,
              {
                like: true,
                comment: !!account.comment_template_category,
                commentCategory: account.comment_template_category || undefined,
              }
            );
            if (engResult.liked || engResult.commented) {
              engagedCount++;
              db.prepare('UPDATE dm_action_queue SET engagement_status = ? WHERE id = ?')
                .run('engaged', item.id);
              sseManager.broadcast('campaign:' + campaignId, 'engagement', {
                account: account.username,
                recipient: item.recipient_username,
                liked: engResult.liked,
                commented: engResult.commented,
              });
            }
            // Wait 30-60s after engagement before DM
            const engDelay = 30000 + Math.random() * 30000;
            const engDelaySec = Math.round(engDelay / 1000);
            sseManager.broadcast('campaign:' + campaignId, 'status', {
              phase: 'engage_wait',
              message: `@${item.recipient_username} 참여 후 ${engDelaySec}초 대기...`,
              delaySec: engDelaySec,
              recipient: item.recipient_username,
            });
            await new Promise(r => setTimeout(r, engDelay));
          } catch (err) {
            console.warn(`[DMEngine] Engagement failed for ${item.influencer_key}: ${(err as Error).message}`);
          }
        }

        // Step 2: Send DM — all platforms use browser-based DM modules
        try {
          await this.sendDM(campaign.platform, account, item.recipient_username, item.message_rendered, campaignId);

          // Success
          const now = new Date().toISOString();
          db.prepare(`UPDATE dm_action_queue SET execute_status = 'success', executed_at = ? WHERE id = ?`)
            .run(now, item.id);
          db.prepare(`UPDATE influencer_master SET dm_status = 'sent', dm_last_sent_at = ?, dm_campaign_id = ?, last_updated_at = ? WHERE influencer_key = ?`)
            .run(now, campaignId, now, item.influencer_key);
          db.prepare(`UPDATE dm_accounts SET daily_sent = daily_sent + 1, last_sent_at = ? WHERE id = ?`)
            .run(now, account.id);
          db.prepare(`UPDATE dm_campaigns SET total_sent = total_sent + 1, updated_at = ? WHERE id = ?`)
            .run(now, campaignId);

          sentCount++;
          sessionSentCount++;
          console.log(`[DMEngine] @${account.username} sent #${sentCount} to @${item.recipient_username}`);

          // Broadcast via SSE
          sseManager.broadcast('campaign:' + campaignId, 'dm_sent', {
            account: account.username,
            recipient: item.recipient_username,
            sentCount,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          db.prepare(`UPDATE dm_action_queue SET execute_status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?`)
            .run(errMsg, item.id);
          db.prepare(`UPDATE dm_campaigns SET total_failed = total_failed + 1, updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), campaignId);

          failedCount++;
          console.warn(`[DMEngine] @${account.username} failed to @${item.recipient_username}: ${errMsg}`);

          sseManager.broadcast('campaign:' + campaignId, 'dm_failed', {
            account: account.username,
            recipient: item.recipient_username,
            error: errMsg.slice(0, 100),
            failedCount,
          });

          // Cookie expiration detection → mark account + broadcast
          if (errMsg.includes('cookie_expired')) {
            db.prepare(`UPDATE dm_accounts SET status = 'cookie_expired', cookie_status = 'expired' WHERE id = ?`)
              .run(account.id);
            sseManager.broadcast('cookie-health', 'expired', {
              platform: campaign.platform,
              username: account.username,
            });
            console.warn(`[DMEngine] @${account.username} cookie expired, stopping`);
            break;
          }

          // Account block detection
          if (errMsg.includes('blocked') || errMsg.includes('spam') || errMsg.includes('challenge')) {
            db.prepare(`UPDATE dm_accounts SET status = 'blocked' WHERE id = ?`).run(account.id);
            console.warn(`[DMEngine] @${account.username} appears blocked, stopping`);
            break;
          }
        }

        // Anti-bot delay
        const minDelay = (campaign.delay_min_sec || 45) * 1000;
        const maxDelay = (campaign.delay_max_sec || 120) * 1000;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);
        const delaySec = Math.round(delay / 1000);
        sseManager.broadcast('campaign:' + campaignId, 'status', {
          phase: 'delay',
          message: `다음 DM까지 ${delaySec}초 대기 중...`,
          delaySec,
          sentCount,
          failedCount,
        });
        await new Promise(r => setTimeout(r, delay));

        // Cooldown after every 20 sends
        if (sessionSentCount > 0 && sessionSentCount % 20 === 0) {
          const cooldown = 15 * 60 * 1000 + Math.random() * 15 * 60 * 1000;
          const cooldownMin = Math.round(cooldown / 60000);
          console.log(`[DMEngine] @${account.username} cooldown ${cooldownMin}min after ${sessionSentCount} sends`);
          sseManager.broadcast('campaign:' + campaignId, 'status', {
            phase: 'cooldown',
            message: `${sessionSentCount}건 발송 후 ${cooldownMin}분 쿨다운...`,
            cooldownMin,
          });
          await new Promise(r => setTimeout(r, cooldown));
        }
      }
    } finally {
      // Step 3: Complete round
      completeDMRound(roundId, sentCount, failedCount, engagedCount);
      console.log(`[DMEngine] @${account.username} round complete: sent=${sentCount} failed=${failedCount} engaged=${engagedCount}`);
      sseManager.broadcast('campaign:' + campaignId, 'round_complete', {
        account: account.username,
        sentCount,
        failedCount,
        engagedCount,
      });
    }
  }

  /** Route DM to the correct platform module */
  private async sendDM(platform: string, account: any, recipientUsername: string, message: string, campaignId?: string): Promise<void> {
    // Create progress callback that broadcasts each step via SSE
    const onProgress: DMProgressCallback = campaignId
      ? (step, detail) => {
          sseManager.broadcast('campaign:' + campaignId, 'step', {
            phase: 'dm_step',
            step,
            recipient: recipientUsername,
            account: account.username,
            detail,
          });
        }
      : () => {};

    switch (platform) {
      case 'instagram':
        await sendInstagramDM(this.pool, account, recipientUsername, message, onProgress);
        break;
      case 'twitter':
        await sendTwitterDM(this.pool, account, recipientUsername, message);
        break;
      case 'tiktok':
        await sendTikTokDM(this.pool, account, recipientUsername, message);
        break;
      default:
        throw new Error(`DM not supported for platform: ${platform}`);
    }
  }

  /** Get next matching target for a specific account (per-account filtering + real-time assignment) */
  private getMatchingTarget(campaignId: string, campaign: any, account: any): any | null {
    const conditions: string[] = [
      `q.campaign_id = ?`,
      `q.execute_status = 'pending'`,
      `q.account_username IS NULL`, // Not yet assigned
    ];
    const params: any[] = [campaignId];

    // Per-account targeting filters
    if (account.target_country) {
      conditions.push('im.detected_country = ?');
      params.push(account.target_country);
    }
    if (account.target_tiers) {
      try {
        const tiers = JSON.parse(account.target_tiers);
        if (tiers.length > 0) {
          conditions.push(`im.scout_tier IN (${tiers.map(() => '?').join(',')})`);
          params.push(...tiers);
        }
      } catch { /* ignore parse errors */ }
    }
    if (account.target_min_followers) {
      conditions.push('im.followers_count >= ?');
      params.push(account.target_min_followers);
    }
    if (account.target_max_followers) {
      conditions.push('im.followers_count <= ?');
      params.push(account.target_max_followers);
    }

    const where = conditions.join(' AND ');
    return db.prepare(`
      SELECT q.*, im.username as recipient_username, im.full_name as recipient_name
      FROM dm_action_queue q
      JOIN influencer_master im ON q.influencer_key = im.influencer_key
      WHERE ${where}
      ORDER BY q.id
      LIMIT 1
    `).get(...params) as any || null;
  }

  /** Pause a running campaign */
  pauseCampaign(campaignId: string): void {
    this.activeCampaigns.set(campaignId, false);
    db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
      .run('paused', new Date().toISOString(), campaignId);
  }

  /** Generate action queue for a campaign from targeting query */
  generateQueue(campaignId: string): number {
    const campaign = db.prepare('SELECT * FROM dm_campaigns WHERE id = ?').get(campaignId) as any;
    if (!campaign) throw new Error('Campaign not found');

    const conditions: string[] = ['dm_status = \'pending\''];
    const params: any[] = [];

    if (campaign.platform) { conditions.push('platform = ?'); params.push(campaign.platform); }
    if (campaign.target_country) {
      // Use AI country if available, fall back to geo-detected country
      conditions.push('UPPER(COALESCE(ai_country, detected_country)) = UPPER(?)');
      params.push(campaign.target_country);
    }
    if (campaign.target_tiers) {
      const tiers = JSON.parse(campaign.target_tiers);
      conditions.push(`scout_tier IN (${tiers.map(() => '?').join(',')})`);
      params.push(...tiers);
    }
    if (campaign.min_followers) { conditions.push('followers_count >= ?'); params.push(campaign.min_followers); }
    if (campaign.max_followers) { conditions.push('followers_count <= ?'); params.push(campaign.max_followers); }

    // Exclude already queued
    conditions.push(`influencer_key NOT IN (SELECT influencer_key FROM dm_action_queue WHERE campaign_id = ?)`);
    params.push(campaignId);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const candidates = db.prepare(
      `SELECT * FROM influencer_master ${where} ORDER BY followers_count DESC LIMIT 1000`
    ).all(...params) as any[];

    // Filter: prefer AI classification, fall back to keyword-based analysis
    const influencers = candidates.filter(inf => {
      // If AI has classified this profile, use AI result
      if (inf.ai_classified_at) {
        return inf.ai_is_influencer === 1;
      }
      // Fall back to keyword-based business detection
      return !this.isRealBusiness(inf);
    });
    const filtered = candidates.length - influencers.length;
    if (filtered > 0) {
      console.log(`[DMEngine] Filtered ${filtered} business/agency profiles from ${candidates.length} candidates`);
    }

    const now = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT INTO dm_action_queue (influencer_key, campaign_id, platform, message_rendered, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    let queued = 0;
    for (const inf of influencers) {
      const message = this.renderTemplate(campaign.message_template, inf);
      insertStmt.run(inf.influencer_key, campaignId, inf.platform, message, now);
      queued++;
    }

    db.prepare('UPDATE dm_campaigns SET total_queued = total_queued + ?, updated_at = ? WHERE id = ?')
      .run(queued, now, campaignId);

    return queued;
  }

  /** Auto-replenish queues: add new profiles to active campaigns */
  autoReplenishQueues(): number {
    const activeCampaigns = db.prepare(
      `SELECT * FROM dm_campaigns WHERE status IN ('active', 'paused') AND total_queued > 0`
    ).all() as any[];

    let totalAdded = 0;
    for (const campaign of activeCampaigns) {
      try {
        const added = this.generateQueue(campaign.id);
        if (added > 0) {
          console.log(`[DMEngine] Replenished ${added} targets for campaign ${campaign.name}`);
          totalAdded += added;
        }
      } catch (err) {
        console.warn(`[DMEngine] Replenish failed for ${campaign.id}: ${(err as Error).message}`);
      }
    }
    return totalAdded;
  }

  /** Get IDs of currently active campaigns (before recovery) */
  getActiveCampaignIds(): string[] {
    const rows = db.prepare(`SELECT id FROM dm_campaigns WHERE status = 'active'`).all() as any[];
    return rows.map(r => r.id);
  }

  /** Recover stuck campaigns on server restart */
  recoverStuckCampaigns(): number {
    const result = db.prepare(
      `UPDATE dm_campaigns SET status = 'paused', updated_at = ? WHERE status = 'active'`
    ).run(new Date().toISOString());
    return result.changes || 0;
  }

  /** Render message template with influencer data */
  renderTemplate(template: string, influencer: any): string {
    return template
      .replace(/\{\{username\}\}/g, influencer.username || '')
      .replace(/\{\{full_name\}\}/g, influencer.full_name || influencer.username || '')
      .replace(/\{\{followers_count\}\}/g, this.formatNumber(influencer.followers_count || 0))
      .replace(/\{\{platform\}\}/g, influencer.platform || '')
      .replace(/\{\{brand\}\}/g, influencer.brand || '')
      .replace(/\{\{campaign_name\}\}/g, influencer.campaign_name || '');
  }

  /**
   * Detect if a profile is a real business/clinic/agency (not an influencer).
   * Uses bio text + category analysis rather than just the is_business flag,
   * since many influencers also use business accounts.
   */
  private isRealBusiness(inf: any): boolean {
    const bio = (inf.bio || '').toLowerCase();
    const category = (inf.category || '').toLowerCase();
    const username = (inf.username || '').toLowerCase();

    // Business category keywords (strong signal)
    const bizCategories = ['brand', 'product/service', 'health/beauty', 'medical', 'shopping'];
    const hasBizCategory = bizCategories.some(c => category.includes(c));

    // Bio keywords indicating real businesses (clinics, shops, agencies, media)
    const businessKeywords = [
      // Japanese
      'クリニック', '皮膚科', '病院', '医院', '整形', '公式', '予約', '施術',
      '美容外科', '美容皮膚科', 'アートメイク', '専門店', '公式line', '公式ライン',
      '営業時間', '予約制', '予約受付', '看板', '開院', '料金',
      // Korean
      '클리닉', '피부과', '병원', '의원', '성형', '공식', '예약',
      // English
      'clinic', 'dermatology', 'hospital', 'official account', 'book now',
      'appointment', 'surgery', 'our service', 'we offer',
      // Brand/media/agency indicators
      '公式instagram', '公式アカウント', 'オフィシャル', '株式会社',
      '有限会社', '合同会社', '事務所', 'agency', 'management',
      '編集部', '雑誌', 'メディア', '出版',
    ];

    const hasBizKeyword = businessKeywords.some(kw => bio.includes(kw.toLowerCase()));

    // Strong username patterns (clinic/official in username = almost certainly business)
    const strongUsernamePatterns = [/clinic/i, /official$/i, /skincare$/i, /_skin$/i];
    const hasStrongUsername = strongUsernamePatterns.some(p => p.test(username));

    // Strong: bio keywords match → definitely business
    if (hasBizKeyword) return true;

    // Strong: "clinic" or "official" in username → definitely business
    if (hasStrongUsername) return true;

    // Medium: business category + weak username signals → likely business
    const weakUsernamePatterns = [/_global/i, /_md/i, /\.md/i, /\.ps/i];
    const hasWeakUsername = weakUsernamePatterns.some(p => p.test(username));
    if (hasBizCategory && hasWeakUsername) return true;

    return false;
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
}
