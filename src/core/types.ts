export interface ProxyConfig {
  url: string;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface SessionData {
  id: string;
  cookies: Record<string, string>;
  userAgent: string;
  proxy?: ProxyConfig;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  isBlocked: boolean;
}

export interface ScrapingOptions {
  maxResults?: number;
  proxy?: ProxyConfig;
  delay?: { min: number; max: number };
  headless?: boolean;
  timeout?: number;
}

export interface SearchOptions extends ScrapingOptions {
  cursor?: string;
  sortBy?: 'recent' | 'top';
  since?: string;  // ISO timestamp for delta scraping
  until?: string;  // ISO timestamp - skip posts newer than this
}

export type Platform = 'instagram' | 'twitter' | 'tiktok' | 'youtube' | 'xiaohongshu' | 'linkedin';

export interface Post {
  id: string;
  platform: Platform;
  shortcode?: string;
  url: string;
  caption: string;
  hashtags: string[];
  mentions: string[];
  likesCount: number;
  commentsCount: number;
  viewsCount?: number;
  mediaType: 'image' | 'video' | 'carousel' | 'reel';
  mediaUrls: string[];
  timestamp: string;
  owner: {
    username: string;
    id: string;
    fullName?: string;
    profilePicUrl?: string;
  };
}

export interface InfluencerProfile {
  platform: Platform;
  id: string;
  username: string;
  fullName: string;
  bio: string;
  profilePicUrl: string;
  profilePicUrlHD?: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  engagementRate?: number;
  isVerified: boolean;
  isBusinessAccount: boolean;
  isPrivate: boolean;
  category?: string;
  contactEmail?: string;
  contactPhone?: string;
  externalUrl?: string;
  recentPosts?: Post[];
  scrapedAt: string;
}

export interface PlatformScraper {
  readonly platform: Platform;
  searchByHashtag(tag: string, options?: SearchOptions): AsyncGenerator<Post>;
  getProfile(username: string, options?: ScrapingOptions): Promise<InfluencerProfile>;
}

export interface HashtagInfo {
  name: string;
  postsCount: number;
  profilePicUrl?: string;
  topPosts: Post[];
}

// ─── Web Dashboard Types ───

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type JobType = 'hashtag' | 'profile';

export interface Job {
  id: string;
  type: JobType;
  platform: Platform;
  query: string; // hashtag or username
  status: JobStatus;
  maxResults: number;
  resultCount: number;
  error?: string;
  pairId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Master DB Types ───

export interface KeywordTarget {
  id: number;
  pairId: string;
  platform: Platform;
  region: string;
  keyword: string;
  scrapingCycleHours: number;
  lastPostTimestamp?: string;
  lastScrapedAt?: string;
  nextScrapeAt?: string;
  totalExtracted: number;
  maxResultsPerRun: number;
  isActive: boolean;
  scrapeUntil?: string; // ISO date string - only scrape posts up to this date
  groupKey?: string;
  lastJobId?: string;
  lastJobStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InfluencerMaster {
  influencerKey: string;
  platform: Platform;
  username: string;
  fullName?: string;
  bio?: string;
  profilePicUrl?: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  engagementRate?: number;
  isVerified: boolean;
  isBusiness: boolean;
  isPrivate: boolean;
  category?: string;
  contactEmail?: string;
  contactPhone?: string;
  externalUrl?: string;
  detectedCountry?: string;
  detectedLanguage?: string;
  geoConfidence: number;
  geoSource?: string;
  scoutTier: string;
  scoutTierAuto: string;
  scoutTierManual?: string;
  dmStatus: string;
  dmLastSentAt?: string;
  dmCampaignId?: string;
  sourcePairIds?: string[];
  firstSeenAt: string;
  lastUpdatedAt: string;
}

export interface DMCampaign {
  id: string;
  name: string;
  brand?: string;
  platform: Platform;
  targetCountry?: string;
  targetTiers?: string[];
  minFollowers?: number;
  maxFollowers?: number;
  messageTemplate: string;
  dailyLimit: number;
  maxRetries: number;
  delayMinSec: number;
  delayMaxSec: number;
  status: 'draft' | 'active' | 'paused' | 'completed';
  totalQueued: number;
  totalSent: number;
  totalFailed: number;
  totalReplied: number;
  createdAt: string;
  updatedAt: string;
}

export interface DMActionItem {
  id: number;
  influencerKey: string;
  campaignId: string;
  platform: Platform;
  accountUsername?: string;
  messageRendered: string;
  executeStatus: 'pending' | 'processing' | 'success' | 'failed' | 'skipped';
  errorMessage?: string;
  scheduledAt?: string;
  executedAt?: string;
  retryCount: number;
  createdAt: string;
}

export interface DMAccount {
  id: number;
  platform: Platform;
  username: string;
  sessionFile?: string;
  dailySent: number;
  dailyLimit: number;
  lastSentAt?: string;
  lastResetDate?: string;
  status: 'active' | 'paused' | 'blocked' | 'cookie_expired';
  cookieStatus?: 'valid' | 'expired' | 'unknown' | 'checking';
  cookieLastCheckedAt?: string;
  cookieExpiresAt?: string;
  cookieFile?: string;
  proxyConfig?: string;
  createdAt: string;
}

// ─── Extended DM Account with per-account targeting ───

export interface DMAccountExtended extends DMAccount {
  targetCountry?: string;
  targetTiers?: string[];
  targetMinFollowers?: number;
  targetMaxFollowers?: number;
  engageBeforeDm: boolean;
  commentTemplateCategory?: string;
}

// ─── Comment Templates ───

export interface CommentTemplate {
  id: number;
  platform: Platform;
  category: string;
  template: string;
  variables: string[];
  isActive: boolean;
  usageCount: number;
  createdAt: string;
}

// ─── Engagement Log ───

export interface EngagementLog {
  id: number;
  influencerKey: string;
  campaignId: string;
  accountUsername: string;
  platform: Platform;
  action: 'like' | 'comment' | 'follow';
  status: 'pending' | 'success' | 'failed';
  postUrl?: string;
  commentText?: string;
  templateId?: number;
  executedAt?: string;
  errorMessage?: string;
  createdAt: string;
}

// ─── DM Rounds ───

export interface DMRound {
  id: number;
  campaignId: string;
  accountUsername: string;
  roundNumber: number;
  startedAt: string;
  completedAt?: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  engagedCount: number;
}

// ─── Cookie Health ───

export interface CookieHealthStatus {
  platform: string;
  username: string;
  status: 'valid' | 'expired' | 'unknown' | 'checking';
  missingCookies: string[];
  expiresAt?: string;
  lastCheckedAt: string;
}

// ─── Keyword Target Group ───

export interface KeywordTargetGroup {
  groupKey: string; // "{region}:{keyword}"
  region: string;
  keyword: string;
  platforms: Platform[];
  targets: KeywordTarget[];
}
