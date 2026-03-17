import { PlatformScraper, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from '../../core/types.js';
import { StealthBrowser, humanScroll, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

/**
 * LinkedIn Scraper
 *
 * Strategy:
 * - Browser-based with stealth (LinkedIn has extremely aggressive bot detection)
 * - Must use residential/ISP proxies (datacenter IPs are blocked)
 * - Public profile pages are accessible without login
 * - Login-based scraping enables full data access but risks account bans
 *
 * Anti-bot measures:
 * - Aggressive IP fingerprinting (blocks all datacenter ranges)
 * - Device fingerprinting via LinkedIn Pixel
 * - Rate limiting per session and IP
 * - CAPTCHA challenges (text-based)
 * - JavaScript obfuscation and challenge pages
 *
 * Key data endpoints (intercepted from browser):
 * - /voyager/api/identity/profiles/{username} - Profile data
 * - /voyager/api/search/blended - Search results
 * - /voyager/api/feed/updates - Feed posts
 */
export class LinkedInScraper implements PlatformScraper {
  readonly platform: 'linkedin' = 'linkedin';
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
    const maxResults = options.maxResults || 30;
    const until = options.until || null;
    let yielded = 0;

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getProxyForPlatform('linkedin');

      const collectedPosts: Post[] = [];

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      // Inject saved cookies if available
      if (this.cookieManager.hasCookies('linkedin')) {
        const cookies = this.cookieManager.loadCookies('linkedin');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
        logger.info(`[LinkedIn] Loaded ${cookies.length} saved cookies`);
      }

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true,
        interceptResponses: (url, body) => {
          if (url.includes('/voyager/api/feed/') || url.includes('/voyager/api/search/')) {
            try {
              const data = JSON.parse(body);
              const elements = data?.data?.data?.searchDashClustersByAll?.elements
                || data?.included
                || [];
              for (const item of elements) {
                if (item.$type === 'com.linkedin.voyager.feed.render.UpdateV2' || item.updateMetadata) {
                  collectedPosts.push(this.parseLinkedInPost(item));
                }
              }
            } catch {}
          }
        },
      });

      // LinkedIn hashtag feed URL
      const searchUrl = `https://www.linkedin.com/feed/hashtag/${encodeURIComponent(tag.replace(/^#/, ''))}/`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await randomDelay(3000, 6000);

      // Scroll to load posts
      for (let i = 0; i < Math.ceil(maxResults / 10); i++) {
        await humanScroll(page, 1200);
        await randomDelay(3000, 6000);

        while (collectedPosts.length > 0 && yielded < maxResults) {
          const post = collectedPosts.shift()!;
          if (until && post.timestamp && post.timestamp > until) {
            continue;
          }
          yield post;
          yielded++;
        }

        if (yielded >= maxResults) break;
      }

      await this.browser.closeContext(sessionId);
    } catch (error) {
      logger.error(`LinkedIn search failed: ${(error as Error).message}`);
    } finally {
      await this.browser.closeAll();
    }
  }

  async getProfile(username: string, options?: ScrapingOptions): Promise<InfluencerProfile> {
    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getProxyForPlatform('linkedin');

      let profileData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true, blockImages: true, blockFonts: true,
        interceptResponses: (url, body) => {
          if (url.includes('/voyager/api/identity/profiles/') || url.includes('/identity/dash/profiles')) {
            try {
              const data = JSON.parse(body);
              profileData = data;
            } catch {}
          }
        },
      });

      await page.goto(`https://www.linkedin.com/in/${username}/`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await randomDelay(3000, 5000);
      await simulateReading(page, 4000);

      // Also try to extract from page HTML (for public profiles)
      if (!profileData) {
        profileData = await page.evaluate(() => {
          // LinkedIn embeds JSON-LD
          const scripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of scripts) {
            try {
              const data = JSON.parse(script.textContent || '');
              if (data['@type'] === 'Person') return data;
            } catch {}
          }
          return null;
        });
      }

      await this.browser.closeContext(sessionId);
      await this.browser.closeAll();

      if (!profileData) {
        throw new Error(`Could not extract LinkedIn profile for ${username}`);
      }

      return this.parseProfile(profileData, username);
    } catch (error) {
      await this.browser.closeAll();
      throw error;
    }
  }

  private parseLinkedInPost(item: any): Post {
    const commentary = item.commentary?.text?.text
      || item.actor?.subDescription?.text
      || '';

    return {
      id: item.urn || item.entityUrn || '',
      platform: 'linkedin',
      url: `https://www.linkedin.com/feed/update/${item.urn || ''}`,
      caption: commentary,
      hashtags: (commentary.match(/#[\w]+/g) || []).map((h: string) => h.toLowerCase()),
      mentions: (commentary.match(/@[\w\s]+/g) || []).map((m: string) => m.trim().toLowerCase()),
      likesCount: item.socialDetail?.totalSocialActivityCounts?.numLikes || 0,
      commentsCount: item.socialDetail?.totalSocialActivityCounts?.numComments || 0,
      viewsCount: item.socialDetail?.totalSocialActivityCounts?.numImpressions,
      mediaType: 'image',
      mediaUrls: [],
      timestamp: item.actor?.subDescription?.text || new Date().toISOString(),
      owner: {
        username: item.actor?.name?.text || '',
        id: item.actor?.urn || '',
        fullName: item.actor?.name?.text,
        profilePicUrl: item.actor?.image?.rootUrl,
      },
    };
  }

  private parseProfile(data: any, username: string): InfluencerProfile {
    // Handle JSON-LD format
    if (data['@type'] === 'Person') {
      return {
        platform: 'linkedin',
        id: username,
        username,
        fullName: data.name || '',
        bio: data.description || data.jobTitle?.join(', ') || '',
        profilePicUrl: data.image?.contentUrl || '',
        followersCount: 0, // Not available in JSON-LD
        followingCount: 0,
        postsCount: 0,
        isVerified: false,
        isBusinessAccount: false,
        isPrivate: false,
        category: data.jobTitle?.[0] || '',
        externalUrl: data.url || '',
        scrapedAt: new Date().toISOString(),
      };
    }

    // Handle Voyager API format
    const profile = data?.data || data?.included?.[0] || data;
    return {
      platform: 'linkedin',
      id: profile.entityUrn || profile.publicIdentifier || username,
      username: profile.publicIdentifier || username,
      fullName: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
      bio: profile.headline || profile.summary || '',
      profilePicUrl: profile.profilePicture?.displayImageReference?.vectorImage?.rootUrl || '',
      followersCount: profile.followersCount || profile.followerCount || 0,
      followingCount: profile.connectionsCount || 0,
      postsCount: 0,
      isVerified: profile.isOpenToWork || false,
      isBusinessAccount: false,
      isPrivate: false,
      category: profile.industryName || profile.headline || '',
      externalUrl: profile.websites?.[0]?.url || '',
      scrapedAt: new Date().toISOString(),
    };
  }
}
