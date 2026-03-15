import { PlatformScraper, Post, InfluencerProfile, SearchOptions, ScrapingOptions } from '../../core/types.js';
import { StealthBrowser, humanScroll, simulateReading } from '../../core/anti-detection/index.js';
import { ProxyRouter } from '../../core/proxy.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { logger } from '../../utils/logger.js';
import { randomDelay } from '../../utils/delay.js';
import { randomUUID } from 'crypto';

/**
 * YouTube Scraper
 *
 * Strategy: Browser + Innertube API interception
 * YouTube uses the internal "Innertube" API at /youtubei/v1/*
 * with a complex client context and PoToken requirement.
 *
 * Browser-based approach intercepts these API responses while
 * navigating the YouTube web interface with a real browser.
 *
 * Key intercepted endpoints:
 * - /youtubei/v1/search - Search results
 * - /youtubei/v1/browse - Channel/playlist pages
 * - /youtubei/v1/next - Related videos, comments
 */
export class YouTubeScraper implements PlatformScraper {
  readonly platform = 'youtube' as const;
  private browser: StealthBrowser;
  private proxyRouter: ProxyRouter;
  private rateLimiter: RateLimiter;

  constructor(proxyUrls?: string[]) {
    this.proxyRouter = new ProxyRouter(proxyUrls);
    this.browser = new StealthBrowser(this.proxyRouter);
    this.rateLimiter = new RateLimiter('youtube');
  }

  async *searchByHashtag(tag: string, options: SearchOptions = {}): AsyncGenerator<Post> {
    const cleanTag = tag.replace(/^#/, '');
    const maxResults = options.maxResults || 50;
    const until = options.until || null;
    const since = options.since || null;
    let yielded = 0;
    let consecutiveOld = 0;
    let interceptedCount = 0;

    logger.info(`[YouTube] Searching: ${cleanTag}`, { maxResults });

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      const collectedPosts: Post[] = [];

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      const page = await this.browser.createPage(sessionId, {
        blockFonts: true,
        interceptResponses: (url, body) => {
          if (url.includes('/youtubei/v1/search') || url.includes('/results')) {
            interceptedCount++;
            const before = collectedPosts.length;
            this.extractVideos(body, collectedPosts);
            const extracted = collectedPosts.length - before;
            if (extracted > 0) {
              logger.info(`[YouTube] Intercepted ${extracted} videos from: ${url.split('?')[0].slice(-60)}`);
            }
          }
        },
      });

      // Navigate to YouTube keyword search (NOT hashtag search)
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTag)}`;
      logger.info(`[YouTube] Search URL: ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await randomDelay(4000, 6000);

      // Log page info for debugging
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => 'unknown');
      logger.info(`[YouTube] Page loaded. URL: ${currentUrl}, Title: "${pageTitle}"`);

      // Try to dismiss consent dialog
      try {
        const consentBtn = await page.$('button[aria-label*="Accept"], tp-yt-paper-button.ytd-consent-bump-v2-lightbox');
        if (consentBtn) {
          await consentBtn.click();
          logger.info(`[YouTube] Dismissed consent dialog`);
        }
        await randomDelay(1000, 2000);
      } catch {}

      // Extract from initial page data (ytInitialData)
      const embedded = await this.extractEmbeddedSearchResults(page);
      for (const post of embedded) {
        collectedPosts.push(post);
      }

      // Fallback: DOM-based extraction if embedded data yields nothing
      if (collectedPosts.length === 0) {
        logger.info(`[YouTube] No embedded data found, trying DOM extraction...`);
        const domVideos = await this.extractVideosFromDOM(page);
        for (const post of domVideos) {
          collectedPosts.push(post);
        }
        logger.info(`[YouTube] DOM extraction found ${domVideos.length} videos`);
      } else {
        logger.info(`[YouTube] Embedded data: ${collectedPosts.length} videos`);
      }

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
        if (i > 3 && collectedPosts.length === 0) break;
      }

      await this.browser.closeContext(sessionId);
    } catch (error) {
      logger.error(`[YouTube] Search failed: ${(error as Error).message}`);
    } finally {
      await this.browser.closeAll();
    }

    logger.info(`[YouTube] Search complete. Total: ${yielded} videos (intercepted ${interceptedCount} API responses)`);
  }

  async getProfile(channelHandle: string, options?: ScrapingOptions): Promise<InfluencerProfile> {
    const cleanHandle = channelHandle.replace(/^@/, '');
    logger.info(`[YouTube] Fetching channel: @${cleanHandle}`);

    try {
      await this.browser.launch({ headless: true });
      const sessionId = randomUUID();
      const proxy = this.proxyRouter.getRotatingProxy();

      let channelData: any = null;

      await this.browser.createStealthContext(sessionId, { region: 'US', proxy });

      const page = await this.browser.createPage(sessionId, {
        interceptResponses: (url, body) => {
          if (url.includes('/youtubei/v1/browse') || url.includes('/channel/') || url.includes('/@')) {
            try {
              const data = JSON.parse(body);
              if (data?.header || data?.metadata) {
                channelData = data;
              }
            } catch {}
          }
        },
      });

      // Try @handle URL first, then channel URL
      await page.goto(`https://www.youtube.com/@${cleanHandle}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await randomDelay(4000, 6000);

      // Try consent dialog
      try {
        const consentBtn = await page.$('button[aria-label*="Accept"]');
        if (consentBtn) await consentBtn.click();
        await randomDelay(1000, 2000);
      } catch {}

      // Extract from page embedded data
      if (!channelData) {
        channelData = await page.evaluate(() => {
          // ytInitialData
          const ytData = (window as any).ytInitialData;
          if (ytData) return ytData;

          // JSON-LD
          const jsonLd = document.querySelector('script[type="application/ld+json"]');
          if (jsonLd) {
            try { return { _jsonLd: true, ...JSON.parse(jsonLd.textContent || '') }; } catch {}
          }

          // Meta tags
          const channelName = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
          const desc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
          const url = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
          if (channelName) {
            return { _meta: true, name: channelName, description: desc, url };
          }
          return null;
        });
      }

      await this.browser.closeContext(sessionId);
      await this.browser.closeAll();

      if (!channelData) {
        throw new Error(`Could not extract YouTube channel data for @${cleanHandle}`);
      }

      return this.parseChannel(channelData, cleanHandle);
    } catch (error) {
      await this.browser.closeAll();
      throw error;
    }
  }

  /** Extract videos from Innertube API response */
  private extractVideos(body: string, posts: Post[]): void {
    try {
      const data = JSON.parse(body);

      const findVideoRenderers = (obj: any, depth = 0): void => {
        if (depth > 10 || !obj || typeof obj !== 'object') return;

        if (obj.videoRenderer) {
          posts.push(this.parseVideoRenderer(obj.videoRenderer));
          return;
        }
        if (obj.richItemRenderer?.content?.videoRenderer) {
          posts.push(this.parseVideoRenderer(obj.richItemRenderer.content.videoRenderer));
          return;
        }

        if (Array.isArray(obj)) {
          for (const item of obj) findVideoRenderers(item, depth + 1);
        } else {
          for (const val of Object.values(obj)) findVideoRenderers(val, depth + 1);
        }
      };

      findVideoRenderers(data);
    } catch {}
  }

  /** Extract initial search results from embedded page data */
  private async extractEmbeddedSearchResults(page: any): Promise<Post[]> {
    try {
      const items = await page.evaluate(() => {
        const ytData = (window as any).ytInitialData;
        if (!ytData) return [];

        const results: any[] = [];
        const contents = ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents || [];

        for (const section of contents) {
          const items = section?.itemSectionRenderer?.contents || [];
          for (const item of items) {
            if (item.videoRenderer) {
              results.push(item.videoRenderer);
            }
          }
        }
        return results;
      });

      return (items || []).map((r: any) => this.parseVideoRenderer(r));
    } catch {
      return [];
    }
  }

  /** Parse YouTube videoRenderer object */
  private parseVideoRenderer(renderer: any): Post {
    const title = renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || '';
    const viewCountText = renderer.viewCountText?.simpleText || renderer.viewCountText?.runs?.[0]?.text || '0';
    const viewCount = parseInt(viewCountText.replace(/[^0-9]/g, '')) || 0;

    const channelName = renderer.ownerText?.runs?.[0]?.text
      || renderer.longBylineText?.runs?.[0]?.text || '';
    const channelUrl = renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    const channelId = renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';

    return {
      id: renderer.videoId || '',
      platform: 'youtube',
      url: `https://www.youtube.com/watch?v=${renderer.videoId || ''}`,
      caption: title,
      hashtags: (title.match(/#[\w\u0080-\uffff]+/g) || []).map((h: string) => h.toLowerCase()),
      mentions: [],
      likesCount: 0, // Not available in search results
      commentsCount: 0,
      viewsCount: viewCount,
      mediaType: 'video',
      mediaUrls: renderer.thumbnail?.thumbnails?.map((t: any) => t.url) || [],
      timestamp: renderer.publishedTimeText?.simpleText || new Date().toISOString(),
      owner: {
        username: channelUrl.replace(/^\/@/, '') || channelName,
        id: channelId,
        fullName: channelName,
        profilePicUrl: renderer.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer
          ?.thumbnail?.thumbnails?.[0]?.url || '',
      },
    };
  }

  /** Parse channel data into profile format */
  private parseChannel(data: any, handle: string): InfluencerProfile {
    if (data._jsonLd) {
      return {
        platform: 'youtube',
        id: handle,
        username: handle,
        fullName: data.name || '',
        bio: data.description || '',
        profilePicUrl: data.image || '',
        followersCount: parseInt(data.interactionStatistic?.find?.((s: any) =>
          s.interactionType?.includes('Subscribe'))?.userInteractionCount) || 0,
        followingCount: 0,
        postsCount: 0,
        isVerified: false,
        isBusinessAccount: false,
        isPrivate: false,
        scrapedAt: new Date().toISOString(),
      };
    }

    if (data._meta) {
      return {
        platform: 'youtube',
        id: handle,
        username: handle,
        fullName: data.name || '',
        bio: data.description || '',
        profilePicUrl: '',
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isVerified: false,
        isBusinessAccount: false,
        isPrivate: false,
        externalUrl: data.url || '',
        scrapedAt: new Date().toISOString(),
      };
    }

    // ytInitialData format
    const header = data.header?.c4TabbedHeaderRenderer
      || data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
      || {};

    const metadata = data.metadata?.channelMetadataRenderer || {};

    const subCountText = header.subscriberCountText?.simpleText
      || header.metadata?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '0';
    const subCount = this.parseSubscriberCount(subCountText);

    const videoCountText = header.videosCountText?.runs?.[0]?.text || '0';
    const videoCount = parseInt(videoCountText.replace(/[^0-9]/g, '')) || 0;

    return {
      platform: 'youtube',
      id: metadata.externalId || header.channelId || '',
      username: metadata.vanityChannelUrl?.split('/').pop() || handle,
      fullName: metadata.title || header.title || '',
      bio: metadata.description || '',
      profilePicUrl: header.avatar?.thumbnails?.slice(-1)?.[0]?.url
        || metadata.avatar?.thumbnails?.[0]?.url || '',
      followersCount: subCount,
      followingCount: 0,
      postsCount: videoCount,
      isVerified: header.badges?.some((b: any) =>
        b.metadataBadgeRenderer?.style?.includes('VERIFIED')) || false,
      isBusinessAccount: false,
      isPrivate: false,
      category: metadata.keywords || '',
      externalUrl: metadata.channelUrl || '',
      scrapedAt: new Date().toISOString(),
    };
  }

  /** Extract videos from rendered DOM (fallback when ytInitialData is unavailable) */
  private async extractVideosFromDOM(page: any): Promise<Post[]> {
    try {
      const items = await page.evaluate(() => {
        const results: any[] = [];
        // ytd-video-renderer is the standard search result component
        const renderers = document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer');
        renderers.forEach((el: Element) => {
          try {
            const titleEl = el.querySelector('#video-title, a#video-title-link');
            const title = titleEl?.textContent?.trim() || '';
            const href = titleEl?.getAttribute('href') || '';
            const videoId = href.match(/[?&]v=([^&]+)/)?.[1] || href.match(/\/shorts\/([^?]+)/)?.[1] || '';

            const channelEl = el.querySelector('ytd-channel-name a, #channel-info a, .ytd-channel-name a');
            const channelName = channelEl?.textContent?.trim() || '';
            const channelUrl = channelEl?.getAttribute('href') || '';

            const viewsEl = el.querySelector('#metadata-line span, .inline-metadata-item');
            const viewsText = viewsEl?.textContent || '0';
            const viewCount = parseInt(viewsText.replace(/[^0-9]/g, '')) || 0;

            if (videoId) {
              results.push({ videoId, title, channelName, channelUrl, viewCount });
            }
          } catch {}
        });

        // Also extract from links
        if (results.length === 0) {
          const links = document.querySelectorAll('a[href*="watch?v="]');
          const seen = new Set<string>();
          links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/[?&]v=([^&]+)/);
            if (match && !seen.has(match[1])) {
              seen.add(match[1]);
              results.push({ videoId: match[1], title: a.textContent?.trim() || '', channelName: '', channelUrl: '', viewCount: 0 });
            }
          });
        }

        return results;
      });

      return items.map((item: any) => ({
        id: item.videoId,
        platform: 'youtube' as const,
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
        caption: item.title,
        hashtags: (item.title.match(/#[\w\u0080-\uffff]+/g) || []).map((h: string) => h.toLowerCase()),
        mentions: [],
        likesCount: 0,
        commentsCount: 0,
        viewsCount: item.viewCount,
        mediaType: 'video' as const,
        mediaUrls: [],
        timestamp: new Date().toISOString(),
        owner: {
          username: item.channelUrl?.replace(/^\/@/, '') || item.channelName,
          id: '',
          fullName: item.channelName,
          profilePicUrl: '',
        },
      }));
    } catch (err) {
      logger.warn(`[YouTube] DOM extraction failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Parse subscriber count text like "1.2M subscribers" */
  private parseSubscriberCount(text: string): number {
    if (!text) return 0;
    const clean = text.replace(/subscribers?/i, '').trim();
    if (clean.endsWith('K')) return parseFloat(clean) * 1000;
    if (clean.endsWith('M')) return parseFloat(clean) * 1000000;
    if (clean.endsWith('B')) return parseFloat(clean) * 1000000000;
    return parseInt(clean.replace(/[^0-9]/g, '')) || 0;
  }

  async close(): Promise<void> {
    await this.browser.closeAll();
  }
}
