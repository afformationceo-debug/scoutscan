import { db } from '../web/services/db.js';
import type { Platform } from '../core/types.js';
import { BrowserContextPool } from './browser-context-pool.js';
import { browserLike, browserComment } from './dm-platforms/browser-engagement.js';

export class EngagementEngine {
  private pool: BrowserContextPool;

  constructor(pool: BrowserContextPool) {
    this.pool = pool;
  }

  /** Like a post on any platform via browser automation */
  async likePost(platform: Platform, accountUsername: string, postUrl: string): Promise<void> {
    console.log(`[Engagement] Liking post ${postUrl} via @${accountUsername} on ${platform}`);
    await browserLike(this.pool, platform, accountUsername, postUrl);
  }

  /** Comment on a post via browser automation */
  async commentOnPost(platform: Platform, accountUsername: string, postUrl: string, comment: string): Promise<void> {
    console.log(`[Engagement] Commenting on ${postUrl} via @${accountUsername}: "${comment.slice(0, 50)}..."`);
    await browserComment(this.pool, platform, accountUsername, postUrl, comment);
  }

  /** Full engagement flow: like recent post + comment */
  async engageWithInfluencer(
    platform: Platform,
    accountUsername: string,
    influencerKey: string,
    campaignId: string,
    options: { like?: boolean; comment?: boolean; commentCategory?: string } = {}
  ): Promise<{ liked: boolean; commented: boolean; likedPostUrl?: string; commentText?: string; commentedPostUrl?: string }> {
    const result: { liked: boolean; commented: boolean; likedPostUrl?: string; commentText?: string; commentedPostUrl?: string } = { liked: false, commented: false };
    const now = new Date().toISOString();

    // Find a recent post from this influencer
    const influencer = db.prepare(
      'SELECT * FROM influencer_master WHERE influencer_key = ?'
    ).get(influencerKey) as any;

    if (!influencer) {
      console.warn(`[Engagement] Influencer not found: ${influencerKey}`);
      return result;
    }

    // Get a real recent post URL from the posts table
    const postUrl = this.getRecentPostUrl(platform, influencer.username)
      || this.getProfileUrl(platform, influencer.username);

    if (options.like !== false) {
      try {
        this.logEngagement(influencerKey, campaignId, accountUsername, platform, 'like', postUrl, null, null, now);
        await this.likePost(platform, accountUsername, postUrl);
        this.updateEngagementStatus(influencerKey, campaignId, 'like', 'success');
        result.liked = true;
        result.likedPostUrl = postUrl;
      } catch (err) {
        this.updateEngagementStatus(influencerKey, campaignId, 'like', 'failed', (err as Error).message);
      }
    }

    if (options.comment) {
      try {
        const comment = this.getRandomComment(platform, options.commentCategory);
        if (comment) {
          const rendered = this.renderComment(comment.template, influencer);
          this.logEngagement(influencerKey, campaignId, accountUsername, platform, 'comment', postUrl, rendered, comment.id, now);
          await this.commentOnPost(platform, accountUsername, postUrl, rendered);
          this.updateEngagementStatus(influencerKey, campaignId, 'comment', 'success');
          this.incrementTemplateUsage(comment.id);
          result.commented = true;
          result.commentText = rendered;
          result.commentedPostUrl = postUrl;
        }
      } catch (err) {
        this.updateEngagementStatus(influencerKey, campaignId, 'comment', 'failed', (err as Error).message);
      }
    }

    return result;
  }

  /** Get a real recent post URL for an influencer from the posts DB */
  private getRecentPostUrl(platform: Platform, username: string): string | null {
    const row = db.prepare(`
      SELECT url, shortcode FROM posts
      WHERE owner_username = ? AND platform = ? AND url IS NOT NULL
      ORDER BY likes_count DESC
      LIMIT 1
    `).get(username, platform) as any;

    if (row?.url) return row.url;
    if (row?.shortcode && platform === 'instagram') return `https://www.instagram.com/p/${row.shortcode}/`;
    return null;
  }

  private getProfileUrl(platform: Platform, username: string): string {
    switch (platform) {
      case 'instagram': return `https://www.instagram.com/${username}/`;
      case 'twitter': return `https://twitter.com/${username}`;
      case 'tiktok': return `https://www.tiktok.com/@${username}`;
      default: return `https://${platform}.com/${username}`;
    }
  }

  private getRandomComment(platform: Platform, category?: string): any | null {
    const conditions = ['is_active = 1'];
    const params: any[] = [];

    if (platform) { conditions.push('platform = ?'); params.push(platform); }
    if (category) { conditions.push('category = ?'); params.push(category); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Weighted selection: less-used templates have higher chance of being picked.
    // Weight = 1 / (usage_count + 1), then use cumulative random selection via SQL.
    return db.prepare(
      `SELECT * FROM comment_templates ${where} ORDER BY (CAST(usage_count AS REAL) + 1) ASC, RANDOM() LIMIT 1`
    ).get(...params) as any || null;
  }

  private renderComment(template: string, influencer: any): string {
    return template
      .replace(/\{\{username\}\}/g, influencer.username || '')
      .replace(/\{\{full_name\}\}/g, influencer.full_name || influencer.username || '');
  }

  private logEngagement(
    influencerKey: string, campaignId: string, accountUsername: string,
    platform: Platform, action: string, postUrl: string | null,
    commentText: string | null, templateId: number | null, now: string
  ): void {
    db.prepare(`
      INSERT INTO dm_engagement_log (influencer_key, campaign_id, account_username, platform, action, status, post_url, comment_text, template_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(influencerKey, campaignId, accountUsername, platform, action, postUrl, commentText, templateId, now);
  }

  private updateEngagementStatus(influencerKey: string, campaignId: string, action: string, status: string, errorMessage?: string): void {
    db.prepare(`
      UPDATE dm_engagement_log SET status = ?, executed_at = ?, error_message = ?
      WHERE influencer_key = ? AND campaign_id = ? AND action = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).run(status, new Date().toISOString(), errorMessage || null, influencerKey, campaignId, action);
  }

  private incrementTemplateUsage(templateId: number): void {
    db.prepare('UPDATE comment_templates SET usage_count = usage_count + 1 WHERE id = ?').run(templateId);
  }
}
