import { db } from './db.js';
import { existsSync } from 'fs';
import { join } from 'path';
import type { InfluencerProfile, KeywordTarget, DMCampaign, DMAccount } from '../../core/types.js';

// ─── Scout Tier Calculation ───

function calculateScoutTier(followers: number, engagementRate: number | null): string {
  const er = engagementRate ?? 0;
  if (followers >= 100000 && er >= 3.0) return 'S';
  if (followers >= 10000 && er >= 2.0) return 'A';
  if (followers >= 1000 && er >= 1.0) return 'B';
  return 'C';
}

// ─── influencer_master UPSERT ───

const upsertInfluencerStmt = db.prepare(`
  INSERT INTO influencer_master (
    influencer_key, platform, username, full_name, bio, profile_pic_url,
    followers_count, following_count, posts_count, engagement_rate,
    is_verified, is_business, is_private, category, contact_email, contact_phone, external_url,
    scout_tier_auto, scout_tier, source_pair_ids,
    first_seen_at, last_updated_at
  ) VALUES (
    @influencerKey, @platform, @username, @fullName, @bio, @profilePicUrl,
    @followersCount, @followingCount, @postsCount, @engagementRate,
    @isVerified, @isBusiness, @isPrivate, @category, @contactEmail, @contactPhone, @externalUrl,
    @scoutTierAuto, @scoutTier, @sourcePairIds,
    @now, @now
  )
  ON CONFLICT(platform, username) DO UPDATE SET
    full_name = excluded.full_name,
    bio = excluded.bio,
    profile_pic_url = excluded.profile_pic_url,
    followers_count = excluded.followers_count,
    following_count = excluded.following_count,
    posts_count = excluded.posts_count,
    engagement_rate = excluded.engagement_rate,
    is_verified = excluded.is_verified,
    is_business = excluded.is_business,
    is_private = excluded.is_private,
    category = excluded.category,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    external_url = excluded.external_url,
    scout_tier_auto = excluded.scout_tier_auto,
    scout_tier = COALESCE(influencer_master.scout_tier_manual, excluded.scout_tier_auto),
    source_pair_ids = excluded.source_pair_ids,
    last_updated_at = excluded.last_updated_at
`);

export function upsertInfluencer(profile: InfluencerProfile, pairId?: string): void {
  const scoutTierAuto = calculateScoutTier(profile.followersCount, profile.engagementRate ?? null);
  const now = new Date().toISOString();

  // For source_pair_ids merge: read existing, append, deduplicate
  let sourcePairIds: string[] = [];
  if (pairId) {
    const existing = db.prepare(
      `SELECT source_pair_ids FROM influencer_master WHERE platform = ? AND username = ?`
    ).get(profile.platform, profile.username) as { source_pair_ids: string | null } | undefined;

    if (existing?.source_pair_ids) {
      try { sourcePairIds = JSON.parse(existing.source_pair_ids); } catch { /* ignore parse errors */ }
    }
    if (!sourcePairIds.includes(pairId)) {
      sourcePairIds.push(pairId);
    }
  }

  upsertInfluencerStmt.run({
    influencerKey: `${profile.platform}:${profile.username}`,
    platform: profile.platform,
    username: profile.username,
    fullName: profile.fullName || null,
    bio: profile.bio || null,
    profilePicUrl: profile.profilePicUrl || null,
    followersCount: profile.followersCount,
    followingCount: profile.followingCount,
    postsCount: profile.postsCount,
    engagementRate: profile.engagementRate || null,
    isVerified: profile.isVerified ? 1 : 0,
    isBusiness: profile.isBusinessAccount ? 1 : 0,
    isPrivate: profile.isPrivate ? 1 : 0,
    category: profile.category || null,
    contactEmail: profile.contactEmail || null,
    contactPhone: profile.contactPhone || null,
    externalUrl: profile.externalUrl || null,
    scoutTierAuto: scoutTierAuto,
    scoutTier: scoutTierAuto,
    sourcePairIds: sourcePairIds.length > 0 ? JSON.stringify(sourcePairIds) : null,
    now,
  });
}

// ─── influencer_master queries ───

export function getInfluencers(opts: {
  platform?: string;
  country?: string;
  tier?: string;
  dmStatus?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
} = {}): { influencers: any[]; total: number } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.platform) { conditions.push('platform = ?'); params.push(opts.platform); }
  if (opts.country) {
    // Use AI country if available, fall back to geo-detected
    conditions.push('UPPER(COALESCE(ai_country, detected_country)) = UPPER(?)');
    params.push(opts.country);
  }
  if (opts.tier) { conditions.push('scout_tier = ?'); params.push(opts.tier); }
  if (opts.dmStatus) { conditions.push('dm_status = ?'); params.push(opts.dmStatus); }
  if ((opts as any).aiType === 'influencer') { conditions.push('ai_is_influencer = 1'); }
  if ((opts as any).aiType === 'business') { conditions.push('ai_is_influencer = 0 AND ai_classified_at IS NOT NULL'); }
  if (opts.search) {
    conditions.push('(username LIKE ? OR full_name LIKE ? OR bio LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as count FROM influencer_master ${where}`).get(...params) as any).count;

  const sortCol = opts.sortBy === 'followers' ? 'followers_count'
    : opts.sortBy === 'engagement' ? 'engagement_rate'
    : opts.sortBy === 'tier' ? 'scout_tier'
    : opts.sortBy === 'country' ? 'detected_country'
    : opts.sortBy === 'updated' ? 'last_updated_at'
    : 'followers_count';
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;

  const rows = db.prepare(
    `SELECT * FROM influencer_master ${where} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];

  return { influencers: rows, total };
}

export function getInfluencerStats(): { total: number; byCountry: Record<string, number>; byTier: Record<string, number> } {
  const total = (db.prepare(`SELECT COUNT(*) as count FROM influencer_master`).get() as any).count;

  const countryRows = db.prepare(
    `SELECT detected_country, COUNT(*) as count FROM influencer_master WHERE detected_country IS NOT NULL GROUP BY detected_country ORDER BY count DESC`
  ).all() as any[];
  const byCountry: Record<string, number> = {};
  for (const r of countryRows) byCountry[r.detected_country] = r.count;

  const tierRows = db.prepare(
    `SELECT scout_tier, COUNT(*) as count FROM influencer_master GROUP BY scout_tier ORDER BY scout_tier`
  ).all() as any[];
  const byTier: Record<string, number> = {};
  for (const r of tierRows) byTier[r.scout_tier] = r.count;

  return { total, byCountry, byTier };
}

// ─── Migrate existing profiles → influencer_master ───

export function migrateProfilesToMaster(): number {
  const rows = db.prepare(`
    SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.platform, p.username ORDER BY p.scraped_at DESC) as rn
    FROM profiles p
  `).all() as any[];

  let migrated = 0;
  for (const row of rows) {
    if (row.rn !== 1) continue;
    if (!row.username) continue;

    const profile: InfluencerProfile = {
      platform: row.platform,
      id: row.id,
      username: row.username,
      fullName: row.full_name || '',
      bio: row.bio || '',
      profilePicUrl: row.profile_pic_url || '',
      followersCount: row.followers_count || 0,
      followingCount: row.following_count || 0,
      postsCount: row.posts_count || 0,
      engagementRate: row.engagement_rate || undefined,
      isVerified: !!row.is_verified,
      isBusinessAccount: !!row.is_business_account,
      isPrivate: !!row.is_private,
      category: row.category || undefined,
      contactEmail: row.contact_email || undefined,
      externalUrl: row.external_url || undefined,
      scrapedAt: row.scraped_at,
    };

    upsertInfluencer(profile);
    migrated++;
  }

  return migrated;
}

// ─── Geo update ───

export function updateInfluencerGeo(platform: string, username: string, geo: { country: string; language: string; confidence: number; source: string }): void {
  db.prepare(`
    UPDATE influencer_master SET
      detected_country = ?,
      detected_language = ?,
      geo_confidence = ?,
      geo_source = ?,
      last_updated_at = ?
    WHERE platform = ? AND username = ?
  `).run(
    geo.confidence >= 0.4 ? geo.country : 'UNKNOWN',
    geo.language,
    geo.confidence,
    geo.source,
    new Date().toISOString(),
    platform, username
  );
}

// ─── keyword_targets CRUD ───

export function createKeywordTarget(target: {
  pairId: string; platform: string; region: string; keyword: string;
  scrapingCycleHours?: number; maxResultsPerRun?: number; isActive?: boolean; nextScrapeAt?: string;
  groupKey?: string; scrapeUntil?: string;
}): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO keyword_targets (pair_id, platform, region, keyword, scraping_cycle_hours, max_results_per_run, is_active, next_scrape_at, group_key, scrape_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    target.pairId, target.platform, target.region, target.keyword,
    target.scrapingCycleHours ?? 72, target.maxResultsPerRun ?? 200,
    target.isActive !== false ? 1 : 0,
    target.nextScrapeAt || now, target.groupKey || null, target.scrapeUntil || null, now, now
  );
  return result.lastInsertRowid as number;
}

export function listKeywordTargets(): KeywordTarget[] {
  const rows = db.prepare(`SELECT * FROM keyword_targets ORDER BY platform, region`).all() as any[];
  return rows.map(rowToKeywordTarget);
}

export function getKeywordTarget(pairId: string): KeywordTarget | undefined {
  const row = db.prepare(`SELECT * FROM keyword_targets WHERE pair_id = ?`).get(pairId) as any;
  return row ? rowToKeywordTarget(row) : undefined;
}

export function updateKeywordTarget(id: number, updates: Partial<KeywordTarget>): void {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.scrapingCycleHours !== undefined) { fields.push('scraping_cycle_hours = ?'); params.push(updates.scrapingCycleHours); }
  if (updates.maxResultsPerRun !== undefined) { fields.push('max_results_per_run = ?'); params.push(updates.maxResultsPerRun); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); params.push(updates.isActive ? 1 : 0); }
  if (updates.nextScrapeAt !== undefined) { fields.push('next_scrape_at = ?'); params.push(updates.nextScrapeAt); }
  if (updates.lastScrapedAt !== undefined) { fields.push('last_scraped_at = ?'); params.push(updates.lastScrapedAt); }
  if (updates.lastPostTimestamp !== undefined) { fields.push('last_post_timestamp = ?'); params.push(updates.lastPostTimestamp); }
  if (updates.totalExtracted !== undefined) { fields.push('total_extracted = ?'); params.push(updates.totalExtracted); }
  if (updates.scrapeUntil !== undefined) { fields.push('scrape_until = ?'); params.push(updates.scrapeUntil || null); }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE keyword_targets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteKeywordTarget(id: number): void {
  db.prepare(`DELETE FROM keyword_targets WHERE id = ?`).run(id);
}

function rowToKeywordTarget(row: any): KeywordTarget {
  return {
    id: row.id,
    pairId: row.pair_id,
    platform: row.platform,
    region: row.region,
    keyword: row.keyword,
    scrapingCycleHours: row.scraping_cycle_hours,
    lastPostTimestamp: row.last_post_timestamp || undefined,
    lastScrapedAt: row.last_scraped_at || undefined,
    nextScrapeAt: row.next_scrape_at || undefined,
    totalExtracted: row.total_extracted,
    maxResultsPerRun: row.max_results_per_run,
    isActive: !!row.is_active,
    groupKey: row.group_key || undefined,
    scrapeUntil: row.scrape_until || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── dm_campaigns CRUD ───

export function createCampaign(campaign: {
  id: string; name: string; brand?: string; platform: string;
  targetCountry?: string; targetTiers?: string[];
  minFollowers?: number; maxFollowers?: number;
  messageTemplate: string; dailyLimit?: number; maxRetries?: number;
  delayMinSec?: number; delayMaxSec?: number; status?: string;
  senderUsername?: string; cookieJson?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO dm_campaigns (id, name, brand, platform, target_country, target_tiers,
      min_followers, max_followers, message_template, daily_limit, max_retries,
      delay_min_sec, delay_max_sec, status, sender_username, cookie_json, cookie_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    campaign.id, campaign.name, campaign.brand || null, campaign.platform,
    campaign.targetCountry || null,
    campaign.targetTiers ? JSON.stringify(campaign.targetTiers) : null,
    campaign.minFollowers || null, campaign.maxFollowers || null,
    campaign.messageTemplate, campaign.dailyLimit ?? 40, campaign.maxRetries ?? 2,
    campaign.delayMinSec ?? 45, campaign.delayMaxSec ?? 120,
    campaign.status || 'draft',
    campaign.senderUsername || null, campaign.cookieJson || null,
    campaign.cookieJson ? 'unknown' : 'unknown',
    now, now
  );
}

export function listCampaigns(limit?: number, offset?: number): any[] {
  let sql = `SELECT * FROM dm_campaigns ORDER BY created_at DESC`;
  if (limit && limit > 0) {
    sql += ` LIMIT ${limit} OFFSET ${offset || 0}`;
  }
  const rows = db.prepare(sql).all() as any[];
  const cookieDir = join(process.cwd(), 'cookies');
  return rows.map(r => {
    // Check cookie availability: DB cookie_json OR per-account cookie file
    let hasCookie = !!r.cookie_json;
    if (!hasCookie && r.sender_username && r.platform) {
      const accountCookiePath = join(cookieDir, r.platform, `${r.sender_username}.json`);
      hasCookie = existsSync(accountCookiePath);
    }
    // Also check platform-level cookie file
    if (!hasCookie && r.platform) {
      const platformCookiePath = join(cookieDir, `${r.platform}.json`);
      hasCookie = existsSync(platformCookiePath);
    }
    return {
      ...r,
      target_tiers: r.target_tiers ? JSON.parse(r.target_tiers) : undefined,
      cookie_json: undefined,
      has_cookie: hasCookie,
      cookie_status: hasCookie ? (r.cookie_status || 'valid') : 'unknown',
    };
  });
}

export function getCampaign(id: string): any {
  const row = db.prepare(`SELECT * FROM dm_campaigns WHERE id = ?`).get(id) as any;
  if (!row) return undefined;
  const cookieDir = join(process.cwd(), 'cookies');
  let hasCookie = !!row.cookie_json;
  if (!hasCookie && row.sender_username && row.platform) {
    hasCookie = existsSync(join(cookieDir, row.platform, `${row.sender_username}.json`));
  }
  if (!hasCookie && row.platform) {
    hasCookie = existsSync(join(cookieDir, `${row.platform}.json`));
  }
  return {
    ...row,
    target_tiers: row.target_tiers ? JSON.parse(row.target_tiers) : undefined,
    has_cookie: hasCookie,
    cookie_status: hasCookie ? (row.cookie_status || 'valid') : 'unknown',
  };
}

export function getCampaignCookieJson(id: string): string | null {
  const row = db.prepare(`SELECT cookie_json FROM dm_campaigns WHERE id = ?`).get(id) as any;
  return row?.cookie_json || null;
}

export function updateCampaignCookie(id: string, cookieJson: string, status: string, expiresAt?: string): void {
  db.prepare(`
    UPDATE dm_campaigns SET cookie_json = ?, cookie_status = ?, cookie_last_checked_at = ?, cookie_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(cookieJson, status, new Date().toISOString(), expiresAt || null, new Date().toISOString(), id);
}

export function getCampaignTargets(campaignId: string, opts: { limit?: number; offset?: number } = {}): { targets: any[]; total: number } {
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;
  const total = (db.prepare(`SELECT COUNT(*) as count FROM dm_action_queue WHERE campaign_id = ?`).get(campaignId) as any).count;
  const rows = db.prepare(`
    SELECT q.id, q.influencer_key, q.campaign_id, q.platform, q.account_username, q.message_rendered,
           q.execute_status, q.error_message, q.scheduled_at, q.executed_at, q.retry_count, q.created_at,
           q.round_id, q.engagement_status, q.liked_post_url, q.comment_text, q.commented_post_url,
           m.full_name, m.followers_count, m.engagement_rate, m.detected_country, m.scout_tier, m.profile_pic_url, m.bio, m.username as influencer_username, m.platform as influencer_platform
    FROM dm_action_queue q
    LEFT JOIN influencer_master m ON q.influencer_key = m.influencer_key
    WHERE q.campaign_id = ?
    ORDER BY q.created_at DESC
    LIMIT ? OFFSET ?
  `).all(campaignId, limit, offset) as any[];
  return { targets: rows, total };
}

// ─── dm_accounts CRUD ───

export function addDMAccount(platform: string, username: string, sessionFile?: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO dm_accounts (platform, username, session_file, created_at)
    VALUES (?, ?, ?, ?)
  `).run(platform, username, sessionFile || null, new Date().toISOString());
}

export function listDMAccounts(platform?: string): DMAccount[] {
  const sql = platform
    ? `SELECT * FROM dm_accounts WHERE platform = ? ORDER BY username`
    : `SELECT * FROM dm_accounts ORDER BY platform, username`;
  return (platform ? db.prepare(sql).all(platform) : db.prepare(sql).all()) as any[];
}

export function resetDailyLimits(): number {
  const today = new Date().toISOString().slice(0, 10);
  const result = db.prepare(
    `UPDATE dm_accounts SET daily_sent = 0, last_reset_date = ? WHERE last_reset_date IS NULL OR last_reset_date < ?`
  ).run(today, today);
  return result.changes || 0;
}

// ─── Comment Templates CRUD ───

export function createCommentTemplate(tmpl: { platform: string; category: string; template: string; variables?: string[]; campaignId?: string }): number {
  const result = db.prepare(`
    INSERT INTO comment_templates (platform, category, template, variables, campaign_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tmpl.platform, tmpl.category, tmpl.template, JSON.stringify(tmpl.variables || []), tmpl.campaignId || null, new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function listCommentTemplates(platform?: string, category?: string): any[] {
  const conditions: string[] = [];
  const params: any[] = [];
  if (platform) { conditions.push('ct.platform = ?'); params.push(platform); }
  if (category) { conditions.push('ct.category = ?'); params.push(category); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT ct.*, dc.name as campaign_name
    FROM comment_templates ct
    LEFT JOIN dm_campaigns dc ON ct.campaign_id = dc.id
    ${where}
    ORDER BY ct.category, ct.id
  `).all(...params) as any[];
}

export function updateCommentTemplate(id: number, updates: { platform?: string; category?: string; template?: string; variables?: string[]; campaignId?: string }): void {
  const fields: string[] = [];
  const params: any[] = [];
  if (updates.platform) { fields.push('platform = ?'); params.push(updates.platform); }
  if (updates.category) { fields.push('category = ?'); params.push(updates.category); }
  if (updates.template) { fields.push('template = ?'); params.push(updates.template); }
  if (updates.variables) { fields.push('variables = ?'); params.push(JSON.stringify(updates.variables)); }
  if (updates.campaignId !== undefined) { fields.push('campaign_id = ?'); params.push(updates.campaignId || null); }
  if (fields.length > 0) {
    params.push(id);
    db.prepare(`UPDATE comment_templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
}

export function deleteCommentTemplate(id: number): void {
  db.prepare('DELETE FROM comment_templates WHERE id = ?').run(id);
}

// ─── Engagement Log queries ───

export function getEngagementLogs(campaignId: string, limit = 100): any[] {
  return db.prepare(
    `SELECT * FROM dm_engagement_log WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(campaignId, limit) as any[];
}

// ─── DM Rounds CRUD ───

export function createDMRound(campaignId: string, accountUsername: string, targetCount: number): number {
  const roundNumber = ((db.prepare(
    `SELECT MAX(round_number) as max_round FROM dm_rounds WHERE campaign_id = ? AND account_username = ?`
  ).get(campaignId, accountUsername) as any)?.max_round || 0) + 1;

  const result = db.prepare(`
    INSERT INTO dm_rounds (campaign_id, account_username, round_number, started_at, target_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(campaignId, accountUsername, roundNumber, new Date().toISOString(), targetCount);
  return result.lastInsertRowid as number;
}

export function completeDMRound(roundId: number, sentCount: number, failedCount: number, engagedCount: number): void {
  db.prepare(`
    UPDATE dm_rounds SET completed_at = ?, sent_count = ?, failed_count = ?, engaged_count = ? WHERE id = ?
  `).run(new Date().toISOString(), sentCount, failedCount, engagedCount, roundId);
}

export function getCampaignRounds(campaignId: string): any[] {
  return db.prepare(
    `SELECT * FROM dm_rounds WHERE campaign_id = ? ORDER BY round_number DESC`
  ).all(campaignId) as any[];
}

// ─── DM Account Extended update ───

export function updateDMAccount(id: number, updates: Record<string, any>): void {
  const fields: string[] = [];
  const params: any[] = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = ?`);
    params.push(typeof val === 'object' ? JSON.stringify(val) : val);
  }
  if (fields.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE dm_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}
