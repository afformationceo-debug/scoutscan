import { db } from '../web/services/db.js';
import { createDMRound, completeDMRound } from '../web/services/master-db.js';
import { sseManager } from '../web/services/sse-manager.js';
import { BrowserContextPool } from './browser-context-pool.js';
import { sendInstagramDM, type DMProgressCallback } from './dm-platforms/instagram-dm.js';
import { sendTwitterDM } from './dm-platforms/twitter-dm.js';
import { sendTikTokDM } from './dm-platforms/tiktok-dm.js';
import { ProxyRouter } from '../core/proxy.js';
import type { ProxyConfig } from '../core/types.js';
import pLimit from 'p-limit';

export class DMEngine {
  private activeCampaigns = new Map<string, boolean>(); // campaignId -> running
  private pool: BrowserContextPool;
  private _engagementEngine: any = null;

  constructor(pool: BrowserContextPool) {
    this.pool = pool;
  }

  /** Load active proxy for DM sending */
  private getProxy(platform: string): ProxyConfig | undefined {
    try {
      const rows = db.prepare('SELECT url FROM proxy_settings WHERE is_active = 1').all() as any[];
      const urls = rows.map((r: any) => r.url).filter(Boolean);
      if (urls.length === 0) return undefined;
      const router = new ProxyRouter(urls);
      return router.getProxyForPlatform(platform);
    } catch { return undefined; }
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

      // Get accounts for this campaign — MUST use campaign's designated sender only
      let accounts: any[];
      if (campaign.sender_username) {
        // Campaign has a designated sender → use ONLY that account
        accounts = db.prepare(
          `SELECT * FROM dm_accounts WHERE platform = ? AND username = ? AND status = 'active'`
        ).all(campaign.platform, campaign.sender_username) as any[];
        if (accounts.length === 0) {
          console.error(`[DMEngine] Campaign "${campaign.name}" designated sender @${campaign.sender_username} not found or not active`);
          db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
            .run('paused', new Date().toISOString(), campaignId);
          sseManager.broadcast('campaign:' + campaignId, 'error', {
            message: `지정 발송계정 @${campaign.sender_username}이 비활성 상태입니다.`,
          });
          return;
        }
        console.log(`[DMEngine] Campaign "${campaign.name}" → designated sender @${campaign.sender_username}`);
      } else {
        // No designated sender → use all active accounts for the platform
        accounts = db.prepare(
          `SELECT * FROM dm_accounts WHERE platform = ? AND status = 'active' ORDER BY daily_sent ASC`
        ).all(campaign.platform) as any[];
      }

      if (accounts.length === 0) {
        console.warn('[DMEngine] No active accounts available');
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('paused', new Date().toISOString(), campaignId);
        return;
      }

      // Launch account processing with staggered start delays
      // Each account starts 5~10s after the previous to avoid simultaneous hits
      const dmDefaults = this.getPlatformDefaults(campaign.platform);
      const accountLimit = pLimit(accounts.length);
      const accountTasks = accounts.map((account, index) =>
        accountLimit(async () => {
          if (index > 0) {
            const switchDelay = (dmDefaults.accountSwitchDelaySec * 1000) + Math.random() * 5000;
            const switchDelaySec = Math.round(switchDelay / 1000);
            console.log(`[DMEngine] Account @${account.username} start delayed ${switchDelaySec}s (stagger #${index})`);
            sseManager.broadcast('campaign:' + campaignId, 'status', {
              phase: 'account_switch',
              message: `계정 @${account.username} 전환 대기 ${switchDelaySec}초...`,
              delaySec: switchDelaySec,
            });
            await new Promise(r => setTimeout(r, switchDelay));
          }
          return this.processAccountLoop(campaignId, campaign, account);
        })
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
          await Promise.allSettled(retryAccounts.map((a, i) => retryLimit(async () => {
            if (i > 0) await new Promise(r => setTimeout(r, dmDefaults.accountSwitchDelaySec * 1000 + Math.random() * 5000));
            return this.processAccountLoop(campaignId, campaign, a);
          })));
        }
      }

      // Mark permanently failed items (exceeded max retries) as 'skipped'
      const maxRetries = campaign.max_retries || 2;
      const skippedResult = db.prepare(
        `UPDATE dm_action_queue SET execute_status = 'skipped' WHERE campaign_id = ? AND execute_status = 'failed' AND retry_count >= ?`
      ).run(campaignId, maxRetries);
      if (skippedResult.changes > 0) {
        console.log(`[DMEngine] Skipped ${skippedResult.changes} items that exceeded ${maxRetries} retries`);
      }

      // Check if all items processed
      const remaining = db.prepare(
        `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND execute_status = 'pending'`
      ).get(campaignId) as any;

      const stats = db.prepare(
        `SELECT
          SUM(CASE WHEN execute_status = 'success' THEN 1 ELSE 0 END) as sent,
          SUM(CASE WHEN execute_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN execute_status = 'skipped' THEN 1 ELSE 0 END) as skipped
        FROM dm_action_queue WHERE campaign_id = ?`
      ).get(campaignId) as any;

      const now = new Date().toISOString();
      if (remaining.cnt === 0) {
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', now, campaignId);
        // Broadcast campaign completion
        sseManager.broadcast('campaign:' + campaignId, 'campaign_completed', {
          sent: stats.sent || 0,
          failed: stats.failed || 0,
          skipped: stats.skipped || 0,
        });
        sseManager.broadcast('global', 'campaign_completed', {
          campaignName: campaign.name,
          sent: stats.sent || 0,
          failed: stats.failed || 0,
          skipped: stats.skipped || 0,
        });
      } else {
        // Still pending items, keep active
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('active', now, campaignId);
      }

      console.log(`[DMEngine] Campaign ${campaign.name}: ${remaining.cnt} remaining, sent=${stats.sent||0} failed=${stats.failed||0} skipped=${stats.skipped||0}`);
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
        // CRITICAL: Check DB status every iteration (pause/stop may have been triggered)
        const dbStatus = (db.prepare('SELECT status FROM dm_campaigns WHERE id = ?').get(campaignId) as any)?.status;
        if (dbStatus !== 'active') {
          console.log(`[DMEngine] @${account.username}: campaign status changed to "${dbStatus}" — stopping`);
          this.activeCampaigns.set(campaignId, false);
          break;
        }

        // Get next matching target for this account
        const item = this.getMatchingTarget(campaignId, campaign, account);
        if (!item) {
          console.log(`[DMEngine] @${account.username}: no more matching targets`);
          break;
        }

        // Check campaign daily limit (how many sent TODAY for this campaign)
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const campaignTodaySent = (db.prepare(
          `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND execute_status = 'success' AND executed_at >= ?`
        ).get(campaignId, today + 'T00:00:00Z') as any).cnt;
        if (campaignTodaySent >= campaign.daily_limit) {
          console.log(`[DMEngine] Campaign "${campaign.name}": daily limit reached (${campaignTodaySent}/${campaign.daily_limit})`);
          sseManager.broadcast('campaign:' + campaignId, 'status', {
            phase: 'daily_limit',
            message: `일일 한도 도달 (${campaignTodaySent}/${campaign.daily_limit})`,
          });
          break;
        }

        // Check account daily limit
        const accountState = db.prepare(
          `SELECT daily_sent, daily_limit FROM dm_accounts WHERE id = ?`
        ).get(account.id) as any;
        if (accountState.daily_sent >= accountState.daily_limit) {
          console.log(`[DMEngine] @${account.username}: account daily limit reached (${accountState.daily_sent}/${accountState.daily_limit})`);
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
        sseManager.broadcast('global', 'dm_processing', {
          campaign: campaign.name, platform: campaign.platform,
          account: account.username, recipient: item.recipient_username,
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
              // Save engagement details to queue item
              db.prepare(`UPDATE dm_action_queue SET liked_post_url = ?, comment_text = ?, commented_post_url = ? WHERE id = ?`)
                .run(engResult.likedPostUrl || null, engResult.commentText || null, engResult.commentedPostUrl || null, item.id);
              sseManager.broadcast('campaign:' + campaignId, 'engagement', {
                account: account.username,
                recipient: item.recipient_username,
                liked: engResult.liked,
                commented: engResult.commented,
                likedPostUrl: engResult.likedPostUrl || null,
                commentText: engResult.commentText || null,
                commentedPostUrl: engResult.commentedPostUrl || null,
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

        // Step 2: Send DM — with proxy fallback on tunnel failure
        let proxyUsed = this.getProxy(campaign.platform);
        try {
          try {
            await this.sendDM(campaign.platform, account, item.recipient_username, item.message_rendered, campaignId);
          } catch (proxyErr) {
            // If proxy tunnel failed, retry without proxy
            if ((proxyErr as Error).message.includes('ERR_TUNNEL_CONNECTION_FAILED') && proxyUsed) {
              console.warn(`[DMEngine] Proxy tunnel failed for @${item.recipient_username}, retrying without proxy...`);
              sseManager.broadcast('campaign:' + campaignId, 'status', {
                phase: 'proxy_fallback',
                message: `프록시 연결 실패 → 직접 연결로 재시도...`,
              });
              proxyUsed = undefined; // Mark as direct
              await this.sendDM(campaign.platform, account, item.recipient_username, item.message_rendered, campaignId);
            } else {
              throw proxyErr;
            }
          }

          // Success — record with proxy info
          const now = new Date().toISOString();
          const proxyIp = proxyUsed ? `${proxyUsed.host}:${proxyUsed.port}` : 'direct';
          db.prepare(`UPDATE dm_action_queue SET execute_status = 'success', executed_at = ?, proxy_ip = ? WHERE id = ?`)
            .run(now, proxyIp, item.id);
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
          sseManager.broadcast('global', 'dm_sent', {
            campaign: campaign.name,
            platform: campaign.platform,
            account: account.username,
            recipient: item.recipient_username,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          const failProxyIp = proxyUsed ? `${proxyUsed.host}:${proxyUsed.port}` : 'direct';
          db.prepare(`UPDATE dm_action_queue SET execute_status = 'failed', error_message = ?, retry_count = retry_count + 1, proxy_ip = ? WHERE id = ?`)
            .run(errMsg, failProxyIp, item.id);
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
          sseManager.broadcast('global', 'dm_failed', {
            campaign: campaign.name,
            platform: campaign.platform,
            account: account.username,
            recipient: item.recipient_username,
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
            sseManager.broadcast('campaign:' + campaignId, 'account_blocked', {
              account: account.username,
              reason: errMsg.slice(0, 200),
            });
            break;
          }

          // Send failed detection (message not actually delivered)
          if (errMsg.includes('send_failed') || errMsg.includes('not delivered')) {
            console.warn(`[DMEngine] @${account.username} send failed for @${item.recipient_username}: message not delivered`);
            sseManager.broadcast('campaign:' + campaignId, 'send_failed', {
              account: account.username,
              recipient: item.recipient_username,
              reason: errMsg.slice(0, 200),
            });
            // Don't break - try next recipient, might be recipient-specific issue
          }
        }

        // Anti-bot delay: campaign override → platform global default → hardcoded fallback
        const dmDefaults = this.getPlatformDefaults(campaign.platform);
        const minDelay = (campaign.delay_min_sec || dmDefaults.delayMinSec) * 1000;
        const maxDelay = (campaign.delay_max_sec || dmDefaults.delayMaxSec) * 1000;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);
        const delaySec = Math.round(delay / 1000);
        sseManager.broadcast('campaign:' + campaignId, 'status', {
          phase: 'delay',
          message: `다음 DM까지 ${delaySec}초 대기 중...`,
          delaySec,
          sentCount,
          failedCount,
        });
        // Interruptible sleep: check pause every 2 seconds during delay
        for (let waited = 0; waited < delay; waited += 2000) {
          if (!this.activeCampaigns.get(campaignId)) break;
          await new Promise(r => setTimeout(r, Math.min(2000, delay - waited)));
        }

        // Cooldown: platform global default → hardcoded fallback
        const cooldownAfter = dmDefaults.cooldownAfter;
        if (sessionSentCount > 0 && sessionSentCount % cooldownAfter === 0) {
          const cooldownMin = dmDefaults.cooldownMinSec * 1000;
          const cooldownMax = dmDefaults.cooldownMaxSec * 1000;
          const cooldown = cooldownMin + Math.random() * (cooldownMax - cooldownMin);
          const cooldownMinutes = Math.round(cooldown / 60000);
          console.log(`[DMEngine] @${account.username} cooldown ${cooldownMinutes}min after ${sessionSentCount} sends`);
          sseManager.broadcast('campaign:' + campaignId, 'status', {
            phase: 'cooldown',
            message: `${sessionSentCount}건 발송 후 ${cooldownMinutes}분 쿨다운...`,
            cooldownMin: cooldownMinutes,
          });
          // Interruptible cooldown: check pause every 5 seconds
          for (let waited = 0; waited < cooldown; waited += 5000) {
            if (!this.activeCampaigns.get(campaignId)) break;
            await new Promise(r => setTimeout(r, Math.min(5000, cooldown - waited)));
          }
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
    // CRITICAL: Verify account-campaign matching before sending
    if (campaignId) {
      const campaign = db.prepare('SELECT name, sender_username FROM dm_campaigns WHERE id = ?').get(campaignId) as any;
      if (campaign?.sender_username && campaign.sender_username !== account.username) {
        const err = `BLOCKED: Account @${account.username} is not authorized for campaign "${campaign.name}" (designated: @${campaign.sender_username})`;
        console.error(`[DMEngine] ${err}`);
        throw new Error(err);
      }
    }

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

    // Load proxy for DM sending
    const proxy = this.getProxy(platform);
    console.log(`[DMEngine] sendDM @${account.username} → @${recipientUsername} | campaign: ${campaignId?.slice(0, 8)} | proxy: ${proxy ? proxy.host + ':' + proxy.port : 'NONE (direct IP)'}`);

    switch (platform) {
      case 'instagram':
        await sendInstagramDM(this.pool, account, recipientUsername, message, onProgress, proxy);
        break;
      case 'twitter':
        await sendTwitterDM(this.pool, account, recipientUsername, message, proxy, account.dm_pin);
        break;
      case 'tiktok':
        await sendTikTokDM(this.pool, account, recipientUsername, message, proxy);
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

    // Per-account targeting filters (EN → expand to English-speaking countries)
    if (account.target_country) {
      const countryAliases: Record<string, string[]> = {
        'EN': ['US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'SG', 'PH', 'IN'],
        'ZH': ['TW', 'HK', 'CN', 'SG'],
      };
      const accCountryUpper = account.target_country.toUpperCase();
      const accCountries = countryAliases[accCountryUpper] || [accCountryUpper];
      conditions.push(`UPPER(COALESCE(im.ai_country, im.detected_country)) IN (${accCountries.map(() => '?').join(',')})`);
      params.push(...accCountries);
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

    // Auto-fill linked_keyword_group with platform-only (country comes from AI classification)
    if (!campaign.linked_keyword_group && campaign.platform) {
      db.prepare('UPDATE dm_campaigns SET linked_keyword_group = ? WHERE id = ?').run(campaign.platform, campaignId);
      campaign.linked_keyword_group = campaign.platform;
      console.log(`[DMEngine] Auto-set keyword group for ${campaign.name}: ${campaign.platform}`);
    }

    const conditions: string[] = ['dm_status = \'pending\''];
    const params: any[] = [];

    if (campaign.platform) { conditions.push('platform = ?'); params.push(campaign.platform); }

    // Country matching: AI classification first, then geo-detection
    // 'EN' is a language alias → expand to English-speaking country codes
    if (campaign.target_country) {
      const countryAliases: Record<string, string[]> = {
        'EN': ['US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'SG', 'PH', 'IN'],
        'ZH': ['TW', 'HK', 'CN', 'SG'],
      };
      const targetUpper = campaign.target_country.toUpperCase();
      const countries = countryAliases[targetUpper] || [targetUpper];
      conditions.push('COALESCE(ai_country, detected_country) IS NOT NULL');
      conditions.push(`UPPER(COALESCE(ai_country, detected_country)) IN (${countries.map(() => '?').join(',')})`);
      params.push(...countries);
    }
    if (campaign.target_tiers) {
      const tiers = JSON.parse(campaign.target_tiers);
      conditions.push(`scout_tier IN (${tiers.map(() => '?').join(',')})`);
      params.push(...tiers);
    }
    if (campaign.min_followers) { conditions.push('followers_count >= ?'); params.push(campaign.min_followers); }
    if (campaign.max_followers) { conditions.push('followers_count <= ?'); params.push(campaign.max_followers); }

    // Country + Platform matching is sufficient for campaign targeting
    // source_pair_ids filter removed: all influencers matching country+platform should be eligible
    console.log(`[DMEngine] Queue filter: platform=${campaign.platform} | country=${campaign.target_country || 'any'}`);

    // Exclude already queued in THIS campaign only (other campaigns can send to same influencer)
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
    // Log campaign-template binding for audit
    console.log(`[DMEngine] Queue generation: campaign="${campaign.name}" (${campaignId.slice(0, 8)}) sender=@${campaign.sender_username || 'any'} template="${(campaign.message_template || '').slice(0, 30)}..."`);

    const insertStmt = db.prepare(`
      INSERT INTO dm_action_queue (influencer_key, campaign_id, platform, message_rendered, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const updateCampaignIdStmt = db.prepare(
      `UPDATE influencer_master SET dm_campaign_id = ? WHERE influencer_key = ? AND (dm_campaign_id IS NULL OR dm_campaign_id = '')`
    );

    let queued = 0;
    for (const inf of influencers) {
      const message = this.renderTemplate(campaign.message_template, inf);
      insertStmt.run(inf.influencer_key, campaignId, inf.platform, message, now);
      updateCampaignIdStmt.run(campaignId, inf.influencer_key);
      queued++;
    }

    db.prepare('UPDATE dm_campaigns SET total_queued = total_queued + ?, updated_at = ? WHERE id = ?')
      .run(queued, now, campaignId);

    return queued;
  }

  /** Auto-replenish queues: add new profiles to active/paused/completed campaigns */
  autoReplenishQueues(): number {
    const activeCampaigns = db.prepare(
      `SELECT * FROM dm_campaigns WHERE status IN ('active', 'paused', 'completed') AND total_queued > 0`
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

  /** Placeholder: check inbox for replies after sending DM.
   *  TODO: implement per-platform inbox checking logic.
   */
  async checkForReply(platform: string, account: any, recipientUsername: string, queueItemId: number): Promise<boolean> {
    // Placeholder — actual inbox checking will be implemented per platform.
    // When implemented, this should:
    // 1. Open the conversation with recipientUsername
    // 2. Check if there's a new message from them
    // 3. If reply detected, update the queue item and campaign stats
    const replyDetected = false;

    if (replyDetected) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE dm_action_queue SET reply_detected = 1, reply_detected_at = ? WHERE id = ?`)
        .run(now, queueItemId);
      // Also increment the campaign's total_replied counter
      db.prepare(`UPDATE dm_campaigns SET total_replied = total_replied + 1, updated_at = ? WHERE campaign_id = (SELECT campaign_id FROM dm_action_queue WHERE id = ?)`)
        .run(now, queueItemId);
    }
    return replyDetected;
  }

  /** Get reply count for a campaign */
  getReplyCount(campaignId: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND reply_detected = 1`
    ).get(campaignId) as any;
    return row?.cnt || 0;
  }

  /** Get platform-level DM defaults (delay, cooldown, etc.) */
  private getPlatformDefaults(platform: string): {
    delayMinSec: number; delayMaxSec: number;
    cooldownAfter: number; cooldownMinSec: number; cooldownMaxSec: number;
    accountSwitchDelaySec: number; dailyLimitDefault: number;
  } {
    try {
      const row = db.prepare('SELECT * FROM platform_dm_defaults WHERE platform = ?').get(platform) as any;
      if (row) {
        return {
          delayMinSec: row.delay_min_sec,
          delayMaxSec: row.delay_max_sec,
          cooldownAfter: row.cooldown_after,
          cooldownMinSec: row.cooldown_min_sec,
          cooldownMaxSec: row.cooldown_max_sec,
          accountSwitchDelaySec: row.account_switch_delay_sec,
          dailyLimitDefault: row.daily_limit_default,
        };
      }
    } catch { /* table may not exist */ }
    // Hardcoded fallback
    return {
      delayMinSec: 60, delayMaxSec: 180,
      cooldownAfter: 20, cooldownMinSec: 900, cooldownMaxSec: 1800,
      accountSwitchDelaySec: 5, dailyLimitDefault: 40,
    };
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
}
