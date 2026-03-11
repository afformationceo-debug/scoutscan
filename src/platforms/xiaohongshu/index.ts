import { PlatformScraper, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from '../../core/types.js';
import { StealthBrowser, humanScroll, humanClick, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

/**
 * Xiaohongshu (RED / 小红书) Scraper
 *
 * Strategy:
 * - Browser-based ONLY (no public API, heavy anti-bot)
 * - Uses Playwright stealth with Chinese locale/timezone
 * - Intercepts XHR/fetch responses for structured data
 *
 * Key endpoints (intercepted):
 * - /api/sns/web/v1/search/notes - Search notes by keyword
 * - /api/sns/web/v1/feed - Note feed
 * - /api/sns/web/v1/user/otherinfo - User profile
 * - /api/sns/web/v1/note/info - Note details
 *
 * Anti-bot measures:
 * - X-S, X-T, X-S-Common headers (computed signatures)
 * - Shield (盾) JavaScript challenge
 * - Device fingerprinting via JS
 * - Rate limiting per IP and device
 */
export class XiaohongshuScraper implements PlatformScraper {
  readonly platform: 'xiaohongshu' = 'xiaohongshu';
  private browser: StealthBrowser;
  private proxyRouter: ProxyRouter;
  private rateLimiter: RateLimiter;
  private cookieManager: CookieManager;

  constructor(proxyUrls?: string[]) {
    this.proxyRouter = new ProxyRouter(proxyUrls);
    this.browser = new StealthBrowser(this.proxyRouter);
    this.rateLimiter = new RateLimiter('instagram');
    this.cookieManager = new CookieManager();
  }

  async *searchByHashtag(tag: string, options: SearchOptions = {}): AsyncGenerator<Post> {
    const maxResults = options.maxResults || 50;
    let yielded = 0;

    try {
      await this.browser.launch({ browserType: 'chromium', headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      const collectedPosts: Post[] = [];

      const { context } = await this.browser.createStealthContext(sessionId, {
        region: 'KR',
        proxy,
      });

      // Inject saved cookies if available
      if (this.cookieManager.hasCookies('xiaohongshu')) {
        const cookies = this.cookieManager.loadCookies('xiaohongshu');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
        logger.info(`[Xiaohongshu] Loaded ${cookies.length} saved cookies`);
      }

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true,
        interceptResponses: (url, body) => {
          if (url.includes('/api/sns/web/v1/search/notes') || url.includes('/api/sns/web/v1/feed')) {
            try {
              const data = JSON.parse(body);
              const items = data?.data?.items || data?.data?.notes || [];
              for (const item of items) {
                const note = item.note_card || item;
                if (note) {
                  collectedPosts.push(this.parseNote(note));
                }
              }
            } catch { /* parse failed */ }
          }
        },
      });

      // Navigate to search
      const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(tag)}&source=web_search_result_notes`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await randomDelay(3000, 5000);

      // Scroll to load more content
      for (let scrollCount = 0; scrollCount < Math.ceil(maxResults / 20); scrollCount++) {
        await humanScroll(page, 1000);
        await randomDelay(2000, 4000);

        // Yield collected posts
        while (collectedPosts.length > 0 && yielded < maxResults) {
          yield collectedPosts.shift()!;
          yielded++;
        }

        if (yielded >= maxResults) break;
      }

      await this.browser.closeContext(sessionId);
    } catch (error) {
      logger.error(`Xiaohongshu search failed: ${(error as Error).message}`);
    } finally {
      await this.browser.closeAll();
    }

    logger.info(`Xiaohongshu search complete: ${yielded} notes collected`);
  }

  async getProfile(userId: string, options?: ScrapingOptions): Promise<InfluencerProfile> {
    try {
      await this.browser.launch({ browserType: 'chromium', headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      let profileData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'KR', proxy });

      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          if (url.includes('/api/sns/web/v1/user/otherinfo') || url.includes('/api/sns/web/v1/user_posted')) {
            try {
              const data = JSON.parse(body);
              if (data?.data) profileData = { ...profileData, ...data.data };
            } catch {}
          }
        },
      });

      await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await randomDelay(3000, 5000);
      await simulateReading(page, 3000);

      await this.browser.closeContext(sessionId);
      await this.browser.closeAll();

      if (!profileData) {
        throw new Error(`Could not extract profile for user ${userId}`);
      }

      return this.parseProfile(profileData);
    } catch (error) {
      await this.browser.closeAll();
      throw error;
    }
  }

  private parseNote(note: any): Post {
    const title = note.title || note.display_title || '';
    const desc = note.desc || note.note_desc || '';
    const caption = title + (desc ? '\n' + desc : '');

    return {
      id: note.note_id || note.id || '',
      platform: 'xiaohongshu',
      shortcode: note.note_id,
      url: `https://www.xiaohongshu.com/explore/${note.note_id}`,
      caption,
      hashtags: (caption.match(/#[^\s#]+/g) || []).map((h: string) => h.toLowerCase()),
      mentions: (caption.match(/@[^\s@]+/g) || []).map((m: string) => m.toLowerCase()),
      likesCount: note.liked_count || note.interact_info?.liked_count || 0,
      commentsCount: note.comment_count || note.interact_info?.comment_count || 0,
      viewsCount: note.view_count,
      mediaType: note.type === 'video' ? 'video' : 'image',
      mediaUrls: (note.image_list || []).map((img: any) => img.url || img.url_default || '').filter(Boolean),
      timestamp: note.time ? new Date(note.time).toISOString() : new Date().toISOString(),
      owner: {
        username: note.user?.nickname || note.user?.nick_name || '',
        id: note.user?.user_id || note.user?.userid || '',
        fullName: note.user?.nickname,
        profilePicUrl: note.user?.avatar || note.user?.images,
      },
    };
  }

  private parseProfile(data: any): InfluencerProfile {
    return {
      platform: 'xiaohongshu',
      id: data.user_id || data.userid || '',
      username: data.nickname || data.nick_name || '',
      fullName: data.nickname || '',
      bio: data.desc || data.description || '',
      profilePicUrl: data.imageb || data.images || '',
      followersCount: parseInt(data.fans || data.fansCount || '0'),
      followingCount: parseInt(data.follows || data.followsCount || '0'),
      postsCount: parseInt(data.notes || data.noteCount || '0'),
      isVerified: data.officialVerified || false,
      isBusinessAccount: data.isEnterprise || false,
      isPrivate: false,
      category: data.tag || '',
      externalUrl: '',
      scrapedAt: new Date().toISOString(),
    };
  }
}
