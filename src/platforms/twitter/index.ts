import { PlatformScraper, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from '../../core/types.js';
import { StealthBrowser, humanScroll, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

/**
 * Twitter/X Scraper
 *
 * Strategy: Browser-based with API response interception
 * Twitter requires login for most content since 2023, so we use
 * browser automation to navigate and intercept GraphQL API responses.
 *
 * The internal GraphQL API uses these patterns:
 * - /i/api/graphql/{queryId}/SearchTimeline - Search tweets
 * - /i/api/graphql/{queryId}/UserByScreenName - User profile
 * - /i/api/graphql/{queryId}/UserTweets - User's tweets
 *
 * Bearer token for web app:
 * AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I45S2CJDs%3D1Zv...
 *
 * Guest token: Obtained from /1.1/guest/activate.json
 */
export class TwitterScraper implements PlatformScraper {
  readonly platform = 'twitter' as const;
  private browser: StealthBrowser;
  private proxyRouter: ProxyRouter;
  private rateLimiter: RateLimiter;
  private cookieManager: CookieManager;

  constructor(proxyUrls?: string[]) {
    this.proxyRouter = new ProxyRouter(proxyUrls);
    this.browser = new StealthBrowser(this.proxyRouter);
    this.rateLimiter = new RateLimiter('twitter');
    this.cookieManager = new CookieManager();
  }

  async *searchByHashtag(tag: string, options: SearchOptions = {}): AsyncGenerator<Post> {
    const cleanTag = tag.replace(/^#/, '');
    const maxResults = options.maxResults || 50;
    const until = options.until || null;
    const since = options.since || null;
    let yielded = 0;
    let consecutiveOld = 0;
    let interceptedCount = 0;

    logger.info(`[Twitter] Searching: ${cleanTag}`, { maxResults });

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      const collectedPosts: Post[] = [];

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject saved cookies if available
      if (this.cookieManager.hasCookies('twitter')) {
        const cookies = this.cookieManager.loadCookies('twitter');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
        logger.info(`[Twitter] Loaded ${cookies.length} saved cookies`);
      } else {
        logger.warn(`[Twitter] No cookies found — Twitter requires login for search. Results may be empty.`);
      }

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true,
        blockFonts: true,
        interceptResponses: (url, body) => {
          // Intercept all potential Twitter API responses (GraphQL, REST API, adaptive search)
          if (url.includes('/graphql/') || url.includes('/api/') || url.includes('/i/api/') || url.includes('SearchTimeline') || url.includes('adaptive.json')) {
            interceptedCount++;
            const before = collectedPosts.length;
            this.extractTweets(body, collectedPosts);
            const extracted = collectedPosts.length - before;
            if (extracted > 0) {
              logger.info(`[Twitter] Intercepted ${extracted} tweets from: ${url.split('?')[0].slice(-60)}`);
            }
          }
        },
      });

      // Navigate to Twitter search — use keyword search (NOT hashtag-only)
      // For pure hashtag searches, include #; for keywords, use plain text
      const isHashtag = /^[a-zA-Z0-9_\u3000-\u9FFF\uAC00-\uD7AF]+$/.test(cleanTag) && cleanTag.length < 30;
      const query = encodeURIComponent(cleanTag);
      const searchUrl = `https://x.com/search?q=${query}&src=typed_query&f=live`;
      logger.info(`[Twitter] Search URL: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await randomDelay(4000, 6000);

      // Check if we got redirected to login
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
        logger.error(`[Twitter] Redirected to login page — cookies are invalid or missing. Please update Twitter cookies in settings.`);
        await this.browser.closeContext(sessionId);
        return;
      }

      logger.info(`[Twitter] Page loaded. Intercepted ${interceptedCount} API responses, collected ${collectedPosts.length} tweets so far`);

      // Yield initial posts
      while (collectedPosts.length > 0 && yielded < maxResults) {
        const post = collectedPosts.shift()!;
        if (until && post.timestamp && post.timestamp > until) {
          continue;
        }
        // Delta scraping: skip posts older than 'since'
        if (since && post.timestamp && post.timestamp < since) {
          consecutiveOld++;
          if (consecutiveOld >= 20) break;
          continue;
        }
        consecutiveOld = 0;
        yield post;
        yielded++;
      }

      // Scroll for more
      const maxScrolls = Math.ceil((maxResults - yielded) / 20);
      for (let i = 0; i < maxScrolls && yielded < maxResults; i++) {
        await humanScroll(page, 1000);
        await randomDelay(2000, 4000);

        while (collectedPosts.length > 0 && yielded < maxResults) {
          const post = collectedPosts.shift()!;
          if (until && post.timestamp && post.timestamp > until) {
            continue;
          }
          // Delta scraping: skip posts older than 'since'
          if (since && post.timestamp && post.timestamp < since) {
            consecutiveOld++;
            if (consecutiveOld >= 20) break;
            continue;
          }
          consecutiveOld = 0;
          yield post;
          yielded++;
        }

        if (consecutiveOld >= 20) break;
        if (i > 3 && collectedPosts.length === 0) {
          logger.info(`[Twitter] No more tweets found after ${i + 1} scrolls (intercepted ${interceptedCount} responses total)`);
          break;
        }
      }

      // Save cookies after search (may have refreshed auth tokens)
      try {
        const freshCookies = await this.browser.getCookies(sessionId);
        if (freshCookies.length > 0) {
          this.cookieManager.saveCookies('twitter', freshCookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            path: (c as any).path || '/', expires: (c as any).expires,
          })));
        }
      } catch {}

      await this.browser.closeContext(sessionId);
    } catch (error) {
      logger.error(`[Twitter] Search failed: ${(error as Error).message}`);
    } finally {
      await this.browser.closeAll();
    }

    logger.info(`[Twitter] Search complete. Total: ${yielded} tweets (intercepted ${interceptedCount} API responses)`);
  }

  async getProfile(username: string, options?: ScrapingOptions): Promise<InfluencerProfile> {
    logger.info(`[Twitter] Fetching profile: @${username}`);

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      let profileData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject cookies for profile access too
      if (this.cookieManager.hasCookies('twitter')) {
        const cookies = this.cookieManager.loadCookies('twitter');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
      }

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true,
        interceptResponses: (url, body) => {
          if (url.includes('UserByScreenName') || url.includes('UserBy')) {
            try {
              const data = JSON.parse(body);
              const user = data?.data?.user?.result?.legacy
                || data?.data?.user?.result;
              if (user) profileData = user;
            } catch {}
          }
        },
      });

      await page.goto(`https://x.com/${username}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await randomDelay(4000, 6000);
      await simulateReading(page, 3000);

      // Fallback: extract from page meta/HTML
      if (!profileData) {
        profileData = await page.evaluate(() => {
          const desc = document.querySelector('meta[name="description"]')?.getAttribute('content');
          const title = document.querySelector('title')?.textContent;
          // Also try JSON-LD
          const jsonLd = document.querySelector('script[type="application/ld+json"]');
          if (jsonLd) {
            try { return { ...JSON.parse(jsonLd.textContent || ''), _source: 'jsonld' }; } catch {}
          }
          return desc ? { _source: 'meta', description: desc, title } : null;
        });
      }

      await this.browser.closeContext(sessionId);
      await this.browser.closeAll();

      if (!profileData) {
        throw new Error(`Could not extract Twitter profile for @${username}`);
      }

      return this.parseProfile(profileData, username);
    } catch (error) {
      await this.browser.closeAll();
      throw error;
    }
  }

  /** Extract tweets from intercepted API response */
  private extractTweets(body: string, posts: Post[]): void {
    try {
      const data = JSON.parse(body);

      // Traverse the response to find tweet objects
      const findTweets = (obj: any, depth = 0): void => {
        if (depth > 10 || !obj || typeof obj !== 'object') return;

        // Check if this is a tweet result
        if (obj.__typename === 'Tweet' || obj.tweet_results || obj.legacy?.full_text) {
          const tweet = obj.legacy || obj.tweet_results?.result?.legacy || obj;
          if (tweet.full_text || tweet.text) {
            posts.push(this.parseTweet(tweet, obj));
            return;
          }
        }

        // Check timeline entries
        if (obj.entries) {
          for (const entry of obj.entries) {
            findTweets(entry, depth + 1);
          }
          return;
        }

        if (obj.content?.itemContent?.tweet_results) {
          findTweets(obj.content.itemContent.tweet_results.result, depth + 1);
          return;
        }

        // Also check for modules (Twitter sometimes nests in modules)
        if (obj.items) {
          for (const item of obj.items) findTweets(item, depth + 1);
          return;
        }

        if (Array.isArray(obj)) {
          for (const item of obj) findTweets(item, depth + 1);
        } else {
          for (const val of Object.values(obj)) findTweets(val, depth + 1);
        }
      };

      findTweets(data);
    } catch (err) {
      // Only log if body looks like it might be relevant (not tiny error responses)
      if (body.length > 100) {
        logger.debug(`[Twitter] Failed to parse intercepted response (${body.length} bytes): ${(err as Error).message}`);
      }
    }
  }

  /** Parse a tweet object into Post format */
  private parseTweet(legacy: any, full: any): Post {
    const text = legacy.full_text || legacy.text || '';
    const hashtags = (legacy.entities?.hashtags || []).map((h: any) => `#${h.text}`.toLowerCase());
    const mentions = (legacy.entities?.user_mentions || []).map((m: any) => `@${m.screen_name}`.toLowerCase());

    const user = full?.core?.user_results?.result?.legacy || legacy.user || {};

    let mediaType: Post['mediaType'] = 'image';
    const media = legacy.entities?.media || legacy.extended_entities?.media || [];
    if (media.some((m: any) => m.type === 'video' || m.type === 'animated_gif')) {
      mediaType = 'video';
    }

    return {
      id: legacy.id_str || legacy.conversation_id_str || '',
      platform: 'twitter',
      url: `https://x.com/${user.screen_name || 'i'}/status/${legacy.id_str || ''}`,
      caption: text,
      hashtags,
      mentions,
      likesCount: legacy.favorite_count || 0,
      commentsCount: legacy.reply_count || 0,
      viewsCount: full?.views?.count ? parseInt(full.views.count) : undefined,
      mediaType,
      mediaUrls: media.map((m: any) => m.media_url_https || '').filter(Boolean),
      timestamp: legacy.created_at
        ? new Date(legacy.created_at).toISOString()
        : new Date().toISOString(),
      owner: {
        username: user.screen_name || '',
        id: user.id_str || '',
        fullName: user.name,
        profilePicUrl: user.profile_image_url_https,
      },
    };
  }

  /** Parse profile data */
  private parseProfile(data: any, username: string): InfluencerProfile {
    if (data._source === 'jsonld') {
      return {
        platform: 'twitter',
        id: username,
        username,
        fullName: data.givenName || data.name || '',
        bio: data.description || '',
        profilePicUrl: data.image?.contentUrl || '',
        followersCount: parseInt(data.interactionStatistic?.find?.((s: any) => s.interactionType?.includes('Follow'))?.userInteractionCount) || 0,
        followingCount: 0,
        postsCount: 0,
        isVerified: false,
        isBusinessAccount: false,
        isPrivate: false,
        scrapedAt: new Date().toISOString(),
      };
    }

    // Voyager/legacy format
    const legacy = data.legacy || data;
    return {
      platform: 'twitter',
      id: legacy.id_str || data.rest_id || '',
      username: legacy.screen_name || username,
      fullName: legacy.name || '',
      bio: legacy.description || '',
      profilePicUrl: legacy.profile_image_url_https?.replace('_normal', '') || '',
      followersCount: legacy.followers_count || 0,
      followingCount: legacy.friends_count || 0,
      postsCount: legacy.statuses_count || 0,
      isVerified: legacy.verified || data.is_blue_verified || false,
      isBusinessAccount: false,
      isPrivate: legacy.protected || false,
      category: legacy.professional?.category?.[0]?.name || '',
      externalUrl: legacy.entities?.url?.urls?.[0]?.expanded_url || '',
      scrapedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.browser.closeAll();
  }
}
