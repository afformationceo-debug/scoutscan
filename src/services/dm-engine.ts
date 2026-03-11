import { db } from '../web/services/db.js';

// instagram-private-api is CJS, use dynamic import
let IgApiClient: any = null;
async function getIgApi() {
  if (!IgApiClient) {
    const mod = await import('instagram-private-api');
    IgApiClient = mod.IgApiClient;
  }
  return IgApiClient;
}

export class DMEngine {
  private activeCampaigns = new Map<string, boolean>(); // campaignId -> running
  private accountMessageCount = new Map<string, number>(); // account username -> messages since last rotation

  /** Process a campaign -- main send loop */
  async processCampaign(campaignId: string): Promise<void> {
    if (this.activeCampaigns.get(campaignId)) {
      throw new Error('Campaign already running');
    }
    this.activeCampaigns.set(campaignId, true);

    try {
      // Get campaign details
      const campaign = db.prepare('SELECT * FROM dm_campaigns WHERE id = ?').get(campaignId) as any;
      if (!campaign) throw new Error('Campaign not found');

      // Update status to active
      db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
        .run('active', new Date().toISOString(), campaignId);

      // Get pending queue items
      const queueItems = db.prepare(
        `SELECT q.*, im.username as recipient_username, im.full_name as recipient_name
         FROM dm_action_queue q
         JOIN influencer_master im ON q.influencer_key = im.influencer_key
         WHERE q.campaign_id = ? AND q.execute_status = 'pending'
         ORDER BY q.id`
      ).all(campaignId) as any[];

      if (queueItems.length === 0) {
        console.log(`[DMEngine] No pending items for campaign ${campaignId}`);
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', new Date().toISOString(), campaignId);
        return;
      }

      console.log(`[DMEngine] Processing ${queueItems.length} items for campaign ${campaign.name}`);
      let sentCount = 0;
      let currentAccount: any = null;
      let sessionSentCount = 0;

      for (const item of queueItems) {
        // Check if paused
        if (!this.activeCampaigns.get(campaignId)) {
          console.log(`[DMEngine] Campaign ${campaignId} paused`);
          break;
        }

        // Get available account (rotate every 10 messages)
        if (!currentAccount || (this.accountMessageCount.get(currentAccount.username) || 0) >= 10) {
          currentAccount = this.getAvailableAccount(campaign.platform);
          if (!currentAccount) {
            console.warn('[DMEngine] No available accounts, stopping');
            break;
          }
          this.accountMessageCount.set(currentAccount.username, 0);
          console.log(`[DMEngine] Switched to account @${currentAccount.username}`);
        }

        // Mark as processing
        db.prepare('UPDATE dm_action_queue SET execute_status = ?, account_username = ? WHERE id = ?')
          .run('processing', currentAccount.username, item.id);

        try {
          // Send DM
          if (campaign.platform === 'instagram') {
            await this.sendInstagramDM(currentAccount, item.recipient_username, item.message_rendered);
          } else {
            await this.sendBrowserDM(campaign.platform, currentAccount, item.recipient_username, item.message_rendered);
          }

          // Success
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE dm_action_queue SET execute_status = 'success', executed_at = ? WHERE id = ?`
          ).run(now, item.id);

          // Update influencer_master dm_status
          db.prepare(
            `UPDATE influencer_master SET dm_status = 'sent', dm_last_sent_at = ?, dm_campaign_id = ?, last_updated_at = ? WHERE influencer_key = ?`
          ).run(now, campaignId, now, item.influencer_key);

          // Update account counter
          db.prepare(
            `UPDATE dm_accounts SET daily_sent = daily_sent + 1, last_sent_at = ? WHERE platform = ? AND username = ?`
          ).run(now, campaign.platform, currentAccount.username);

          // Update campaign counter
          db.prepare(
            `UPDATE dm_campaigns SET total_sent = total_sent + 1, updated_at = ? WHERE id = ?`
          ).run(now, campaignId);

          sentCount++;
          sessionSentCount++;
          this.accountMessageCount.set(currentAccount.username, (this.accountMessageCount.get(currentAccount.username) || 0) + 1);

          console.log(`[DMEngine] Sent #${sentCount} to @${item.recipient_username} via @${currentAccount.username}`);

        } catch (err) {
          const errMsg = (err as Error).message;
          db.prepare(
            `UPDATE dm_action_queue SET execute_status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?`
          ).run(errMsg, item.id);
          db.prepare(
            `UPDATE dm_campaigns SET total_failed = total_failed + 1, updated_at = ? WHERE id = ?`
          ).run(new Date().toISOString(), campaignId);

          console.warn(`[DMEngine] Failed to send to @${item.recipient_username}: ${errMsg}`);

          // If account seems blocked, mark it
          if (errMsg.includes('blocked') || errMsg.includes('spam') || errMsg.includes('challenge')) {
            db.prepare(`UPDATE dm_accounts SET status = 'blocked' WHERE platform = ? AND username = ?`)
              .run(campaign.platform, currentAccount.username);
            currentAccount = null; // Force rotation
          }
        }

        // Anti-bot delay (random between campaign's min and max delay)
        const minDelay = (campaign.delay_min_sec || 45) * 1000;
        const maxDelay = (campaign.delay_max_sec || 120) * 1000;
        const delay = minDelay + Math.random() * (maxDelay - minDelay);
        await new Promise(r => setTimeout(r, delay));

        // Cooldown after every 20 sends in session
        if (sessionSentCount > 0 && sessionSentCount % 20 === 0) {
          const cooldown = 15 * 60 * 1000 + Math.random() * 15 * 60 * 1000; // 15-30 min
          console.log(`[DMEngine] Cooldown ${Math.round(cooldown / 60000)}min after ${sessionSentCount} sends`);
          await new Promise(r => setTimeout(r, cooldown));
        }
      }

      // Check if all items processed
      const remaining = db.prepare(
        `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND execute_status = 'pending'`
      ).get(campaignId) as any;

      if (remaining.cnt === 0) {
        db.prepare('UPDATE dm_campaigns SET status = ?, updated_at = ? WHERE id = ?')
          .run('completed', new Date().toISOString(), campaignId);
      }

      console.log(`[DMEngine] Campaign ${campaign.name}: ${sentCount} sent, ${remaining.cnt} remaining`);

    } finally {
      this.activeCampaigns.delete(campaignId);
    }
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

    if (campaign.platform) {
      conditions.push('platform = ?');
      params.push(campaign.platform);
    }
    if (campaign.target_country) {
      conditions.push('detected_country = ?');
      params.push(campaign.target_country);
    }
    if (campaign.target_tiers) {
      const tiers = JSON.parse(campaign.target_tiers);
      conditions.push(`scout_tier IN (${tiers.map(() => '?').join(',')})`);
      params.push(...tiers);
    }
    if (campaign.min_followers) {
      conditions.push('followers_count >= ?');
      params.push(campaign.min_followers);
    }
    if (campaign.max_followers) {
      conditions.push('followers_count <= ?');
      params.push(campaign.max_followers);
    }

    // Exclude already queued
    conditions.push(`influencer_key NOT IN (SELECT influencer_key FROM dm_action_queue WHERE campaign_id = ?)`);
    params.push(campaignId);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const influencers = db.prepare(
      `SELECT * FROM influencer_master ${where} ORDER BY followers_count DESC LIMIT 1000`
    ).all(...params) as any[];

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

    // Update campaign total_queued
    db.prepare('UPDATE dm_campaigns SET total_queued = total_queued + ?, updated_at = ? WHERE id = ?')
      .run(queued, now, campaignId);

    return queued;
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

  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  /** Get an available DM account */
  private getAvailableAccount(platform: string): any | null {
    // Lazy reset if new day
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `UPDATE dm_accounts SET daily_sent = 0, last_reset_date = ? WHERE platform = ? AND (last_reset_date IS NULL OR last_reset_date < ?)`
    ).run(today, platform, today);

    const account = db.prepare(
      `SELECT * FROM dm_accounts WHERE platform = ? AND status = 'active' AND daily_sent < daily_limit ORDER BY daily_sent ASC LIMIT 1`
    ).get(platform) as any;

    return account || null;
  }

  /** Send DM via Instagram Private API (mobile API emulation) */
  private async sendInstagramDM(account: any, recipientUsername: string, message: string): Promise<void> {
    const ApiClient = await getIgApi();
    const ig = new ApiClient();

    ig.state.generateDevice(account.username);

    // Load session from file if exists
    if (account.session_file) {
      try {
        const fs = await import('fs');
        const sessionData = JSON.parse(fs.readFileSync(account.session_file, 'utf-8'));
        await ig.state.deserialize(sessionData);
      } catch {
        console.warn(`[DMEngine] Failed to load session for @${account.username}, will need re-login`);
      }
    }

    // Ensure logged in
    try {
      await ig.account.currentUser();
    } catch {
      // Need to login - this requires username/password which we don't store
      // For now, session file must be valid
      throw new Error(`Session expired for @${account.username}, please re-authenticate`);
    }

    // Find user ID for recipient
    const userInfo = await ig.user.searchExact(recipientUsername);
    if (!userInfo) throw new Error(`User not found: @${recipientUsername}`);

    // Get or create thread
    const thread = ig.entity.directThread([userInfo.pk.toString()]);

    // Send message
    await thread.broadcastText(message);
  }

  /** Send DM via browser automation (fallback for non-Instagram platforms) */
  private async sendBrowserDM(_platform: string, _account: any, _recipientUsername: string, _message: string): Promise<void> {
    // Placeholder for Playwright-based DM sending
    // This would use StealthBrowser to:
    // 1. Navigate to recipient's profile
    // 2. Click message/DM button
    // 3. Type and send message
    throw new Error(`Browser DM not yet implemented for ${_platform}. Use Instagram for now.`);
  }
}

export const dmEngine = new DMEngine();
