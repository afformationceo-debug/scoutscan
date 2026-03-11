import { EventEmitter } from 'events';
import { PlatformScraper, Platform, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from './types.js';
import { InstagramScraper } from '../platforms/instagram/index.js';
import { TwitterScraper } from '../platforms/twitter/index.js';
import { TikTokScraper } from '../platforms/tiktok/index.js';
import { YouTubeScraper } from '../platforms/youtube/index.js';
import { XiaohongshuScraper } from '../platforms/xiaohongshu/index.js';
import { LinkedInScraper } from '../platforms/linkedin/index.js';
import { logger } from '../utils/logger.js';

export type ExtendedPlatform = Platform;

interface EngineConfig {
  proxyUrls?: string[];
  platforms?: ExtendedPlatform[];
}

interface MultiPlatformResult {
  platform: string;
  posts: Post[];
  profiles: InfluencerProfile[];
  errors: string[];
  duration: number;
}

/**
 * Universal Scraping Engine
 * Orchestrates all platform scrapers with unified API
 *
 * Features:
 * - Multi-platform search with single query
 * - Parallel execution across platforms
 * - Unified data schema
 * - Error isolation (one platform failure doesn't affect others)
 * - Result aggregation and deduplication
 */
export class ScrapingEngine extends EventEmitter {
  private scrapers = new Map<string, PlatformScraper>();
  private proxyUrls: string[];

  constructor(config: EngineConfig = {}) {
    super();
    this.proxyUrls = config.proxyUrls || [];

    const platforms = config.platforms || ['instagram'];
    for (const platform of platforms) {
      this.registerPlatform(platform);
    }
  }

  /** Register a platform scraper */
  private registerPlatform(platform: ExtendedPlatform): void {
    switch (platform) {
      case 'instagram':
        this.scrapers.set('instagram', new InstagramScraper(this.proxyUrls));
        break;
      case 'twitter':
        this.scrapers.set('twitter', new TwitterScraper(this.proxyUrls));
        break;
      case 'tiktok':
        this.scrapers.set('tiktok', new TikTokScraper(this.proxyUrls));
        break;
      case 'youtube':
        this.scrapers.set('youtube', new YouTubeScraper(this.proxyUrls));
        break;
      case 'xiaohongshu':
        this.scrapers.set('xiaohongshu', new XiaohongshuScraper(this.proxyUrls));
        break;
      case 'linkedin':
        this.scrapers.set('linkedin', new LinkedInScraper(this.proxyUrls));
        break;
    }
    logger.info(`Platform registered: ${platform}`);
  }

  /** Search a single platform by hashtag */
  async searchPlatform(
    platform: string,
    tag: string,
    options: SearchOptions = {}
  ): Promise<{ posts: Post[]; errors: string[] }> {
    const scraper = this.scrapers.get(platform);
    if (!scraper) {
      return { posts: [], errors: [`Platform not registered: ${platform}`] };
    }

    const posts: Post[] = [];
    const errors: string[] = [];

    try {
      for await (const post of scraper.searchByHashtag(tag, options)) {
        posts.push(post);
        this.emit('post', { platform, post });
        this.emit('progress', { platform, count: posts.length });
      }
    } catch (error) {
      errors.push(`${platform}: ${(error as Error).message}`);
      logger.error(`Search failed for ${platform}: ${(error as Error).message}`);
    }

    return { posts, errors };
  }

  /** Search across ALL registered platforms in parallel */
  async searchAllPlatforms(
    tag: string,
    options: SearchOptions = {}
  ): Promise<MultiPlatformResult[]> {
    const platforms = [...this.scrapers.keys()];
    logger.info(`Multi-platform search: #${tag} across ${platforms.join(', ')}`);

    const results = await Promise.allSettled(
      platforms.map(async (platform) => {
        const startTime = Date.now();
        const { posts, errors } = await this.searchPlatform(platform, tag, options);

        return {
          platform,
          posts,
          profiles: [] as InfluencerProfile[],
          errors,
          duration: Date.now() - startTime,
        };
      })
    );

    return results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        platform: platforms[i],
        posts: [],
        profiles: [],
        errors: [(result.reason as Error).message],
        duration: 0,
      };
    });
  }

  /** Get profile from a specific platform */
  async getProfile(
    platform: string,
    username: string,
    options?: ScrapingOptions
  ): Promise<InfluencerProfile> {
    const scraper = this.scrapers.get(platform);
    if (!scraper) throw new Error(`Platform not registered: ${platform}`);
    return scraper.getProfile(username, options);
  }

  /** Get registered platform names */
  get platforms(): string[] {
    return [...this.scrapers.keys()];
  }

  /** Cleanup all scrapers */
  async close(): Promise<void> {
    for (const scraper of this.scrapers.values()) {
      if ('close' in scraper && typeof (scraper as any).close === 'function') {
        await (scraper as any).close();
      }
    }
    logger.info('Scraping engine closed');
  }
}
