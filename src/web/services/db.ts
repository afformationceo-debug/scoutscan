import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { Job, JobStatus, JobType, Platform, Post, InfluencerProfile } from '../../core/types.js';

const DB_DIR = join(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(join(DB_DIR, 'scraper.db'));

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

// ─── Jobs CRUD ───

const insertJobStmt = db.prepare(`
  INSERT INTO jobs (id, type, platform, query, status, max_results, result_count, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
`);

const updateJobStatusStmt = db.prepare(`
  UPDATE jobs SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ?, result_count = ?
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
  opts: { error?: string; resultCount?: number } = {}
): void {
  const now = new Date().toISOString();
  const startedAt = status === 'running' ? now : null;
  const completedAt = status === 'completed' || status === 'failed' ? now : null;
  const job = getJob(id);
  updateJobStatusStmt.run(status, startedAt, completedAt, opts.error || null, opts.resultCount ?? job?.resultCount ?? 0, id);
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

function rowToJob(row: any): Job {
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
  const rows = db.prepare(
    `SELECT DISTINCT username FROM profiles WHERE platform = ?`
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

export { db };
