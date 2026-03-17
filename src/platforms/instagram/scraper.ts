import { InstagramAPI } from './api.js';
import { StealthBrowser, humanScroll, humanClick, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { SessionManager } from '../../core/session.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { Post, InfluencerProfile, SearchOptions, ScrapingOptions, PlatformScraper, HashtagInfo } from '../../core/types.js';
import { logger } from '../../utils/logger.js';
import { randomDelay, backoffDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

const REGIONS = ['US', 'US-W', 'GB', 'DE', 'JP', 'KR'] as const;

export interface HashtagSearchResult {
  hashtagInfo?: HashtagInfo;
  posts: Post[];
  profiles: Map<string, InfluencerProfile>;
  totalScraped: number;
}

/**
 * Instagram Scraper - Main orchestrator
 *
 * Strategy (2025+): Browser-first, API-fallback
 * Instagram has heavily restricted API endpoints, so we use a real browser
 * with stealth anti-detection as the primary method.
 *
 * Flow:
 * 1. Launch stealth Chromium with fingerprint injection
 * 2. Navigate to Instagram hashtag/profile page
 * 3. Intercept XHR/GraphQL responses for structured JSON data
 * 4. Human-like scrolling to trigger pagination
 * 5. Parse intercepted data into normalized schema
 */
export class InstagramScraper implements PlatformScraper {
  readonly platform = 'instagram' as const;
  private api: InstagramAPI;
  private browser: StealthBrowser;
  private proxyRouter: ProxyRouter;
  private rateLimiter: RateLimiter;
  private sessionManager: SessionManager;
  private apiSuccessCount = 0;
  private apiAttemptCount = 0;
  private useApiFirst = true;
  private ownsOwnBrowser: boolean;

  private cookieManager: CookieManager;

  constructor(proxyUrls?: string[], sharedBrowser?: StealthBrowser) {
    this.proxyRouter = new ProxyRouter(proxyUrls);
    if (sharedBrowser) {
      this.browser = sharedBrowser;
      this.ownsOwnBrowser = false;
    } else {
      this.browser = new StealthBrowser(this.proxyRouter);
      this.ownsOwnBrowser = true;
    }
    this.rateLimiter = new RateLimiter('instagram');
    this.sessionManager = new SessionManager();
    this.cookieManager = new CookieManager();
    this.api = new InstagramAPI();
  }

  /**
   * Search posts by hashtag using stealth browser
   * Opens Instagram hashtag page, intercepts API responses, scrolls for more
   */
  async *searchByHashtag(tag: string, options: SearchOptions = {}): AsyncGenerator<Post> {
    const cleanTag = tag.replace(/^#/, '');
    const maxResults = options.maxResults || 100;
    const since = options.since || null;
    const until = options.until || null;
    let consecutiveOld = 0;
    const MAX_CONSECUTIVE_OLD = 20;
    let yielded = 0;
    const maxBrowserRetries = 2;

    logger.info(`[Instagram] Searching hashtag: #${cleanTag}`, { maxResults });

    for (let attempt = 0; attempt <= maxBrowserRetries; attempt++) {
      const region = REGIONS[attempt % REGIONS.length];
      const proxy = this.proxyRouter.getProxyForPlatform('instagram');

      const sessionId = randomUUID();

      try {
        if (attempt > 0) {
          logger.info(`[Instagram] Browser retry #${attempt} (region: ${region}, collected so far: ${yielded})`);
          await backoffDelay(attempt, 3000, 10000);
        }

        await this.browser.launch({ headless: true });
        const collectedPosts: Post[] = [];

        await this.browser.createStealthContext(sessionId, { region, proxy });

        // Inject saved cookies if available
        if (this.cookieManager.hasCookies('instagram')) {
          const cookies = this.cookieManager.loadCookies('instagram');
          await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
          if (attempt === 0) logger.info(`[Instagram] Loaded ${cookies.length} saved cookies`);
        }

        const page = await this.browser.createPage(sessionId, {
          interceptResponses: (url, body) => {
            this.extractPostsFromResponse(url, body, collectedPosts);
          },
        });

        logger.info(`[Instagram] Navigating to hashtag page...`);

        // Navigate to home first to establish session
        await page.goto('https://www.instagram.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await randomDelay(2000, 3000);

        // Dismiss any popups
        try {
          const notNowBtn = await page.$('button:has-text("Not now"), button:has-text("Not Now"), [role="button"]:has-text("Not")');
          if (notNowBtn) await notNowBtn.click();
          await randomDelay(1000, 2000);
        } catch {}

        // Check if homepage redirected to login
        const homeUrl = page.url();
        if (homeUrl.includes('/accounts/login') || homeUrl.includes('/challenge')) {
          logger.error(`[Instagram] Redirected to login from homepage — cookies expired or invalid. URL: ${homeUrl}`);
          await this.browser.closeContext(sessionId);
          if (attempt === maxBrowserRetries) {
            logger.info(`[Instagram] All attempts failed due to login redirect, trying API fallback...`);
            yield* this.searchByHashtagAPI(cleanTag, maxResults);
          }
          continue;
        }

        // Navigate directly to /popular/ URL (Instagram redirects /explore/tags/ here anyway)
        const popularUrl = `https://www.instagram.com/popular/${encodeURIComponent(cleanTag)}/`;
        logger.info(`[Instagram] Loading: ${popularUrl}`);
        await page.goto(popularUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Dismiss any popups
        try {
          const notNowBtn = await page.$('button:has-text("Not now"), button:has-text("Not Now")');
          if (notNowBtn) await notNowBtn.click();
        } catch {}

        // Wait for page content to fully render
        await randomDelay(4000, 6000);

        const finalUrl = page.url();
        logger.info(`[Instagram] Page loaded: ${finalUrl}`);

        // Check if search page redirected to login
        if (finalUrl.includes('/accounts/login') || finalUrl.includes('/challenge')) {
          logger.error(`[Instagram] Search page redirected to login — cookies expired. URL: ${finalUrl}`);
          await this.browser.closeContext(sessionId);
          if (attempt === maxBrowserRetries) {
            yield* this.searchByHashtagAPI(cleanTag, maxResults);
          }
          continue;
        }

        // If /popular/ yielded no intercepted data, try alternative URLs
        if (collectedPosts.length === 0 && !finalUrl.includes('/popular/')) {
          logger.info(`[Instagram] /popular/ URL redirected, trying /explore/tags/...`);
          await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(cleanTag)}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await randomDelay(4000, 6000);
          const altUrl = page.url();
          logger.info(`[Instagram] Explore tags URL: ${altUrl}`);
        }

        const pageData = await this.extractEmbeddedData(page);
        if (pageData.length > 0) {
          for (const post of pageData) {
            if (yielded >= maxResults) break;
            collectedPosts.push(post);
          }
        }

        while (collectedPosts.length > 0 && yielded < maxResults) {
          const post = collectedPosts.shift()!;
          if (until && post.timestamp && post.timestamp > until) {
            continue;
          }
          if (since && post.timestamp && post.timestamp < since) {
            consecutiveOld++;
            if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;
            continue;
          }
          consecutiveOld = 0;
          yield post;
          yielded++;
        }
        if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;

        // Phase 1: Scroll for more content (works when page has infinite scroll)
        let emptyScrolls = 0;
        for (let i = 0; i < 8 && yielded < maxResults; i++) {
          await humanScroll(page, 1200 + Math.random() * 800);
          await randomDelay(2500, 4500);

          const beforeYield = yielded;
          while (collectedPosts.length > 0 && yielded < maxResults) {
            const post = collectedPosts.shift()!;
            if (until && post.timestamp && post.timestamp > until) continue;
            if (since && post.timestamp && post.timestamp < since) {
              consecutiveOld++;
              if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;
              continue;
            }
            consecutiveOld = 0;
            yield post;
            yielded++;
          }
          if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;

          if (yielded === beforeYield) {
            emptyScrolls++;
            if (emptyScrolls >= 3) break;
          } else {
            emptyScrolls = 0;
          }
        }

        // Phase 2: Direct GraphQL API pagination from page context
        if (yielded < maxResults && consecutiveOld < MAX_CONSECUTIVE_OLD) {
          logger.info(`[Instagram] Scroll gave ${yielded} posts, trying GraphQL API pagination...`);

          const apiPosts = await this.fetchPopularPaginated(page, cleanTag, maxResults - yielded);
          for (const post of apiPosts) {
            if (yielded >= maxResults) break;
            if (until && post.timestamp && post.timestamp > until) continue;
            if (since && post.timestamp && post.timestamp < since) {
              consecutiveOld++;
              if (consecutiveOld >= MAX_CONSECUTIVE_OLD) break;
              continue;
            }
            consecutiveOld = 0;
            yield post;
            yielded++;
          }
        }

        if (yielded > 0) {
          logger.info(`[Instagram] Progress: ${yielded}/${maxResults} posts`);
        }

        await this.browser.closeContext(sessionId);

        // If we got results, don't retry
        if (yielded > 0) break;

      } catch (error) {
        const errMsg = (error as Error).message;
        logger.error(`[Instagram] Browser attempt ${attempt + 1} failed: ${errMsg}`);

        if (proxy && (errMsg.includes('429') || errMsg.includes('blocked'))) {
          this.proxyRouter.markBlocked(proxy);
        }

        await this.browser.closeContext(sessionId).catch(() => {});

        // On last browser retry with no results, try API
        if (attempt === maxBrowserRetries && yielded === 0) {
          logger.info(`[Instagram] All browser attempts failed, trying API fallback...`);
          yield* this.searchByHashtagAPI(cleanTag, maxResults);
        }
      }
    }

    logger.info(`[Instagram] Hashtag search complete. Total: ${yielded} posts`);
  }

  /** Fetch more posts via GraphQL API directly from page context */
  private async fetchPopularPaginated(page: any, tag: string, maxNeeded: number): Promise<Post[]> {
    const allPosts: Post[] = [];
    const seenCodes = new Set<string>();

    try {
      // Extract doc_id and CSRF token from page, then make paginated GraphQL requests
      const results = await page.evaluate(async (args: { tag: string; maxNeeded: number }) => {
        const posts: any[] = [];
        const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
        const csrf = csrfMatch ? csrfMatch[1] : '';

        // Try to find doc_id from existing script tags
        let docId = '';
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const text = s.textContent || '';
          // Look for doc_id pattern used for popular search queries
          const match = text.match(/"xig_logged_out_popular_search_media_info"[^}]*?"doc_id"\s*:\s*"(\d+)"/);
          if (match) { docId = match[1]; break; }
        }

        // Method 1: Try web search topsearch API
        try {
          const searchResp = await fetch(`/web/search/topsearch/?query=%23${encodeURIComponent(args.tag)}&context=hashtag`, {
            headers: {
              'X-CSRFToken': csrf,
              'X-IG-App-ID': '936619743392459',
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json',
            },
          });
          if (searchResp.ok) {
            const data = await searchResp.json();
            // topsearch returns hashtags and users, with media in hashtag results
            const hashtags = data?.hashtags || [];
            for (const h of hashtags) {
              if (h?.hashtag?.media_count && h?.hashtag?.search_result_subtitles) {
                // Has media count but not individual posts
              }
            }
          }
        } catch {}

        // Method 2: Try tag sections API (works for logged-in users)
        try {
          const sectionsResp = await fetch(`/api/v1/tags/${encodeURIComponent(args.tag)}/sections/`, {
            method: 'POST',
            headers: {
              'X-CSRFToken': csrf,
              'X-IG-App-ID': '936619743392459',
              'X-Requested-With': 'XMLHttpRequest',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'include_persistent=0&max_id=&page=0&surface=grid&tab=recent',
          });
          if (sectionsResp.ok) {
            const ct = sectionsResp.headers.get('content-type') || '';
            if (ct.includes('json')) {
              const data = await sectionsResp.json();
              const sections = data?.sections || [];
              for (const section of sections) {
                const medias = section?.layout_content?.medias || [];
                for (const m of medias) {
                  if (m?.media?.code) posts.push(m.media);
                }
              }
              // Handle pagination with more_available and next_max_id
              let maxId = data?.next_max_id;
              let page = 1;
              while (maxId && posts.length < args.maxNeeded && page < 5) {
                const nextResp = await fetch(`/api/v1/tags/${encodeURIComponent(args.tag)}/sections/`, {
                  method: 'POST',
                  headers: {
                    'X-CSRFToken': csrf,
                    'X-IG-App-ID': '936619743392459',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: `include_persistent=0&max_id=${maxId}&page=${page}&surface=grid&tab=recent`,
                });
                if (!nextResp.ok) break;
                const nct = nextResp.headers.get('content-type') || '';
                if (!nct.includes('json')) break;
                const nextData = await nextResp.json();
                const nextSections = nextData?.sections || [];
                for (const section of nextSections) {
                  const medias = section?.layout_content?.medias || [];
                  for (const m of medias) {
                    if (m?.media?.code) posts.push(m.media);
                  }
                }
                maxId = nextData?.next_max_id;
                if (!nextData?.more_available) break;
                page++;
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
              }
            }
          }
        } catch {}

        // Method 3: Try GraphQL API if we have doc_id
        if (posts.length < args.maxNeeded && docId) {
          try {
            const variables = JSON.stringify({ tag_name: args.tag, first: 50 });
            const graphqlResp = await fetch('/api/graphql', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': csrf,
                'X-IG-App-ID': '936619743392459',
              },
              body: `doc_id=${docId}&variables=${encodeURIComponent(variables)}`,
            });
            if (graphqlResp.ok) {
              const data = await graphqlResp.json();
              const edges = data?.data?.xig_logged_out_popular_search_media_info?.edges || [];
              for (const edge of edges) {
                if (edge?.node?.code) posts.push(edge.node);
              }
            }
          } catch {}
        }

        // Method 4: Extract shortcodes from page links and fetch individually
        if (posts.length < args.maxNeeded) {
          const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
          const shortcodes: string[] = [];
          links.forEach(link => {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/(p|reel)\/([\w-]+)/);
            if (match) shortcodes.push(match[2]);
          });
          for (const code of shortcodes) {
            const exists = posts.some(p => p.code === code || p.shortcode === code);
            if (!exists) {
              posts.push({ code, _fromLink: true });
            }
          }
        }

        return posts;
      }, { tag, maxNeeded });

      for (const raw of results) {
        const code = raw.code || raw.shortcode || '';
        if (!code || seenCodes.has(code)) continue;
        seenCodes.add(code);

        if (raw._fromLink) {
          // Minimal post from link extraction
          allPosts.push({
            id: code,
            platform: 'instagram',
            shortcode: code,
            url: `https://www.instagram.com/p/${code}/`,
            caption: '',
            hashtags: [],
            mentions: [],
            likesCount: 0,
            commentsCount: 0,
            mediaType: 'image',
            mediaUrls: [],
            timestamp: new Date().toISOString(),
            owner: { username: '', id: '' },
          });
        } else {
          allPosts.push(this.parsePopularNode(raw));
        }
      }

      if (allPosts.length > 0) {
        logger.info(`[Instagram] GraphQL API pagination: got ${allPosts.length} additional posts`);
      }
    } catch (error) {
      logger.warn(`[Instagram] GraphQL pagination failed: ${(error as Error).message}`);
    }

    return allPosts;
  }

  /** API-based fallback for hashtag search */
  private async *searchByHashtagAPI(tag: string, maxResults: number): AsyncGenerator<Post> {
    let yielded = 0;
    let cursor: string | undefined;

    try {
      await this.api.initSession();

      while (yielded < maxResults) {
        await this.rateLimiter.waitForSlot();
        const result = await this.api.searchHashtag(tag, Math.min(50, maxResults - yielded), cursor);

        for (const post of result.posts) {
          if (yielded >= maxResults) break;
          yield post;
          yielded++;
        }

        if (!result.hasNextPage || !result.endCursor) break;
        cursor = result.endCursor;
      }
    } catch (error) {
      logger.error(`[Instagram] API fallback also failed: ${(error as Error).message}`);
    }
  }

  /** Get profile with API-first + browser fallback */
  async getProfile(username: string, options: ScrapingOptions = {}): Promise<InfluencerProfile> {
    // Phase 1: API-first (fast path ~200ms)
    if (this.useApiFirst) {
      try {
        this.apiAttemptCount++;
        await this.api.initSession();
        const profile = await this.api.getProfile(username);
        this.apiSuccessCount++;
        return profile;
      } catch (apiError) {
        logger.debug(`[Instagram] API failed for @${username}: ${(apiError as Error).message}, trying browser`);
        // Auto-switch: if first 10 attempts have < 50% success, disable API-first
        if (this.apiAttemptCount >= 10 && (this.apiSuccessCount / this.apiAttemptCount) < 0.5) {
          logger.warn(`[Instagram] API success rate ${Math.round(this.apiSuccessCount / this.apiAttemptCount * 100)}% — switching to browser-first`);
          this.useApiFirst = false;
        }
      }
    }

    // Phase 2: Browser fallback (max 2 retries)
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const region = REGIONS[attempt % REGIONS.length];
      const proxy = this.proxyRouter.getProxyForPlatform('instagram');

      try {
        const result = await this.getProfileOnce(username, region, proxy);
        if (attempt > 0) {
          logger.info(`[Instagram] @${username} succeeded on browser retry #${attempt}`);
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`[Instagram] @${username} browser attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);

        if (proxy && (lastError.message.includes('429') || lastError.message.includes('blocked') || lastError.message.includes('login'))) {
          this.proxyRouter.markBlocked(proxy);
        }

        if (attempt < maxRetries - 1) {
          await backoffDelay(attempt, 3000, 15000);
        }
      }
    }

    throw new Error(`All methods failed for @${username}: ${lastError?.message}`);
  }

  /** Single profile fetch attempt with specified region and proxy */
  private async getProfileOnce(username: string, region: string, proxy?: any): Promise<InfluencerProfile> {
    logger.info(`[Instagram] Fetching profile: @${username} (region: ${region})`);

    await this.browser.launch({ headless: true });
    const sessionId = randomUUID();

    let profileData: any = null;

    try {
      await this.browser.createStealthContext(sessionId, { region, proxy });

      // Load cookies
      if (this.cookieManager.hasCookies('instagram')) {
        const cookies = this.cookieManager.loadCookies('instagram');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
      }

      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          if (url.includes('web_profile_info') || url.includes('/graphql/query')) {
            try {
              const data = JSON.parse(body);
              const user = data?.data?.user || data?.graphql?.user;
              if (user && user.username) {
                profileData = user;
              }
            } catch {}
          }
        },
      });

      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await randomDelay(3000, 5000);

      // Try to extract from embedded page data
      if (!profileData) {
        profileData = await page.evaluate(() => {
          // Method 1: __additionalDataLoaded
          for (const key of Object.keys((window as any).__additionalData || {})) {
            const data = (window as any).__additionalData[key]?.data?.user;
            if (data) return data;
          }
          // Method 2: _sharedData
          const shared = (window as any)._sharedData;
          if (shared?.entry_data?.ProfilePage?.[0]?.graphql?.user) {
            return shared.entry_data.ProfilePage[0].graphql.user;
          }
          // Method 3: JSON-LD
          const jsonLd = document.querySelector('script[type="application/ld+json"]');
          if (jsonLd) {
            try { return JSON.parse(jsonLd.textContent || ''); } catch {}
          }
          // Method 4: meta tags
          const desc = document.querySelector('meta[name="description"]')?.getAttribute('content');
          const title = document.querySelector('title')?.textContent;
          if (desc) {
            const match = desc.match(/([\d,.]+[KMB]?) Followers, ([\d,.]+[KMB]?) Following, ([\d,.]+[KMB]?) Posts/i);
            if (match) {
              return { _fromMeta: true, description: desc, title, followers: match[1], following: match[2], posts: match[3] };
            }
          }
          return null;
        });
      }

      await simulateReading(page, 2000);

      if (!profileData) {
        throw new Error(`No profile data found for @${username}`);
      }

      if (profileData._fromMeta) {
        return this.parseMetaProfile(profileData, username);
      }

      return this.parseUserProfile(profileData);
    } finally {
      await this.browser.closeContext(sessionId);
    }
  }

  /** Full hashtag search with profile enrichment */
  async searchHashtagFull(tag: string, options: SearchOptions & { enrichProfiles?: boolean } = {}): Promise<HashtagSearchResult> {
    const posts: Post[] = [];
    const profiles = new Map<string, InfluencerProfile>();

    for await (const post of this.searchByHashtag(tag, options)) {
      posts.push(post);
    }

    if (options.enrichProfiles !== false) {
      const uniqueUsernames = [...new Set(posts.map(p => p.owner.username).filter(Boolean))];
      logger.info(`[Instagram] Enriching ${uniqueUsernames.length} profiles...`);

      for (const username of uniqueUsernames) {
        try {
          const profile = await this.getProfile(username);
          profiles.set(username, profile);
          logger.debug(`Profile: @${username} (${profile.followersCount.toLocaleString()} followers)`);
        } catch (error) {
          logger.warn(`Failed to get @${username}: ${(error as Error).message}`);
        }
        await randomDelay(2000, 4000);
      }
    }

    return { posts, profiles, totalScraped: posts.length };
  }

  /** Extract posts from intercepted API responses */
  private extractPostsFromResponse(url: string, body: string, posts: Post[]): void {
    if (!url.includes('graphql') && !url.includes('/api/v1/') && !url.includes('/api/') && !url.includes('/web/')) return;

    try {
      const data = JSON.parse(body);

      // Popular page response (2026+): xig_logged_out_popular_search_media_info
      const popularEdges = data?.data?.xig_logged_out_popular_search_media_info?.edges || [];
      for (const edge of popularEdges) {
        if (edge?.node?.code) posts.push(this.parsePopularNode(edge.node));
      }

      // GraphQL hashtag response (legacy)
      const edges = data?.data?.hashtag?.edge_hashtag_to_media?.edges
        || data?.data?.hashtag?.edge_hashtag_to_top_posts?.edges
        || [];

      for (const edge of edges) {
        if (edge?.node) posts.push(this.parseNode(edge.node));
      }

      // New search SERP response (2025+): xdt_fbsearch__top_serp_graphql
      const serpEdges = data?.data?.xdt_fbsearch__top_serp_graphql?.edges || [];
      for (const edge of serpEdges) {
        const serpItems = edge?.node?.items || [];
        for (const item of serpItems) {
          if (item?.code) posts.push(this.parseMediaV1(item));
        }
      }

      // V1 API sections response
      const sections = data?.sections || data?.data?.recent?.sections || [];
      for (const section of sections) {
        const medias = section?.layout_content?.medias || [];
        for (const m of medias) {
          if (m?.media) posts.push(this.parseMediaV1(m.media));
        }
      }

      // Direct media list
      const items = data?.items || data?.data?.items || [];
      for (const item of items) {
        if (item?.pk || item?.id) posts.push(this.parseMediaV1(item));
      }

      // Generic: any response with edges containing code/shortcode nodes
      if (posts.length === 0 && data?.data) {
        for (const key of Object.keys(data.data)) {
          const val = data.data[key];
          if (val?.edges && Array.isArray(val.edges)) {
            for (const edge of val.edges) {
              if (edge?.node?.code) posts.push(this.parsePopularNode(edge.node));
            }
          }
        }
      }
    } catch { /* not JSON or unexpected format */ }
  }

  /** Extract data embedded in the HTML page source */
  private async extractEmbeddedData(page: any): Promise<Post[]> {
    try {
      const rawNodes = await page.evaluate(() => {
        const posts: any[] = [];
        const seenCodes = new Set<string>();

        // Try _sharedData (legacy)
        const shared = (window as any)._sharedData;
        if (shared?.entry_data?.TagPage) {
          const tagPage = shared.entry_data.TagPage[0];
          const edges = tagPage?.graphql?.hashtag?.edge_hashtag_to_media?.edges || [];
          for (const e of edges) {
            if (e.node) {
              const code = e.node.shortcode || e.node.code;
              if (code && !seenCodes.has(code)) { seenCodes.add(code); posts.push(e.node); }
            }
          }
        }

        // Search all JSON script tags for media nodes
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (const script of scripts) {
          try {
            const json = JSON.parse(script.textContent || '');
            const findMedia = (obj: any, depth = 0): void => {
              if (depth > 8 || !obj || typeof obj !== 'object') return;
              // Match: shortcode or code + some media indicator
              const code = obj.shortcode || obj.code;
              if (code && (obj.edge_media_preview_like || obj.like_count !== undefined || obj.caption || obj.__typename?.includes('Media'))) {
                if (!seenCodes.has(code)) { seenCodes.add(code); posts.push(obj); }
                return;
              }
              if (Array.isArray(obj)) {
                for (const item of obj) findMedia(item, depth + 1);
              } else {
                for (const val of Object.values(obj)) findMedia(val, depth + 1);
              }
            };
            findMedia(json);
          } catch {}
        }

        return posts;
      });

      // Parse raw nodes into Post objects
      return rawNodes.map((node: any) => {
        if (node.shortcode && (node.edge_media_preview_like || node.edge_liked_by)) {
          return this.parseNode(node);
        }
        if (node.code) {
          return this.parsePopularNode(node);
        }
        return this.parseMediaV1(node);
      });
    } catch {
      return [];
    }
  }

  /** Parse GraphQL node */
  private parseNode(node: any): Post {
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const hashtags = caption.match(/#[\w\u0080-\uffff]+/g) || [];
    const mentions = caption.match(/@[\w.]+/g) || [];

    let mediaType: Post['mediaType'] = 'image';
    if (node.is_video) mediaType = 'video';
    if (node.__typename === 'GraphSidecar') mediaType = 'carousel';
    if (node.product_type === 'clips') mediaType = 'reel';

    return {
      id: node.id,
      platform: 'instagram',
      shortcode: node.shortcode,
      url: `https://www.instagram.com/p/${node.shortcode}/`,
      caption,
      hashtags: hashtags.map((h: string) => h.toLowerCase()),
      mentions: mentions.map((m: string) => m.toLowerCase()),
      likesCount: node.edge_media_preview_like?.count || node.edge_liked_by?.count || 0,
      commentsCount: node.edge_media_to_comment?.count || node.edge_media_preview_comment?.count || 0,
      viewsCount: node.video_view_count,
      mediaType,
      mediaUrls: [node.display_url].filter(Boolean),
      timestamp: node.taken_at_timestamp
        ? new Date(node.taken_at_timestamp * 1000).toISOString()
        : new Date().toISOString(),
      owner: {
        username: node.owner?.username || '',
        id: node.owner?.id || '',
        fullName: node.owner?.full_name,
        profilePicUrl: node.owner?.profile_pic_url,
      },
    };
  }

  /** Parse V1 API media object */
  private parseMediaV1(media: any): Post {
    const caption = media.caption?.text || '';
    const hashtags = caption.match(/#[\w\u0080-\uffff]+/g) || [];

    let mediaType: Post['mediaType'] = 'image';
    if (media.media_type === 2) mediaType = 'video';
    if (media.media_type === 8) mediaType = 'carousel';
    if (media.product_type === 'clips') mediaType = 'reel';

    return {
      id: media.pk?.toString() || media.id || '',
      platform: 'instagram',
      shortcode: media.code,
      url: `https://www.instagram.com/p/${media.code}/`,
      caption,
      hashtags: hashtags.map((h: string) => h.toLowerCase()),
      mentions: (caption.match(/@[\w.]+/g) || []).map((m: string) => m.toLowerCase()),
      likesCount: media.like_count || 0,
      commentsCount: media.comment_count || 0,
      viewsCount: media.play_count || media.view_count,
      mediaType,
      mediaUrls: [media.image_versions2?.candidates?.[0]?.url].filter(Boolean),
      timestamp: media.taken_at
        ? new Date(media.taken_at * 1000).toISOString()
        : new Date().toISOString(),
      owner: {
        username: media.user?.username || '',
        id: media.user?.pk?.toString() || '',
        fullName: media.user?.full_name,
        profilePicUrl: media.user?.profile_pic_url,
      },
    };
  }

  /** Parse Popular/Polaris page node (2026+ format) */
  private parsePopularNode(node: any): Post {
    const caption = node.caption?.text || '';
    const hashtags = caption.match(/#[\w\u0080-\uffff]+/g) || [];
    const mentions = (caption.match(/@[\w.]+/g) || []).map((m: string) => m.toLowerCase());

    let mediaType: Post['mediaType'] = 'image';
    const typeName = node.__typename || '';
    if (typeName.includes('Video') || node.is_video || node.media_type === 2) mediaType = 'video';
    if (typeName.includes('Sidecar') || node.media_type === 8) mediaType = 'carousel';
    if (node.product_type === 'clips' || typeName.includes('Reel')) mediaType = 'reel';

    const code = node.code || node.shortcode || '';
    const takenAt = node.taken_at_timestamp || node.taken_at;

    return {
      id: node.id || node.pk?.toString() || code,
      platform: 'instagram',
      shortcode: code,
      url: `https://www.instagram.com/p/${code}/`,
      caption,
      hashtags: hashtags.map((h: string) => h.toLowerCase()),
      mentions,
      likesCount: node.like_count ?? node.edge_media_preview_like?.count ?? 0,
      commentsCount: node.comment_count ?? node.edge_media_to_comment?.count ?? 0,
      viewsCount: node.play_count || node.video_view_count || node.view_count,
      mediaType,
      mediaUrls: [node.display_url || node.thumbnail_url || node.image_versions2?.candidates?.[0]?.url].filter(Boolean),
      timestamp: takenAt
        ? new Date(takenAt * 1000).toISOString()
        : new Date().toISOString(),
      owner: {
        username: node.user?.username || node.owner?.username || '',
        id: node.user?.pk?.toString() || node.owner?.id || '',
        fullName: node.user?.full_name || node.owner?.full_name,
        profilePicUrl: node.user?.profile_pic_url || node.owner?.profile_pic_url,
      },
    };
  }

  /** Parse profile from full user object */
  private parseUserProfile(user: any): InfluencerProfile {
    const followersCount = user.edge_followed_by?.count || user.follower_count || 0;
    const recentEdges = user.edge_owner_to_timeline_media?.edges || [];

    let engagementRate: number | undefined;
    if (recentEdges.length > 0 && followersCount > 0) {
      const total = recentEdges.slice(0, 12).reduce((sum: number, e: any) => {
        const likes = e.node?.edge_media_preview_like?.count || 0;
        const comments = e.node?.edge_media_to_comment?.count || 0;
        return sum + likes + comments;
      }, 0);
      engagementRate = (total / Math.min(recentEdges.length, 12)) / followersCount * 100;
    }

    return {
      platform: 'instagram',
      id: user.id || user.pk?.toString() || '',
      username: user.username,
      fullName: user.full_name || '',
      bio: user.biography || '',
      profilePicUrl: user.profile_pic_url || '',
      profilePicUrlHD: user.profile_pic_url_hd,
      followersCount,
      followingCount: user.edge_follow?.count || user.following_count || 0,
      postsCount: user.edge_owner_to_timeline_media?.count || user.media_count || 0,
      engagementRate,
      isVerified: user.is_verified || false,
      isBusinessAccount: user.is_business_account || false,
      isPrivate: user.is_private || false,
      category: user.category_name || user.business_category_name || '',
      contactEmail: user.business_email || user.public_email,
      contactPhone: user.business_phone_number,
      externalUrl: user.external_url || '',
      recentPosts: recentEdges.slice(0, 12).map((e: any) => this.parseNode(e.node)),
      scrapedAt: new Date().toISOString(),
    };
  }

  /** Parse profile from meta tag extraction */
  private parseMetaProfile(data: any, username: string): InfluencerProfile {
    const parseCount = (str: string): number => {
      if (!str) return 0;
      const clean = str.replace(/,/g, '');
      if (clean.endsWith('K')) return parseFloat(clean) * 1000;
      if (clean.endsWith('M')) return parseFloat(clean) * 1000000;
      if (clean.endsWith('B')) return parseFloat(clean) * 1000000000;
      return parseInt(clean) || 0;
    };

    return {
      platform: 'instagram',
      id: '',
      username,
      fullName: data.title?.split('(')[0]?.trim() || '',
      bio: data.description || '',
      profilePicUrl: '',
      followersCount: parseCount(data.followers),
      followingCount: parseCount(data.following),
      postsCount: parseCount(data.posts),
      isVerified: false,
      isBusinessAccount: false,
      isPrivate: false,
      scrapedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    // Only close the browser process if we created it ourselves.
    // Shared browsers (injected via constructor) must NOT be closed here,
    // because other scrapers/jobs may still be using them.
    if (this.ownsOwnBrowser) {
      await this.browser.closeAll();
    }
    this.sessionManager.cleanup();
    logger.info('[Instagram] Scraper closed');
  }
}
