import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Job, JobStatus, JobType, Platform, Post, InfluencerProfile } from '../../core/types.js';

const DB_DIR = join(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const db: InstanceType<typeof Database> = new Database(join(DB_DIR, 'scraper.db'));

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// ─── Schema ───

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    platform TEXT NOT NULL,
    query TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    max_results INTEGER NOT NULL DEFAULT 50,
    result_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    shortcode TEXT,
    url TEXT,
    caption TEXT,
    hashtags TEXT,
    mentions TEXT,
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    views_count INTEGER,
    media_type TEXT,
    media_urls TEXT,
    timestamp TEXT,
    owner_username TEXT,
    owner_id TEXT,
    owner_full_name TEXT,
    owner_profile_pic_url TEXT,
    PRIMARY KEY (id, job_id),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT,
    full_name TEXT,
    bio TEXT,
    profile_pic_url TEXT,
    followers_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    posts_count INTEGER DEFAULT 0,
    engagement_rate REAL,
    is_verified INTEGER DEFAULT 0,
    is_business_account INTEGER DEFAULT 0,
    is_private INTEGER DEFAULT 0,
    category TEXT,
    contact_email TEXT,
    external_url TEXT,
    scraped_at TEXT,
    PRIMARY KEY (id, job_id),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_posts_job_id ON posts(job_id);
  CREATE INDEX IF NOT EXISTS idx_profiles_job_id ON profiles(job_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

// ─── Master Tables (keyword targets, influencer master, DM system) ───

db.exec(`
  -- Table 1: keyword_targets (수집 지휘소)
  CREATE TABLE IF NOT EXISTS keyword_targets (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_id               TEXT NOT NULL UNIQUE,
    platform              TEXT NOT NULL,
    region                TEXT NOT NULL,
    keyword               TEXT NOT NULL,
    scraping_cycle_hours  INTEGER DEFAULT 72,
    last_post_timestamp   TEXT,
    last_scraped_at       TEXT,
    next_scrape_at        TEXT,
    total_extracted       INTEGER DEFAULT 0,
    max_results_per_run   INTEGER DEFAULT 200,
    is_active             INTEGER DEFAULT 1,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kt_platform ON keyword_targets(platform);
  CREATE INDEX IF NOT EXISTS idx_kt_next ON keyword_targets(next_scrape_at);

  -- Table 2: influencer_master (핵심 자산 금고)
  CREATE TABLE IF NOT EXISTS influencer_master (
    influencer_key    TEXT PRIMARY KEY,
    platform          TEXT NOT NULL,
    username          TEXT NOT NULL,
    full_name         TEXT,
    bio               TEXT,
    profile_pic_url   TEXT,
    followers_count   INTEGER DEFAULT 0,
    following_count   INTEGER DEFAULT 0,
    posts_count       INTEGER DEFAULT 0,
    engagement_rate   REAL,
    is_verified       INTEGER DEFAULT 0,
    is_business       INTEGER DEFAULT 0,
    is_private        INTEGER DEFAULT 0,
    category          TEXT,
    contact_email     TEXT,
    contact_phone     TEXT,
    external_url      TEXT,
    detected_country  TEXT,
    detected_language TEXT,
    geo_confidence    REAL DEFAULT 0,
    geo_source        TEXT,
    scout_tier        TEXT DEFAULT 'C',
    scout_tier_auto   TEXT DEFAULT 'C',
    scout_tier_manual TEXT,
    dm_status         TEXT DEFAULT 'pending',
    dm_last_sent_at   TEXT,
    dm_campaign_id    TEXT,
    source_pair_ids   TEXT,
    first_seen_at     TEXT NOT NULL,
    last_updated_at   TEXT NOT NULL,
    UNIQUE(platform, username)
  );
  CREATE INDEX IF NOT EXISTS idx_im_platform ON influencer_master(platform);
  CREATE INDEX IF NOT EXISTS idx_im_country ON influencer_master(detected_country);
  CREATE INDEX IF NOT EXISTS idx_im_tier ON influencer_master(scout_tier);
  CREATE INDEX IF NOT EXISTS idx_im_dm ON influencer_master(dm_status);

  -- Table 3: dm_campaigns
  CREATE TABLE IF NOT EXISTS dm_campaigns (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    brand             TEXT,
    platform          TEXT NOT NULL,
    target_country    TEXT,
    target_tiers      TEXT,
    min_followers     INTEGER,
    max_followers     INTEGER,
    message_template  TEXT NOT NULL,
    daily_limit       INTEGER DEFAULT 40,
    max_retries       INTEGER DEFAULT 2,
    delay_min_sec     INTEGER DEFAULT 45,
    delay_max_sec     INTEGER DEFAULT 120,
    status            TEXT DEFAULT 'draft',
    total_queued      INTEGER DEFAULT 0,
    total_sent        INTEGER DEFAULT 0,
    total_failed      INTEGER DEFAULT 0,
    total_replied     INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  -- Table 4: dm_action_queue
  CREATE TABLE IF NOT EXISTS dm_action_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    influencer_key    TEXT NOT NULL,
    campaign_id       TEXT NOT NULL,
    platform          TEXT NOT NULL,
    account_username  TEXT,
    message_rendered  TEXT NOT NULL,
    execute_status    TEXT DEFAULT 'pending',
    error_message     TEXT,
    scheduled_at      TEXT,
    executed_at       TEXT,
    retry_count       INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL,
    FOREIGN KEY (influencer_key) REFERENCES influencer_master(influencer_key),
    FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dmq_status ON dm_action_queue(execute_status);
  CREATE INDEX IF NOT EXISTS idx_dmq_campaign ON dm_action_queue(campaign_id);

  -- Table 5: dm_accounts
  CREATE TABLE IF NOT EXISTS dm_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT NOT NULL,
    username        TEXT NOT NULL,
    session_file    TEXT,
    daily_sent      INTEGER DEFAULT 0,
    daily_limit     INTEGER DEFAULT 40,
    last_sent_at    TEXT,
    last_reset_date TEXT,
    status          TEXT DEFAULT 'active',
    created_at      TEXT NOT NULL,
    UNIQUE(platform, username)
  );

  -- Table 6: comment_templates
  CREATE TABLE IF NOT EXISTS comment_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT NOT NULL,
    category        TEXT NOT NULL,
    template        TEXT NOT NULL,
    variables       TEXT DEFAULT '[]',
    is_active       INTEGER DEFAULT 1,
    usage_count     INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ct_platform ON comment_templates(platform);
  CREATE INDEX IF NOT EXISTS idx_ct_category ON comment_templates(category);

  -- Table 7: dm_engagement_log
  CREATE TABLE IF NOT EXISTS dm_engagement_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    influencer_key    TEXT NOT NULL,
    campaign_id       TEXT NOT NULL,
    account_username  TEXT NOT NULL,
    platform          TEXT NOT NULL,
    action            TEXT NOT NULL,
    status            TEXT DEFAULT 'pending',
    post_url          TEXT,
    comment_text      TEXT,
    template_id       INTEGER,
    executed_at       TEXT,
    error_message     TEXT,
    created_at        TEXT NOT NULL,
    FOREIGN KEY (influencer_key) REFERENCES influencer_master(influencer_key),
    FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id)
  );
  CREATE INDEX IF NOT EXISTS idx_del_campaign ON dm_engagement_log(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_del_influencer ON dm_engagement_log(influencer_key);

  -- Table 8: dm_rounds
  CREATE TABLE IF NOT EXISTS dm_rounds (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id       TEXT NOT NULL,
    account_username  TEXT NOT NULL,
    round_number      INTEGER NOT NULL DEFAULT 1,
    started_at        TEXT NOT NULL,
    completed_at      TEXT,
    target_count      INTEGER DEFAULT 0,
    sent_count        INTEGER DEFAULT 0,
    failed_count      INTEGER DEFAULT 0,
    engaged_count     INTEGER DEFAULT 0,
    FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dr_campaign ON dm_rounds(campaign_id);

  -- Table 9: scraping_cookies (persistent cookie storage for ephemeral filesystems)
  CREATE TABLE IF NOT EXISTS scraping_cookies (
    platform TEXT PRIMARY KEY,
    cookie_json TEXT NOT NULL,
    cookie_count INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  -- Table 10: proxy_settings (proxy URL storage)
  CREATE TABLE IF NOT EXISTS proxy_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT DEFAULT 'datacenter',
    provider TEXT DEFAULT 'custom',
    country TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Table 11: platform_dm_defaults (글로벌 발송주기 기본값)
  CREATE TABLE IF NOT EXISTS platform_dm_defaults (
    platform TEXT PRIMARY KEY,
    delay_min_sec INTEGER NOT NULL,
    delay_max_sec INTEGER NOT NULL,
    cooldown_after INTEGER NOT NULL DEFAULT 20,
    cooldown_min_sec INTEGER NOT NULL DEFAULT 900,
    cooldown_max_sec INTEGER NOT NULL DEFAULT 1800,
    account_switch_delay_sec INTEGER NOT NULL DEFAULT 5,
    daily_limit_default INTEGER NOT NULL DEFAULT 40,
    updated_at TEXT NOT NULL
  );
`);

// Seed platform_dm_defaults with recommended values
try {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM platform_dm_defaults').get() as any;
  if (existing.cnt === 0) {
    const now = new Date().toISOString();
    const seedStmt = db.prepare('INSERT INTO platform_dm_defaults (platform, delay_min_sec, delay_max_sec, cooldown_after, cooldown_min_sec, cooldown_max_sec, account_switch_delay_sec, daily_limit_default, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    seedStmt.run('instagram', 60, 180, 20, 900, 1800, 5, 40, now);
    seedStmt.run('twitter',   30,  90, 20, 600, 900,  5, 40, now);
    seedStmt.run('tiktok',    45, 120, 20, 900, 1800, 5, 30, now);
  }
} catch { /* table may already have data */ }

// ─── ALTER TABLE migrations (idempotent) ───

const alterMigrations = [
  // dm_accounts extensions
  `ALTER TABLE dm_accounts ADD COLUMN target_country TEXT`,
  `ALTER TABLE dm_accounts ADD COLUMN target_tiers TEXT`,
  `ALTER TABLE dm_accounts ADD COLUMN target_min_followers INTEGER`,
  `ALTER TABLE dm_accounts ADD COLUMN target_max_followers INTEGER`,
  `ALTER TABLE dm_accounts ADD COLUMN engage_before_dm INTEGER DEFAULT 0`,
  `ALTER TABLE dm_accounts ADD COLUMN comment_template_category TEXT`,
  // dm_accounts cookie management
  `ALTER TABLE dm_accounts ADD COLUMN cookie_status TEXT DEFAULT 'unknown'`,
  `ALTER TABLE dm_accounts ADD COLUMN cookie_last_checked_at TEXT`,
  `ALTER TABLE dm_accounts ADD COLUMN cookie_expires_at TEXT`,
  `ALTER TABLE dm_accounts ADD COLUMN cookie_file TEXT`,
  `ALTER TABLE dm_accounts ADD COLUMN proxy_config TEXT`,
  // dm_action_queue extensions
  `ALTER TABLE dm_action_queue ADD COLUMN round_id INTEGER`,
  `ALTER TABLE dm_action_queue ADD COLUMN engagement_status TEXT DEFAULT 'none'`,
  // keyword_targets extensions
  `ALTER TABLE keyword_targets ADD COLUMN group_key TEXT`,
  `ALTER TABLE keyword_targets ADD COLUMN scrape_until TEXT`,
  // dm_campaigns: campaign-level cookie & sender account
  `ALTER TABLE dm_campaigns ADD COLUMN sender_username TEXT`,
  `ALTER TABLE dm_campaigns ADD COLUMN cookie_json TEXT`,
  `ALTER TABLE dm_campaigns ADD COLUMN cookie_status TEXT DEFAULT 'unknown'`,
  `ALTER TABLE dm_campaigns ADD COLUMN cookie_last_checked_at TEXT`,
  `ALTER TABLE dm_campaigns ADD COLUMN cookie_expires_at TEXT`,
  // comment_templates: campaign association
  `ALTER TABLE comment_templates ADD COLUMN campaign_id TEXT`,
  // keyword_targets job tracking
  `ALTER TABLE keyword_targets ADD COLUMN last_job_id TEXT`,
  `ALTER TABLE keyword_targets ADD COLUMN last_job_status TEXT DEFAULT 'idle'`,
  `ALTER TABLE keyword_targets ADD COLUMN last_job_result TEXT`,
  // AI classification columns
  `ALTER TABLE influencer_master ADD COLUMN ai_is_influencer INTEGER`,
  `ALTER TABLE influencer_master ADD COLUMN ai_country TEXT`,
  `ALTER TABLE influencer_master ADD COLUMN ai_confidence REAL`,
  `ALTER TABLE influencer_master ADD COLUMN ai_reason TEXT`,
  `ALTER TABLE influencer_master ADD COLUMN ai_classified_at TEXT`,
  // dm_action_queue engagement detail columns
  `ALTER TABLE dm_action_queue ADD COLUMN liked_post_url TEXT`,
  `ALTER TABLE dm_action_queue ADD COLUMN comment_text TEXT`,
  `ALTER TABLE dm_action_queue ADD COLUMN commented_post_url TEXT`,
  // dm_accounts: store actual cookie JSON in DB (ephemeral filesystem safe)
  `ALTER TABLE dm_accounts ADD COLUMN cookie_json TEXT`,
  // dm_accounts: Twitter DM encrypted messages PIN (default 0000)
  `ALTER TABLE dm_accounts ADD COLUMN dm_pin TEXT DEFAULT '0000'`,
  // dm_action_queue: reply detection tracking
  `ALTER TABLE dm_action_queue ADD COLUMN reply_detected INTEGER DEFAULT 0`,
  `ALTER TABLE dm_action_queue ADD COLUMN reply_detected_at TEXT`,
  // dm_campaigns: keyword target auto-mapping (platform:region group key)
  `ALTER TABLE dm_campaigns ADD COLUMN linked_keyword_group TEXT`,
  // dm_action_queue: proxy IP tracking
  `ALTER TABLE dm_action_queue ADD COLUMN proxy_ip TEXT`,
  // platform_dm_defaults: scraping follower filter
  `ALTER TABLE platform_dm_defaults ADD COLUMN min_followers_scrape INTEGER DEFAULT 2000`,
  // jobs: enrichment stats (유효 프로필 수, 필터링, 중복 스킵)
  `ALTER TABLE jobs ADD COLUMN profiles_saved INTEGER DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN profiles_filtered INTEGER DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN profiles_skipped INTEGER DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN profiles_failed INTEGER DEFAULT 0`,
];

for (const sql of alterMigrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// ─── Jobs CRUD ───

const insertJobStmt = db.prepare(`
  INSERT INTO jobs (id, type, platform, query, status, max_results, result_count, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
`);

const updateJobStatusStmt = db.prepare(`
  UPDATE jobs SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ?, result_count = ?,
  profiles_saved = ?, profiles_filtered = ?, profiles_skipped = ?, profiles_failed = ?
  WHERE id = ?
`);

const getJobStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
const deleteJobStmt = db.prepare(`DELETE FROM jobs WHERE id = ?`);

export function createJob(job: Omit<Job, 'resultCount' | 'startedAt' | 'completedAt' | 'error'>): Job {
  insertJobStmt.run(job.id, job.type, job.platform, job.query, job.status, job.maxResults, job.createdAt);
  return { ...job, resultCount: 0 };
}

export function updateJobStatus(
  id: string,
  status: JobStatus,
  opts: { error?: string; resultCount?: number; profilesSaved?: number; profilesFiltered?: number; profilesSkipped?: number; profilesFailed?: number } = {}
): void {
  const now = new Date().toISOString();
  const startedAt = status === 'running' ? now : null;
  const completedAt = status === 'completed' || status === 'failed' ? now : null;
  const job = getJob(id);
  updateJobStatusStmt.run(
    status, startedAt, completedAt, opts.error || null,
    opts.resultCount ?? job?.resultCount ?? 0,
    opts.profilesSaved ?? (job as any)?.profilesSaved ?? 0,
    opts.profilesFiltered ?? (job as any)?.profilesFiltered ?? 0,
    opts.profilesSkipped ?? (job as any)?.profilesSkipped ?? 0,
    opts.profilesFailed ?? (job as any)?.profilesFailed ?? 0,
    id
  );
}

export function getJob(id: string): Job | undefined {
  const row = getJobStmt.get(id) as any;
  if (!row) return undefined;
  return rowToJob(row);
}

export function listJobs(limit = 50, offset = 0): { jobs: Job[]; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) as count FROM jobs`).get() as any).count;
  const rows = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as any[];
  return { jobs: rows.map(rowToJob), total };
}

export function deleteJob(id: string): void {
  deleteJobStmt.run(id);
}

/** Fix jobs stuck in 'running'/'pending' from a previous server crash */
export function recoverStuckJobs(): number {
  const result = db.prepare(
    `UPDATE jobs SET status = 'completed', completed_at = ? WHERE status IN ('running', 'pending') AND result_count > 0`
  ).run(new Date().toISOString());
  const failedResult = db.prepare(
    `UPDATE jobs SET status = 'failed', completed_at = ?, error = 'Server restarted' WHERE status IN ('running', 'pending') AND result_count = 0`
  ).run(new Date().toISOString());
  return (result.changes || 0) + (failedResult.changes || 0);
}

function rowToJob(row: any): any {
  return {
    id: row.id,
    type: row.type as JobType,
    platform: row.platform as Platform,
    query: row.query,
    status: row.status as JobStatus,
    maxResults: row.max_results,
    resultCount: row.result_count,
    error: row.error || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    profilesSaved: row.profiles_saved || 0,
    profilesFiltered: row.profiles_filtered || 0,
    profilesSkipped: row.profiles_skipped || 0,
    profilesFailed: row.profiles_failed || 0,
  };
}

// ─── Posts CRUD ───

const insertPostStmt = db.prepare(`
  INSERT OR REPLACE INTO posts (id, job_id, platform, shortcode, url, caption, hashtags, mentions,
    likes_count, comments_count, views_count, media_type, media_urls, timestamp,
    owner_username, owner_id, owner_full_name, owner_profile_pic_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertPost(jobId: string, post: Post): void {
  insertPostStmt.run(
    post.id, jobId, post.platform, post.shortcode || null, post.url, post.caption,
    JSON.stringify(post.hashtags), JSON.stringify(post.mentions),
    post.likesCount, post.commentsCount, post.viewsCount || null,
    post.mediaType, JSON.stringify(post.mediaUrls), post.timestamp,
    post.owner.username, post.owner.id, post.owner.fullName || null, post.owner.profilePicUrl || null
  );
}

export function getJobPosts(
  jobId: string,
  opts: { sortBy?: string; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}
): { posts: Post[]; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) as count FROM posts WHERE job_id = ?`).get(jobId) as any).count;
  const sortCol = opts.sortBy === 'likes' ? 'likes_count'
    : opts.sortBy === 'comments' ? 'comments_count'
    : opts.sortBy === 'views' ? 'views_count'
    : 'likes_count';
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;

  const rows = db.prepare(
    `SELECT * FROM posts WHERE job_id = ? ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`
  ).all(jobId, limit, offset) as any[];

  return { posts: rows.map(rowToPost), total };
}

function rowToPost(row: any): Post {
  return {
    id: row.id,
    platform: row.platform as Platform,
    shortcode: row.shortcode || undefined,
    url: row.url,
    caption: row.caption || '',
    hashtags: JSON.parse(row.hashtags || '[]'),
    mentions: JSON.parse(row.mentions || '[]'),
    likesCount: row.likes_count,
    commentsCount: row.comments_count,
    viewsCount: row.views_count || undefined,
    mediaType: row.media_type,
    mediaUrls: JSON.parse(row.media_urls || '[]'),
    timestamp: row.timestamp,
    owner: {
      username: row.owner_username,
      id: row.owner_id,
      fullName: row.owner_full_name || undefined,
      profilePicUrl: row.owner_profile_pic_url || undefined,
    },
  };
}

// ─── Profiles CRUD ───

const insertProfileStmt = db.prepare(`
  INSERT OR REPLACE INTO profiles (id, job_id, platform, username, full_name, bio, profile_pic_url,
    followers_count, following_count, posts_count, engagement_rate,
    is_verified, is_business_account, is_private, category, contact_email, external_url, scraped_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertProfile(jobId: string, profile: InfluencerProfile): void {
  insertProfileStmt.run(
    profile.id, jobId, profile.platform, profile.username, profile.fullName,
    profile.bio, profile.profilePicUrl, profile.followersCount, profile.followingCount,
    profile.postsCount, profile.engagementRate || null,
    profile.isVerified ? 1 : 0, profile.isBusinessAccount ? 1 : 0, profile.isPrivate ? 1 : 0,
    profile.category || null, profile.contactEmail || null, profile.externalUrl || null,
    profile.scrapedAt
  );
}

export function getJobProfiles(jobId: string): InfluencerProfile[] {
  const rows = db.prepare(`SELECT * FROM profiles WHERE job_id = ?`).all(jobId) as any[];
  return rows.map(row => ({
    platform: row.platform as Platform,
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    bio: row.bio,
    profilePicUrl: row.profile_pic_url,
    followersCount: row.followers_count,
    followingCount: row.following_count,
    postsCount: row.posts_count,
    engagementRate: row.engagement_rate || undefined,
    isVerified: !!row.is_verified,
    isBusinessAccount: !!row.is_business_account,
    isPrivate: !!row.is_private,
    category: row.category || undefined,
    contactEmail: row.contact_email || undefined,
    externalUrl: row.external_url || undefined,
    scrapedAt: row.scraped_at,
  }));
}

// ─── Cross-job profile deduplication ───

export function getExistingProfileUsernames(platform: string): Set<string> {
  // Only consider profiles that have been properly enriched (have actual follower data)
  const rows = db.prepare(
    `SELECT DISTINCT username FROM profiles WHERE platform = ? AND followers_count > 0`
  ).all(platform) as any[];
  return new Set(rows.map(r => r.username));
}

// ─── All profiles (cross-job, deduplicated) ───

export function getAllProfiles(opts: {
  platform?: string;
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  order?: 'asc' | 'desc';
} = {}): { profiles: any[]; total: number } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.platform) {
    conditions.push('p.platform = ?');
    params.push(opts.platform);
  }
  if (opts.search) {
    conditions.push('(p.username LIKE ? OR p.full_name LIKE ? OR p.bio LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Deduplicate: keep latest scraped_at per (platform, username)
  const dedup = `
    SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.platform, p.username ORDER BY p.scraped_at DESC) as rn
    FROM profiles p ${where}
  `;

  const totalSql = `SELECT COUNT(*) as count FROM (${dedup}) t WHERE t.rn = 1`;
  const total = (db.prepare(totalSql).get(...params) as any).count;

  const sortCol = opts.sortBy === 'followers' ? 'followers_count'
    : opts.sortBy === 'following' ? 'following_count'
    : opts.sortBy === 'posts' ? 'posts_count'
    : opts.sortBy === 'engagement' ? 'engagement_rate'
    : opts.sortBy === 'scraped' ? 'scraped_at'
    : 'followers_count';
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;

  const dataSql = `SELECT * FROM (${dedup}) t WHERE t.rn = 1 ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataSql).all(...params, limit, offset) as any[];

  return {
    profiles: rows.map(row => ({
      platform: row.platform,
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      bio: row.bio,
      profilePicUrl: row.profile_pic_url,
      followersCount: row.followers_count,
      followingCount: row.following_count,
      postsCount: row.posts_count,
      engagementRate: row.engagement_rate || undefined,
      isVerified: !!row.is_verified,
      isBusinessAccount: !!row.is_business_account,
      isPrivate: !!row.is_private,
      category: row.category || undefined,
      contactEmail: row.contact_email || undefined,
      externalUrl: row.external_url || undefined,
      scrapedAt: row.scraped_at,
    })),
    total,
  };
}

/** Get usernames from posts that have no profile entry yet */
export function getMissingProfileUsernames(platform: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT p.owner_username
    FROM posts p
    WHERE p.platform = ? AND p.owner_username IS NOT NULL
      AND p.owner_username NOT IN (SELECT DISTINCT username FROM profiles WHERE platform = ?)
    ORDER BY p.owner_username
  `).all(platform, platform) as any[];
  return rows.map(r => r.owner_username);
}

export function getProfileStats(): { platform: string; count: number }[] {
  const rows = db.prepare(`
    SELECT platform, COUNT(DISTINCT username) as count FROM profiles GROUP BY platform ORDER BY count DESC
  `).all() as any[];
  return rows.map(r => ({ platform: r.platform, count: r.count }));
}

// ─── Raw data access for export ───

export function getJobPostsRaw(jobId: string): any[] {
  return db.prepare(`SELECT * FROM posts WHERE job_id = ? ORDER BY likes_count DESC`).all(jobId) as any[];
}

// ─── Cookie DB Adapter ───
// Provides DB-first cookie storage for CookieManager (survives deploys/restarts)

import type { CookieDbAdapter } from '../../core/cookie-manager.js';

export const cookieDbAdapter: CookieDbAdapter = {
  getPlatformCookieJson(platform: string, userId?: string): string | null {
    if (userId) {
      // Try user-specific cookies first, then fall back to unscoped
      const row = db.prepare('SELECT cookie_json FROM scraping_cookies WHERE platform = ? AND user_id = ?').get(platform, userId) as any;
      if (row?.cookie_json) return row.cookie_json;
    }
    const row = db.prepare('SELECT cookie_json FROM scraping_cookies WHERE platform = ?').get(platform) as any;
    return row?.cookie_json || null;
  },

  savePlatformCookieJson(platform: string, json: string, count: number, userId?: string): void {
    if (userId) {
      db.prepare('UPDATE scraping_cookies SET cookie_json = ?, cookie_count = ?, updated_at = ?, user_id = ? WHERE platform = ?')
        .run(json, count, new Date().toISOString(), userId, platform);
      const changes = db.prepare('SELECT changes() as c').get() as any;
      if (!changes?.c) {
        db.prepare('INSERT INTO scraping_cookies (platform, cookie_json, cookie_count, updated_at, user_id) VALUES (?, ?, ?, ?, ?)')
          .run(platform, json, count, new Date().toISOString(), userId);
      }
    } else {
      db.prepare('INSERT OR REPLACE INTO scraping_cookies (platform, cookie_json, cookie_count, updated_at) VALUES (?, ?, ?, ?)')
        .run(platform, json, count, new Date().toISOString());
    }
  },

  getAccountCookieJson(platform: string, username: string): string | null {
    const row = db.prepare('SELECT cookie_json FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, username) as any;
    return row?.cookie_json || null;
  },

  saveAccountCookieJson(platform: string, username: string, json: string, count: number): void {
    // Ensure the account row exists
    const exists = db.prepare('SELECT id FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, username) as any;
    if (exists) {
      db.prepare('UPDATE dm_accounts SET cookie_json = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE platform = ? AND username = ?')
        .run(json, 'valid', new Date().toISOString(), platform, username);
    } else {
      db.prepare(`INSERT INTO dm_accounts (platform, username, cookie_json, cookie_status, cookie_last_checked_at, daily_sent, daily_limit, status, created_at)
                  VALUES (?, ?, ?, 'valid', ?, 0, 40, 'active', ?)`)
        .run(platform, username, json, new Date().toISOString(), new Date().toISOString());
    }
  },

  hasAccountCookie(platform: string, username: string): boolean {
    const row = db.prepare('SELECT cookie_json FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, username) as any;
    return !!(row?.cookie_json);
  },
};

// ─── One-time Cookie Migration: filesystem → DB ───
// Migrates existing filesystem cookies into DB on first boot after upgrade.

import { existsSync, readFileSync, readdirSync } from 'fs';

export function migrateCookiesFromFilesystemToDB(): number {
  let migrated = 0;
  const cookieDir = join(process.cwd(), 'cookies');

  // 1. Migrate platform-level scraping cookies (cookies/{platform}.json)
  const platforms = ['instagram', 'twitter', 'tiktok', 'youtube', 'xiaohongshu', 'linkedin'];
  for (const platform of platforms) {
    // Skip if already in DB
    const existing = db.prepare('SELECT cookie_json FROM scraping_cookies WHERE platform = ?').get(platform) as any;
    if (existing?.cookie_json) continue;

    const filePath = join(cookieDir, `${platform}.json`);
    if (existsSync(filePath)) {
      try {
        const json = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(json);
        const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
        if (count > 0) {
          db.prepare('INSERT OR REPLACE INTO scraping_cookies (platform, cookie_json, cookie_count, updated_at) VALUES (?, ?, ?, ?)')
            .run(platform, json, count, new Date().toISOString());
          migrated++;
          console.log(`[CookieMigration] Migrated ${platform} scraping cookies (${count} entries) from filesystem to DB`);
        }
      } catch { /* skip invalid files */ }
    }
  }

  // 2. Migrate per-account DM cookies (cookies/{platform}/{username}.json)
  const accounts = db.prepare('SELECT id, platform, username, cookie_json FROM dm_accounts WHERE cookie_json IS NULL').all() as any[];
  for (const acc of accounts) {
    // Try cookie_file field first, then standard path
    const filePath = join(cookieDir, acc.platform, `${acc.username}.json`);
    if (existsSync(filePath)) {
      try {
        const json = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(json);
        const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
        if (count > 0) {
          db.prepare('UPDATE dm_accounts SET cookie_json = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?')
            .run(json, 'valid', new Date().toISOString(), acc.id);
          migrated++;
          console.log(`[CookieMigration] Migrated ${acc.platform}/@${acc.username} DM cookies (${count} entries) from filesystem to DB`);
        }
      } catch { /* skip invalid files */ }
    }
  }

  return migrated;
}

export { db };
