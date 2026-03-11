import { Post, InfluencerProfile } from '../../core/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Apify Reference Client
 * Uses Apify's Instagram actors as a reference/fallback data source
 * Useful for benchmarking our own scraper against Apify's results
 */
export class ApifyReference {
  private apiKey: string;
  private baseUrl = 'https://api.apify.com/v2';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /** Run Apify Instagram Hashtag Scraper actor */
  async searchHashtag(tag: string, maxResults = 100): Promise<Post[]> {
    const cleanTag = tag.replace(/^#/, '');

    try {
      // Start the actor run
      const runResponse = await fetch(
        `${this.baseUrl}/acts/apify~instagram-hashtag-scraper/runs?token=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hashtags: [cleanTag],
            resultsLimit: maxResults,
            searchType: 'hashtag',
          }),
        }
      );

      if (!runResponse.ok) {
        throw new Error(`Apify run failed: ${runResponse.status}`);
      }

      const run = await runResponse.json();
      const runId = run.data?.id;
      if (!runId) throw new Error('No run ID returned');

      logger.info(`Apify run started: ${runId}`);

      // Poll for completion
      let status = 'RUNNING';
      while (status === 'RUNNING' || status === 'READY') {
        await new Promise(resolve => setTimeout(resolve, 5000));

        const statusResponse = await fetch(
          `${this.baseUrl}/actor-runs/${runId}?token=${this.apiKey}`
        );
        const statusData = await statusResponse.json();
        status = statusData.data?.status;
        logger.debug(`Apify run status: ${status}`);
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run ended with status: ${status}`);
      }

      // Get results
      const datasetId = run.data?.defaultDatasetId;
      const resultsResponse = await fetch(
        `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiKey}&format=json`
      );

      const items = await resultsResponse.json();

      return items.map((item: any) => this.mapApifyPostToPost(item));
    } catch (error) {
      logger.error(`Apify reference search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** Run Apify Instagram Profile Scraper actor */
  async getProfile(username: string): Promise<InfluencerProfile | null> {
    try {
      const runResponse = await fetch(
        `${this.baseUrl}/acts/apify~instagram-scraper/runs?token=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directUrls: [`https://www.instagram.com/${username}/`],
            resultsType: 'details',
            resultsLimit: 1,
          }),
        }
      );

      if (!runResponse.ok) throw new Error(`Apify run failed: ${runResponse.status}`);

      const run = await runResponse.json();
      const runId = run.data?.id;
      if (!runId) throw new Error('No run ID returned');

      // Poll for completion
      let status = 'RUNNING';
      while (status === 'RUNNING' || status === 'READY') {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const statusResponse = await fetch(
          `${this.baseUrl}/actor-runs/${runId}?token=${this.apiKey}`
        );
        const statusData = await statusResponse.json();
        status = statusData.data?.status;
      }

      if (status !== 'SUCCEEDED') return null;

      const datasetId = run.data?.defaultDatasetId;
      const resultsResponse = await fetch(
        `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiKey}&format=json`
      );

      const items = await resultsResponse.json();
      if (!items.length) return null;

      return this.mapApifyProfileToProfile(items[0]);
    } catch (error) {
      logger.error(`Apify profile fetch failed: ${(error as Error).message}`);
      return null;
    }
  }

  private mapApifyPostToPost(item: any): Post {
    return {
      id: item.id || '',
      platform: 'instagram',
      shortcode: item.shortCode || item.shortcode,
      url: item.url || `https://www.instagram.com/p/${item.shortCode}/`,
      caption: item.caption || '',
      hashtags: item.hashtags || [],
      mentions: item.mentions || [],
      likesCount: item.likesCount || 0,
      commentsCount: item.commentsCount || 0,
      viewsCount: item.videoViewCount,
      mediaType: item.type === 'Video' ? 'video' : item.type === 'Sidecar' ? 'carousel' : 'image',
      mediaUrls: [item.displayUrl || item.imageUrl].filter(Boolean),
      timestamp: item.timestamp || new Date().toISOString(),
      owner: {
        username: item.ownerUsername || '',
        id: item.ownerId || '',
        fullName: item.ownerFullName,
        profilePicUrl: undefined,
      },
    };
  }

  private mapApifyProfileToProfile(item: any): InfluencerProfile {
    return {
      platform: 'instagram',
      id: item.id || '',
      username: item.username || '',
      fullName: item.fullName || '',
      bio: item.biography || '',
      profilePicUrl: item.profilePicUrl || '',
      profilePicUrlHD: item.profilePicUrlHD,
      followersCount: item.followersCount || 0,
      followingCount: item.followsCount || item.followingCount || 0,
      postsCount: item.postsCount || 0,
      engagementRate: undefined,
      isVerified: item.verified || false,
      isBusinessAccount: item.isBusinessAccount || false,
      isPrivate: item.private || false,
      category: item.businessCategoryName,
      externalUrl: item.externalUrl,
      scrapedAt: new Date().toISOString(),
    };
  }
}
