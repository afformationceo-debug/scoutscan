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
      logger.info(`[TikTok] Using proxy: ${proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port} (${proxy.type}/${proxy.provider})` : 'NONE'}`);

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
          // Broader URL matching for TikTok API responses
          const isSearchAPI = url.includes('/api/search') || url.includes('/api/challenge') ||
            url.includes('/api/post') || url.includes('/api/recommend') ||
            url.includes('search/item') || url.includes('search/general') ||
            url.includes('search/video') || url.includes('/tiktok/') ||
            (url.includes('tiktok.com') && url.includes('item_list')) ||
            (url.includes('tiktok.com') && url.includes('/api/')) ||
            url.includes('search_item') || url.includes('full/search');
          if (isSearchAPI) {
            interceptedCount++;
            const before = collectedPosts.length;
            this.extractVideos(body, collectedPosts);
            const extracted = collectedPosts.length - before;
            logger.info(`[TikTok] API intercept #${interceptedCount}: ${url.split('?')[0].slice(-80)} — extracted: ${extracted}, body: ${body.length}bytes`);
          }
        },
      });

      // Navigate to TikTok keyword search (NOT hashtag-only /tag/ URL)
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(cleanTag)}`;
      logger.info(`[TikTok] Search URL: ${searchUrl}`);

      // Inject additional TikTok-specific stealth before navigation
      await page.addInitScript(() => {
        // TikTok checks these for headless detection
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // @ts-ignore
        delete navigator.__proto__.webdriver;
        // Ensure Notification permission looks realistic
        const origQuery = window.Notification?.permission;
        if (origQuery === 'denied' || !origQuery) {
          Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        }
        // TikTok checks for chrome runtime
        if (!(window as any).chrome) {
          (window as any).chrome = { runtime: {}, loadTimes: () => ({}) };
        }
        // TikTok checks permissions API
        const originalQuery = navigator.permissions?.query;
        if (originalQuery) {
          navigator.permissions.query = (parameters: any) =>
            parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
              : originalQuery.call(navigator.permissions, parameters);
        }
      });

      // First go to homepage to establish session with cookies
      logger.info(`[TikTok] Visiting homepage to establish session...`);
      await page.goto('https://www.tiktok.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});

      // Wait for JS hydration on homepage
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await randomDelay(3000, 5000);

      // Check homepage rendered properly
      const homeBodyLen = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
      logger.info(`[TikTok] Homepage body length: ${homeBodyLen} chars`);

      // Then navigate to search
      logger.info(`[TikTok] Navigating to search: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      }).catch((e: any) => {
        logger.warn(`[TikTok] Search page navigation issue: ${e.message?.split('\n')[0]}`);
      });

      // Wait for networkidle (API intercepts happen during this)
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {
        logger.info(`[TikTok] networkidle timeout — continuing with intercepted data`);
      });

      // Give TikTok SPA extra time to hydrate and render
      await randomDelay(5000, 8000);

      // Trigger content load by scrolling
      await page.evaluate(() => window.scrollTo(0, 300));
      await randomDelay(2000, 3000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await randomDelay(1000, 2000);

      // Wait for video elements with multiple selector attempts
      const videoSelectors = [
        '[data-e2e="search_top-item"]',
        '[data-e2e="search-card-desc"]',
        '[class*="DivItemContainer"]',
        '[class*="DivVideoCard"]',
        'a[href*="/video/"]',
        'div[class*="tiktok-"] a[href*="/@"]',
      ];
      let foundVideos = false;
      for (const selector of videoSelectors) {
        const count = await page.$$(selector).then(els => els.length).catch(() => 0);
        if (count > 0) {
          logger.info(`[TikTok] Found ${count} elements with selector: ${selector}`);
          foundVideos = true;
          break;
        }
      }
      if (!foundVideos) {
        logger.warn(`[TikTok] No video elements found with any selector`);
        // Try one more scroll + wait cycle
        await page.evaluate(() => window.scrollTo(0, 600));
        await randomDelay(3000, 5000);
      }

      // Check for login/captcha redirect
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => 'unknown');
      logger.info(`[TikTok] Page loaded. URL: ${currentUrl}, Title: "${pageTitle}"`);

      if (currentUrl.includes('/login') || currentUrl.includes('captcha')) {
        logger.error(`[TikTok] Redirected to login/captcha — cookies may be invalid. URL: ${currentUrl}`);
      }

      // Debug: log page content and DOM state
      const domState = await page.evaluate(() => {
        const videoLinks = document.querySelectorAll('a[href*="/video/"]').length;
        const e2eItems = document.querySelectorAll('[data-e2e="search_top-item"]').length;
        const bodyLen = document.body?.innerText?.length || 0;
        const bodyPreview = document.body?.innerText?.substring(0, 200) || 'NO BODY';
        return { videoLinks, e2eItems, bodyLen, bodyPreview };
      }).catch(() => ({ videoLinks: 0, e2eItems: 0, bodyLen: 0, bodyPreview: 'EVAL_FAILED' }));
      logger.info(`[TikTok] DOM state: ${domState.videoLinks} video links, ${domState.e2eItems} search items, body ${domState.bodyLen} chars`);
      logger.info(`[TikTok] Body preview: ${domState.bodyPreview.substring(0, 150)}`);

      // Try to extract from page embedded data
      const embeddedPosts = await this.extractEmbeddedData(page, cleanTag);
      if (embeddedPosts.length > 0) {
        collectedPosts.push(...embeddedPosts);
        logger.info(`[TikTok] Added ${embeddedPosts.length} posts from embedded data extraction`);
      }

      logger.info(`[TikTok] Intercepted ${interceptedCount} API responses, collected ${collectedPosts.length} videos (embedded: ${embeddedPosts.length})`);

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
      const beforeCount = posts.length;

      // TikTok API uses both camelCase and snake_case
      const items = data?.itemList || data?.item_list
        || data?.data?.itemList || data?.data?.item_list
        || data?.items || data?.data?.items || [];

      for (const item of items) {
        posts.push(this.parseVideo(item));
      }

      // Check challenge info structure
      const challengeItems = data?.challengeInfo?.challengeItem?.itemList || [];
      for (const item of challengeItems) {
        posts.push(this.parseVideo(item));
      }

      // Check search_item_list (newer TikTok search API)
      const searchItems = data?.data?.search_item_list || data?.search_item_list || [];
      for (const item of searchItems) {
        // search_item_list items have nested video info
        const videoItem = item?.item || item;
        if (videoItem?.id || videoItem?.desc) {
          posts.push(this.parseVideo(videoItem));
        }
      }

      // Generic deep search for any item with video ID
      if (posts.length === beforeCount && body.length > 1000) {
        this.deepExtractVideos(data, posts, 0);
      }

      const extracted = posts.length - beforeCount;
      if (extracted > 0) {
        logger.info(`[TikTok] extractVideos: found ${extracted} videos`);
      } else if (body.length > 500) {
        // Debug: log structure of large unrecognized responses
        const keys = Object.keys(data || {});
        const dataKeys = data?.data ? Object.keys(data.data) : [];
        logger.debug(`[TikTok] extractVideos: 0 from ${body.length}B. Keys: ${keys.join(',')}, data: ${dataKeys.join(',')}`);
      }
    } catch {}
  }

  /** Deep traversal to find video items in nested TikTok API responses */
  private deepExtractVideos(obj: any, posts: Post[], depth: number): void {
    if (depth > 8 || !obj || typeof obj !== 'object') return;

    // Check if this looks like a video item
    if (obj.id && (obj.desc !== undefined || obj.author) && (obj.stats || obj.createTime)) {
      try { posts.push(this.parseVideo(obj)); } catch {}
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) this.deepExtractVideos(item, posts, depth + 1);
    } else {
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
          this.deepExtractVideos(val, posts, depth + 1);
        }
      }
    }
  }

  /** Extract data from TikTok's embedded page state */
  private async extractEmbeddedData(page: any, tag: string): Promise<Post[]> {
    try {
      const rawItems = await page.evaluate(() => {
        const items: any[] = [];

        // Method 1: __UNIVERSAL_DATA_FOR_REHYDRATION__
        const ud = (window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
        if (ud) {
          const defaultScope = ud.__DEFAULT_SCOPE__ || {};
          for (const key of Object.keys(defaultScope)) {
            const scope = defaultScope[key];
            if (scope?.itemList) items.push(...scope.itemList);
            // New TikTok structure: data.itemList
            if (scope?.data?.itemList) items.push(...scope.data.itemList);
            // Search results structure
            if (scope?.searchResult) {
              const sr = scope.searchResult;
              if (sr?.itemList) items.push(...sr.itemList);
              if (sr?.data) items.push(...(Array.isArray(sr.data) ? sr.data : []));
            }
          }
          // Also check top-level keys
          if (ud.webapp?.['search-page']) {
            const sp = ud.webapp['search-page'];
            if (sp?.itemList) items.push(...sp.itemList);
          }
        }

        // Method 2: SIGI_STATE
        const sigi = (window as any).SIGI_STATE;
        if (sigi?.ItemModule) {
          items.push(...Object.values(sigi.ItemModule));
        }

        // Method 3: __NEXT_DATA__
        const nd = (window as any).__NEXT_DATA__;
        if (nd?.props?.pageProps) {
          const pp = nd.props.pageProps;
          if (pp?.itemList) items.push(...pp.itemList);
          if (pp?.items) items.push(...pp.items);
        }

        // Method 4: Scan script tags for JSON data
        if (items.length === 0) {
          const scripts = document.querySelectorAll('script[type="application/json"]');
          scripts.forEach(s => {
            try {
              const data = JSON.parse(s.textContent || '');
              if (data?.itemList) items.push(...data.itemList);
              if (data?.items) items.push(...data.items);
            } catch {}
          });
        }

        // Method 5: Extract from DOM video links directly
        if (items.length === 0) {
          const links = document.querySelectorAll('a[href*="/video/"]');
          links.forEach(link => {
            const href = link.getAttribute('href') || '';
            const match = href.match(/@([^/]+)\/video\/(\d+)/);
            if (match) {
              items.push({
                id: match[2],
                author: { uniqueId: match[1] },
                desc: link.textContent?.trim() || '',
                stats: {},
              });
            }
          });
        }

        // Method 6: Deep scan UNIVERSAL_DATA for any item with video structure
        if (items.length === 0) {
          const ud2 = (window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
          if (ud2) {
            const deepScan = (obj: any, depth: number): any[] => {
              if (depth > 6 || !obj || typeof obj !== 'object') return [];
              const found: any[] = [];
              if (obj.id && (obj.desc !== undefined || obj.author)) {
                found.push(obj);
                return found;
              }
              if (Array.isArray(obj)) {
                for (const item of obj) found.push(...deepScan(item, depth + 1));
              } else {
                for (const val of Object.values(obj)) {
                  if (val && typeof val === 'object') found.push(...deepScan(val as any, depth + 1));
                }
              }
              return found;
            };
            items.push(...deepScan(ud2, 0));
          }
        }

        return items;
      }).catch(() => []);

      logger.info(`[TikTok] extractEmbeddedData found ${rawItems.length} raw items`);

      const posts: Post[] = [];
      for (const raw of rawItems) {
        try {
          posts.push(this.parseVideo(raw));
        } catch {}
      }
      return posts;
    } catch (e) {
      logger.error(`[TikTok] extractEmbeddedData failed: ${(e as Error).message}`);
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
