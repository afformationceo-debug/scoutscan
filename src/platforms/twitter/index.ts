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
      const proxy = this.proxyRouter.getProxyForPlatform('twitter');

      const collectedPosts: Post[] = [];

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject saved cookies if available
      const hasCookies = this.cookieManager.hasCookies('twitter');
      logger.info(`[Twitter] hasCookies('twitter') = ${hasCookies}`);
      if (hasCookies) {
        const cookies = this.cookieManager.loadCookies('twitter');
        logger.info(`[Twitter] Loaded ${cookies.length} cookies, critical: ${cookies.filter(c => ['auth_token','ct0','twid'].includes(c.name)).map(c => c.name).join(',') || 'NONE'}`);
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
      } else {
        logger.warn(`[Twitter] No cookies found — Twitter requires login for search. Results may be empty.`);
      }

      // Do NOT block media/fonts for Twitter — it can prevent tweet rendering on some setups
      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          // Intercept Twitter API responses (GraphQL, REST API, adaptive search)
          if (url.includes('/graphql/') || url.includes('/i/api/') || url.includes('SearchTimeline') || url.includes('adaptive.json')) {
            interceptedCount++;
            const before = collectedPosts.length;
            this.extractTweets(body, collectedPosts);
            const extracted = collectedPosts.length - before;
            logger.info(`[Twitter] API intercept #${interceptedCount}: ${url.split('?')[0].slice(-80)} — extracted: ${extracted}, body: ${body.length}bytes`);
          }
        },
      });

      // First visit homepage to stabilize the session (like TikTok approach)
      logger.info(`[Twitter] Visiting homepage first to stabilize session...`);
      await page.goto('https://x.com/home', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await randomDelay(3000, 5000);

      // Check if we got redirected to login from homepage
      const homeUrl = page.url();
      if (homeUrl.includes('/login') || homeUrl.includes('/i/flow/login')) {
        logger.error(`[Twitter] Redirected to login page — cookies are invalid or missing. Please update Twitter cookies in settings.`);
        await this.browser.closeContext(sessionId);
        return;
      }
      logger.info(`[Twitter] Homepage loaded: ${homeUrl}`);

      // Navigate to Twitter search
      const query = encodeURIComponent(cleanTag);
      const searchUrl = `https://x.com/search?q=${query}&src=typed_query&f=live`;
      logger.info(`[Twitter] Search URL: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for networkidle to ensure search results API calls complete
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {
        logger.info(`[Twitter] networkidle timeout — continuing`);
      });
      await randomDelay(3000, 5000);

      // Check if we got redirected to login
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => 'unknown');
      logger.info(`[Twitter] Page loaded. URL: ${currentUrl}, Title: "${pageTitle}"`);

      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login') || pageTitle.includes('Log in')) {
        logger.error(`[Twitter] Redirected to login page — cookies are invalid or missing. Please update Twitter cookies in settings.`);
        await this.browser.closeContext(sessionId);
        return;
      }

      // Wait for tweet articles to appear in DOM (max 20 seconds)
      try {
        await page.waitForSelector('article[data-testid="tweet"], [data-testid="cellInnerDiv"]', { timeout: 20000 });
        const tweetCount = await page.$$eval('article[data-testid="tweet"]', (els: Element[]) => els.length).catch(() => 0);
        logger.info(`[Twitter] Tweet articles found in DOM: ${tweetCount}`);
      } catch {
        // Try scrolling to trigger lazy loading
        logger.info(`[Twitter] No tweets yet, trying scroll to trigger rendering...`);
        await page.mouse.wheel(0, 500);
        await randomDelay(3000, 5000);
        // Log page state for debugging
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
        logger.warn(`[Twitter] No tweet articles appeared within 20s. Body preview: ${bodyText}`);
      }

      logger.info(`[Twitter] After initial wait: intercepted=${interceptedCount} API responses, collected=${collectedPosts.length} tweets from API`);

      // Always try DOM extraction (more reliable than API interception on deployed environments)
      logger.info(`[Twitter] Running DOM extraction...`);
      const domTweets = await this.extractTweetsFromDOM(page);
      logger.info(`[Twitter] DOM extraction returned ${domTweets.length} tweets`);

      // Merge: DOM tweets as primary, API-intercepted as supplement
      if (domTweets.length > 0) {
        const existingIds = new Set(collectedPosts.map(p => p.id));
        for (const t of domTweets) {
          if (!existingIds.has(t.id)) {
            collectedPosts.push(t);
            existingIds.add(t.id);
          }
        }
        logger.info(`[Twitter] After merge: ${collectedPosts.length} total tweets`);
      } else if (collectedPosts.length === 0) {
        logger.warn(`[Twitter] Both API interception and DOM extraction returned 0 tweets`);
      }

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
        if (collectedPosts.length === 0) {
          // Try DOM extraction after each scroll as fallback
          const domTweets = await this.extractTweetsFromDOM(page);
          // Deduplicate by checking existing IDs
          const existingIds = new Set(collectedPosts.map(p => p.id));
          for (const t of domTweets) {
            if (t.id && !existingIds.has(t.id)) {
              collectedPosts.push(t);
              existingIds.add(t.id);
            }
          }
        }
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
    const sessionId = randomUUID();

    try {
      await this.browser.launch({ headless: true });
      const proxy = this.proxyRouter.getProxyForPlatform('twitter');

      let profileData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject cookies for profile access too
      if (this.cookieManager.hasCookies('twitter')) {
        const cookies = this.cookieManager.loadCookies('twitter');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
      }

      const page = await this.browser.createPage(sessionId, {
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

      if (!profileData) {
        throw new Error(`Could not extract Twitter profile for @${username}`);
      }

      return this.parseProfile(profileData, username);
    } catch (error) {
      await this.browser.closeContext(sessionId).catch(() => {});
      throw error;
    }
  }

  /** Extract tweets from intercepted API response */
  private extractTweets(body: string, posts: Post[]): void {
    try {
      const data = JSON.parse(body);
      const beforeCount = posts.length;

      // Traverse the response to find tweet objects
      const findTweets = (obj: any, depth = 0): void => {
        if (depth > 15 || !obj || typeof obj !== 'object') return;

        // Check if this is a tweet result
        if (obj.__typename === 'Tweet' || (obj.rest_id && obj.legacy?.full_text)) {
          const tweet = obj.legacy || obj;
          if (tweet.full_text || tweet.text) {
            posts.push(this.parseTweet(tweet, obj));
            return;
          }
        }

        // Handle tweet_results wrapper (common in SearchTimeline)
        if (obj.tweet_results?.result) {
          findTweets(obj.tweet_results.result, depth + 1);
          return;
        }

        // Check timeline instructions (SearchTimeline response structure)
        if (obj.instructions) {
          for (const instr of Array.isArray(obj.instructions) ? obj.instructions : []) {
            findTweets(instr, depth + 1);
          }
          return;
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

        // Handle module items (promoted tweets, conversations)
        if (obj.content?.items) {
          for (const item of obj.content.items) findTweets(item, depth + 1);
          return;
        }

        if (obj.item?.itemContent?.tweet_results) {
          findTweets(obj.item.itemContent.tweet_results.result, depth + 1);
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

      // Debug: log extraction results for large responses
      const extracted = posts.length - beforeCount;
      if (body.length > 10000 && extracted === 0) {
        // Log key structure for debugging
        const keys = Object.keys(data);
        const dataKeys = data.data ? Object.keys(data.data) : [];
        const searchKeys = data.data?.search_by_raw_query ? Object.keys(data.data.search_by_raw_query) : [];
        logger.warn(`[Twitter] Large response (${body.length}B) but 0 tweets extracted. Keys: ${keys.join(',')}, data: ${dataKeys.join(',')}, search: ${searchKeys.join(',')}`);
        // Try to find instruction types
        try {
          const timeline = data.data?.search_by_raw_query?.search_timeline?.timeline;
          if (timeline?.instructions) {
            const instrTypes = timeline.instructions.map((i: any) => `${i.type}(entries:${i.entries?.length || 0})`);
            logger.warn(`[Twitter] Instructions: ${instrTypes.join(', ')}`);
            // Log first entry structure
            const firstEntry = timeline.instructions.find((i: any) => i.entries?.length > 0)?.entries?.[0];
            if (firstEntry) {
              logger.warn(`[Twitter] First entry: type=${firstEntry.content?.__typename}, entryId=${firstEntry.entryId?.slice(0, 30)}, hasItemContent=${!!firstEntry.content?.itemContent}, hasTweetResults=${!!firstEntry.content?.itemContent?.tweet_results}`);
            }
          }
        } catch {}
      }
    } catch (err) {
      if (body.length > 100) {
        logger.debug(`[Twitter] Failed to parse intercepted response (${body.length} bytes): ${(err as Error).message}`);
      }
    }
  }

  /** Fallback: extract tweets directly from the rendered page DOM */
  private async extractTweetsFromDOM(page: any): Promise<Post[]> {
    try {
      const tweets = await page.evaluate(() => {
        const results: any[] = [];
        const debugInfo: string[] = [];
        // Twitter/X renders tweet articles with data-testid="tweet"
        const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
        debugInfo.push(`Found ${tweetEls.length} article[data-testid="tweet"] elements`);
        debugInfo.push(`URL: ${window.location.href}`);
        debugInfo.push(`Title: ${document.title}`);
        if (tweetEls.length === 0) {
          // Try alternative selectors
          const allArticles = document.querySelectorAll('article');
          debugInfo.push(`Alternative: ${allArticles.length} <article> elements total`);
          const cellDivs = document.querySelectorAll('[data-testid="cellInnerDiv"]');
          debugInfo.push(`cellInnerDiv elements: ${cellDivs.length}`);
        }
        tweetEls.forEach((el: Element) => {
          try {
            // Get tweet text
            const textEl = el.querySelector('[data-testid="tweetText"]');
            const text = textEl?.textContent || '';

            // Get username from the user link (format: /@username)
            const userLinks = el.querySelectorAll('a[href^="/"]');
            let username = '';
            let fullName = '';
            for (const link of userLinks) {
              const href = (link as HTMLAnchorElement).href || '';
              const match = href.match(/\/([A-Za-z0-9_]+)$/);
              if (match && !['search', 'explore', 'home', 'notifications', 'messages', 'i', 'settings'].includes(match[1])) {
                username = match[1];
                // The display name is usually in the parent of the link
                const nameSpan = link.querySelector('span');
                if (nameSpan) fullName = nameSpan.textContent || '';
                break;
              }
            }

            // Get tweet link (contains /status/ID)
            let tweetUrl = '';
            let tweetId = '';
            const timeEl = el.querySelector('time');
            if (timeEl) {
              const parentLink = timeEl.closest('a');
              if (parentLink) {
                tweetUrl = parentLink.href || '';
                const idMatch = tweetUrl.match(/\/status\/(\d+)/);
                if (idMatch) tweetId = idMatch[1];
              }
            }

            // Get timestamp
            const timestamp = timeEl?.getAttribute('datetime') || '';

            // Get engagement counts
            const ariaLabels = el.querySelectorAll('[aria-label]');
            let likes = 0, replies = 0, views = 0;
            ariaLabels.forEach((e: Element) => {
              const label = e.getAttribute('aria-label') || '';
              const likeMatch = label.match(/(\d+)\s*(likes?|いいね)/i);
              const replyMatch = label.match(/(\d+)\s*(repl|返信)/i);
              const viewMatch = label.match(/(\d+)\s*(views?|表示)/i);
              if (likeMatch) likes = parseInt(likeMatch[1]);
              if (replyMatch) replies = parseInt(replyMatch[1]);
              if (viewMatch) views = parseInt(viewMatch[1]);
            });

            if (username || text) {
              results.push({
                id: tweetId,
                text,
                username,
                fullName,
                url: tweetUrl,
                timestamp,
                likes,
                replies,
                views,
              });
            }
          } catch (e) {
            debugInfo.push(`Error parsing tweet: ${(e as Error).message}`);
          }
        });
        debugInfo.push(`Extracted ${results.length} tweets from DOM`);
        return { results, debugInfo };
      });

      // Log debug info from inside page.evaluate
      if (tweets.debugInfo) {
        for (const info of tweets.debugInfo) {
          logger.info(`[Twitter DOM] ${info}`);
        }
      }

      return (tweets.results || []).map((t: any) => ({
        id: t.id || '',
        platform: 'twitter' as const,
        url: t.url || `https://x.com/${t.username}/status/${t.id}`,
        caption: t.text,
        hashtags: (t.text.match(/#[\w\u0080-\uffff]+/g) || []).map((h: string) => h.toLowerCase()),
        mentions: (t.text.match(/@[\w]+/g) || []).map((m: string) => m.toLowerCase()),
        likesCount: t.likes || 0,
        commentsCount: t.replies || 0,
        viewsCount: t.views || 0,
        mediaType: 'image' as const,
        mediaUrls: [],
        timestamp: t.timestamp || new Date().toISOString(),
        owner: {
          username: t.username,
          id: '',
          fullName: t.fullName,
        },
      }));
    } catch (err) {
      logger.warn(`[Twitter] DOM extraction failed: ${(err as Error).message}`);
      return [];
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
