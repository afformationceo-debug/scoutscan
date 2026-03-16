import { PlatformScraper, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from '../../core/types.js';
import { StealthBrowser, humanScroll, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

/**
 * TikTok Scraper
 *
 * Strategy: Browser-only (X-Bogus requires real JS execution)
 * TikTok is the hardest platform to scrape due to:
 * - X-Bogus parameter (computed signature from obfuscated JS)
 * - _signature parameter (secondary signing)
 * - Argus bot detection system
 * - Slide puzzle / shape CAPTCHAs
 *
 * We MUST use a real browser to execute TikTok's JS and intercept responses.
 * Mobile proxies are strongly recommended for TikTok.
 */
export class TikTokScraper implements PlatformScraper {
  readonly platform = 'tiktok' as const;
  private browser: StealthBrowser;
  private proxyRouter: ProxyRouter;
  private rateLimiter: RateLimiter;
  private cookieManager: CookieManager;

  constructor(proxyUrls?: string[]) {
    this.proxyRouter = new ProxyRouter(proxyUrls);
    this.browser = new StealthBrowser(this.proxyRouter);
    this.rateLimiter = new RateLimiter('tiktok');
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

    logger.info(`[TikTok] Searching: ${cleanTag}`, { maxResults });
    logger.info(`[TikTok] ProxyRouter has ${(this.proxyRouter as any).proxies?.length || 0} proxies`);

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getProxyForPlatform('tiktok');
      logger.info(`[TikTok] Using proxy: ${proxy ? proxy.server?.replace(/:[^:]+@/, ':***@') : 'NONE'}`);

      const collectedPosts: Post[] = [];

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject saved cookies if available
      if (this.cookieManager.hasCookies('tiktok')) {
        const cookies = this.cookieManager.loadCookies('tiktok');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
        logger.info(`[TikTok] Loaded ${cookies.length} saved cookies`);
      }

      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          if (url.includes('/api/search') || url.includes('/api/challenge') || url.includes('/api/post') || url.includes('/api/recommend') || url.includes('search/item')) {
            interceptedCount++;
            const before = collectedPosts.length;
            this.extractVideos(body, collectedPosts);
            const extracted = collectedPosts.length - before;
            if (extracted > 0) {
              logger.info(`[TikTok] Intercepted ${extracted} videos from: ${url.split('?')[0].slice(-60)}`);
            }
          }
        },
      });

      // Navigate to TikTok keyword search (NOT hashtag-only /tag/ URL)
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(cleanTag)}`;
      logger.info(`[TikTok] Search URL: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      await randomDelay(5000, 8000);

      // Check for login/captcha redirect
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => 'unknown');
      logger.info(`[TikTok] Page loaded. URL: ${currentUrl}, Title: "${pageTitle}"`);

      if (currentUrl.includes('/login') || currentUrl.includes('captcha')) {
        logger.error(`[TikTok] Redirected to login/captcha — cookies may be invalid. URL: ${currentUrl}`);
      }

      // Debug: log page content snippet to understand what TikTok returned
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || 'NO BODY').catch(() => 'EVAL_FAILED');
      logger.info(`[TikTok] Page body preview: ${bodyText.substring(0, 300)}`);

      // Try to extract from page embedded data (raw items → parse to Post format)
      const embeddedRaw = await this.extractEmbeddedData(page, cleanTag);
      for (const raw of embeddedRaw) {
        try {
          collectedPosts.push(this.parseVideo(raw));
        } catch {
          // Skip items that can't be parsed
        }
      }

      logger.info(`[TikTok] Intercepted ${interceptedCount} API responses, collected ${collectedPosts.length} videos (embedded: ${embeddedRaw.length})`);

      // Debug: check what embedded data keys exist
      const embeddedKeys = await page.evaluate(() => {
        const keys: string[] = [];
        if ((window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__) keys.push('UNIVERSAL_DATA');
        if ((window as any).SIGI_STATE) keys.push('SIGI_STATE');
        if ((window as any).__NEXT_DATA__) keys.push('NEXT_DATA');
        return keys;
      }).catch(() => ['EVAL_FAILED']);
      logger.info(`[TikTok] Embedded data keys found: ${embeddedKeys.join(', ') || 'NONE'}`);

      // Yield initial
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
      const maxScrolls = Math.ceil((maxResults - yielded) / 12);
      for (let i = 0; i < maxScrolls && yielded < maxResults; i++) {
        await humanScroll(page, 1200);
        await randomDelay(3000, 6000);

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
        if (i > 3 && collectedPosts.length === 0) break;
      }

      await this.browser.closeContext(sessionId);
    } catch (error) {
      logger.error(`[TikTok] Search failed: ${(error as Error).message}`);
    } finally {
      await this.browser.closeAll();
    }

    logger.info(`[TikTok] Search complete. Total: ${yielded} videos (intercepted ${interceptedCount} API responses)`);
  }

  async getProfile(username: string, options?: ScrapingOptions): Promise<InfluencerProfile> {
    const cleanUser = username.replace(/^@/, '');
    logger.info(`[TikTok] Fetching profile: @${cleanUser}`);
    const sessionId = randomUUID();

    try {
      await this.browser.launch({ headless: true });
      const proxy = this.proxyRouter.getProxyForPlatform('tiktok');

      let profileData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          if (url.includes('/api/user/detail') || url.includes('uniqueId')) {
            try {
              const data = JSON.parse(body);
              if (data?.userInfo || data?.user) {
                profileData = data.userInfo || data;
              }
            } catch {}
          }
        },
      });

      await page.goto(`https://www.tiktok.com/@${cleanUser}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      await randomDelay(5000, 8000);

      // Extract from embedded SIGI_STATE or __UNIVERSAL_DATA
      if (!profileData) {
        profileData = await page.evaluate(() => {
          // SIGI_STATE (older TikTok pages)
          const sigi = (window as any).SIGI_STATE || (window as any).__NEXT_DATA__?.props?.pageProps;
          if (sigi?.UserModule?.users) {
            const users = sigi.UserModule.users;
            const stats = sigi.UserModule.stats;
            const key = Object.keys(users)[0];
            if (key) return { user: users[key], stats: stats?.[key] };
          }

          // __UNIVERSAL_DATA_FOR_REHYDRATION__
          const ud = (window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
          if (ud) {
            const defaultScope = ud.__DEFAULT_SCOPE__;
            const userDetail = defaultScope?.['webapp.user-detail'];
            if (userDetail?.userInfo) return userDetail.userInfo;
          }

          // JSON-LD
          const jsonLd = document.querySelector('script[type="application/ld+json"]');
          if (jsonLd) {
            try { return { _jsonLd: true, ...JSON.parse(jsonLd.textContent || '') }; } catch {}
          }

          // Meta tags fallback
          const desc = document.querySelector('meta[name="description"]')?.getAttribute('content');
          return desc ? { _meta: true, description: desc } : null;
        });
      }

      await this.browser.closeContext(sessionId);

      if (!profileData) {
        throw new Error(`Could not extract TikTok profile for @${cleanUser}`);
      }

      return this.parseProfile(profileData, cleanUser);
    } catch (error) {
      await this.browser.closeContext(sessionId).catch(() => {});
      throw error;
    }
  }

  /** Extract videos from API response */
  private extractVideos(body: string, posts: Post[]): void {
    try {
      const data = JSON.parse(body);
      const items = data?.itemList || data?.data?.itemList || data?.items || [];

      for (const item of items) {
        posts.push(this.parseVideo(item));
      }

      // Also check challenge info structure
      const challengeItems = data?.challengeInfo?.challengeItem?.itemList || [];
      for (const item of challengeItems) {
        posts.push(this.parseVideo(item));
      }
    } catch {}
  }

  /** Extract data from TikTok's embedded page state */
  private async extractEmbeddedData(page: any, tag: string): Promise<Post[]> {
    try {
      return await page.evaluate((tagName: string) => {
        const items: any[] = [];

        // __UNIVERSAL_DATA_FOR_REHYDRATION__
        const ud = (window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
        if (ud) {
          const defaultScope = ud.__DEFAULT_SCOPE__ || {};
          for (const key of Object.keys(defaultScope)) {
            const scope = defaultScope[key];
            if (scope?.itemList) {
              items.push(...scope.itemList);
            }
          }
        }

        // SIGI_STATE
        const sigi = (window as any).SIGI_STATE;
        if (sigi?.ItemModule) {
          items.push(...Object.values(sigi.ItemModule));
        }

        return items;
      }, tag);
    } catch {
      return [];
    }
  }

  /** Parse TikTok video item */
  private parseVideo(item: any): Post {
    const desc = item.desc || item.title || '';
    const hashtags = (item.challenges || item.textExtra || [])
      .filter((t: any) => t.hashtagName || t.hashtagId)
      .map((t: any) => `#${t.hashtagName || ''}`.toLowerCase());

    const fallbackHashtags = desc.match(/#[\w\u0080-\uffff]+/g) || [];

    return {
      id: item.id || '',
      platform: 'tiktok',
      url: `https://www.tiktok.com/@${item.author?.uniqueId || 'user'}/video/${item.id}`,
      caption: desc,
      hashtags: hashtags.length > 0 ? hashtags : fallbackHashtags.map((h: string) => h.toLowerCase()),
      mentions: (desc.match(/@[\w.]+/g) || []).map((m: string) => m.toLowerCase()),
      likesCount: item.stats?.diggCount || item.diggCount || 0,
      commentsCount: item.stats?.commentCount || item.commentCount || 0,
      viewsCount: item.stats?.playCount || item.playCount || 0,
      mediaType: 'video',
      mediaUrls: [item.video?.cover || item.video?.dynamicCover || ''].filter(Boolean),
      timestamp: item.createTime
        ? new Date(item.createTime * 1000).toISOString()
        : new Date().toISOString(),
      owner: {
        username: item.author?.uniqueId || '',
        id: item.author?.id || '',
        fullName: item.author?.nickname,
        profilePicUrl: item.author?.avatarThumb,
      },
    };
  }

  /** Parse profile data into normalized format */
  private parseProfile(data: any, username: string): InfluencerProfile {
    if (data._jsonLd) {
      return {
        platform: 'tiktok',
        id: username,
        username,
        fullName: data.name || '',
        bio: data.description || '',
        profilePicUrl: data.image || '',
        followersCount: parseInt(data.interactionStatistic?.find?.((s: any) =>
          s.interactionType?.includes('Follow'))?.userInteractionCount) || 0,
        followingCount: 0,
        postsCount: 0,
        isVerified: false,
        isBusinessAccount: false,
        isPrivate: false,
        scrapedAt: new Date().toISOString(),
      };
    }

    const user = data.user || data;
    const stats = data.stats || {};

    return {
      platform: 'tiktok',
      id: user.id || user.uid || '',
      username: user.uniqueId || user.unique_id || username,
      fullName: user.nickname || '',
      bio: user.signature || user.desc || '',
      profilePicUrl: user.avatarLarger || user.avatarMedium || user.avatarThumb || '',
      followersCount: stats.followerCount || user.followerCount || 0,
      followingCount: stats.followingCount || user.followingCount || 0,
      postsCount: stats.videoCount || user.videoCount || 0,
      engagementRate: stats.heartCount && stats.followerCount
        ? (stats.heartCount / stats.followerCount / (stats.videoCount || 1)) * 100
        : undefined,
      isVerified: user.verified || false,
      isBusinessAccount: user.commerceUserInfo?.commerceUser || false,
      isPrivate: user.privateAccount || user.secret || false,
      category: user.category || '',
      externalUrl: user.bioLink?.link || '',
      scrapedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.browser.closeAll();
  }
}
