import { INSTAGRAM_BASE_URL, INSTAGRAM_GRAPHQL_URL, INSTAGRAM_API_V1_URL, QUERY_HASHES, DOC_IDS } from './constants.js';
import { generateWebHeaders } from '../../utils/headers.js';
import { logger } from '../../utils/logger.js';
import { Post, InfluencerProfile, HashtagInfo } from '../../core/types.js';

interface GraphQLResponse {
  data: any;
  status: string;
}

/**
 * Instagram API Client
 * Handles GraphQL and REST API communication with anti-detection headers
 */
export class InstagramAPI {
  private csrfToken: string | null = null;
  private cookies: Record<string, string> = {};
  private headers: Record<string, string>;

  constructor() {
    this.headers = generateWebHeaders();
  }

  /** Initialize session by visiting Instagram homepage to get cookies/CSRF */
  async initSession(): Promise<void> {
    try {
      const response = await fetch(INSTAGRAM_BASE_URL, {
        headers: {
          'User-Agent': this.headers['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });

      // Extract cookies from response
      const setCookieHeaders = response.headers.getSetCookie?.() || [];
      for (const cookieStr of setCookieHeaders) {
        const [nameValue] = cookieStr.split(';');
        const [name, value] = nameValue.split('=');
        if (name && value) {
          this.cookies[name.trim()] = value.trim();
        }
      }

      // Extract CSRF token
      if (this.cookies['csrftoken']) {
        this.csrfToken = this.cookies['csrftoken'];
        this.headers = generateWebHeaders(this.csrfToken);
      }

      // Also try to extract from page content
      const html = await response.text();
      const csrfMatch = html.match(/"csrf_token":"([^"]+)"/);
      if (csrfMatch && !this.csrfToken) {
        this.csrfToken = csrfMatch[1];
        this.headers = generateWebHeaders(this.csrfToken);
      }

      logger.info('Instagram session initialized', {
        hasCsrf: !!this.csrfToken,
        cookieCount: Object.keys(this.cookies).length,
      });
    } catch (error) {
      logger.error('Failed to initialize Instagram session', { error: (error as Error).message });
      throw error;
    }
  }

  /** Build cookie header string */
  private getCookieString(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** Make authenticated API request */
  private async apiRequest(url: string, params?: Record<string, string>): Promise<any> {
    const fullUrl = params
      ? `${url}?${new URLSearchParams(params).toString()}`
      : url;

    const response = await fetch(fullUrl, {
      headers: {
        ...this.headers,
        'Cookie': this.getCookieString(),
        'Referer': INSTAGRAM_BASE_URL + '/',
        'Origin': INSTAGRAM_BASE_URL,
      },
    });

    // Update cookies from response
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    for (const cookieStr of setCookieHeaders) {
      const [nameValue] = cookieStr.split(';');
      const [name, value] = nameValue.split('=');
      if (name && value) {
        this.cookies[name.trim()] = value.trim();
      }
    }

    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('AUTH_REQUIRED');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  /** GraphQL query */
  private async graphqlQuery(queryHash: string, variables: Record<string, any>): Promise<any> {
    return this.apiRequest(INSTAGRAM_GRAPHQL_URL, {
      query_hash: queryHash,
      variables: JSON.stringify(variables),
    });
  }

  /** Search posts by hashtag via GraphQL */
  async searchHashtag(
    tag: string,
    first = 50,
    after?: string
  ): Promise<{ posts: Post[]; hasNextPage: boolean; endCursor?: string; hashtagInfo?: HashtagInfo }> {
    const cleanTag = tag.replace(/^#/, '');

    try {
      const data = await this.graphqlQuery(QUERY_HASHES.hashtagPosts, {
        tag_name: cleanTag,
        first,
        after: after || '',
      });

      const hashtag = data?.data?.hashtag;
      if (!hashtag) {
        // Try alternative endpoint
        return this.searchHashtagV2(cleanTag, first, after);
      }

      const edges = hashtag.edge_hashtag_to_media?.edges || [];
      const pageInfo = hashtag.edge_hashtag_to_media?.page_info || {};

      const posts: Post[] = edges.map((edge: any) => this.parsePostNode(edge.node));

      const hashtagInfo: HashtagInfo = {
        name: cleanTag,
        postsCount: hashtag.edge_hashtag_to_media?.count || 0,
        profilePicUrl: hashtag.profile_pic_url,
        topPosts: (hashtag.edge_hashtag_to_top_posts?.edges || [])
          .slice(0, 9)
          .map((e: any) => this.parsePostNode(e.node)),
      };

      return {
        posts,
        hasNextPage: pageInfo.has_next_page || false,
        endCursor: pageInfo.end_cursor,
        hashtagInfo,
      };
    } catch (error) {
      if ((error as Error).message === 'RATE_LIMITED') throw error;
      logger.warn(`GraphQL hashtag search failed, trying V2: ${(error as Error).message}`);
      return this.searchHashtagV2(cleanTag, first, after);
    }
  }

  /** Alternative hashtag search using web endpoint */
  private async searchHashtagV2(
    tag: string,
    first: number,
    after?: string
  ): Promise<{ posts: Post[]; hasNextPage: boolean; endCursor?: string }> {
    try {
      const url = `${INSTAGRAM_BASE_URL}/explore/tags/${encodeURIComponent(tag)}/`;
      const params: Record<string, string> = { __a: '1', __d: 'dis' };
      if (after) params.max_id = after;

      const data = await this.apiRequest(url, params);

      const sections = data?.data?.recent?.sections || data?.sections || [];
      const posts: Post[] = [];

      for (const section of sections) {
        const medias = section.layout_content?.medias || [];
        for (const mediaItem of medias) {
          const media = mediaItem.media;
          if (media) {
            posts.push(this.parseMediaItem(media));
          }
        }
      }

      return {
        posts,
        hasNextPage: !!data?.data?.recent?.more_available || !!data?.more_available,
        endCursor: data?.data?.recent?.next_max_id || data?.next_max_id,
      };
    } catch (error) {
      logger.error(`Hashtag V2 search failed: ${(error as Error).message}`);
      return { posts: [], hasNextPage: false };
    }
  }

  /** Get user profile information */
  async getProfile(username: string): Promise<InfluencerProfile> {
    try {
      // Try web_profile_info endpoint first
      const data = await this.apiRequest(
        `${INSTAGRAM_API_V1_URL}/users/web_profile_info/`,
        { username }
      );

      const user = data?.data?.user;
      if (user) return this.parseUserProfile(user);

      // Fallback to GraphQL
      return this.getProfileGraphQL(username);
    } catch (error) {
      if ((error as Error).message === 'RATE_LIMITED') throw error;
      logger.warn(`Profile API failed, trying GraphQL: ${(error as Error).message}`);
      return this.getProfileGraphQL(username);
    }
  }

  /** Get profile via GraphQL */
  private async getProfileGraphQL(username: string): Promise<InfluencerProfile> {
    try {
      const data = await this.graphqlQuery(QUERY_HASHES.userInfo, {
        username,
        include_reel: true,
      });

      const user = data?.data?.user;
      if (!user) {
        // Final fallback: scrape the profile page JSON
        return this.getProfileFromPage(username);
      }

      return this.parseUserProfile(user);
    } catch (error) {
      logger.warn(`GraphQL profile failed: ${(error as Error).message}`);
      return this.getProfileFromPage(username);
    }
  }

  /** Scrape profile from page embedded JSON */
  private async getProfileFromPage(username: string): Promise<InfluencerProfile> {
    const url = `${INSTAGRAM_BASE_URL}/${username}/`;
    const response = await fetch(url, {
      headers: {
        ...this.headers,
        'Cookie': this.getCookieString(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const html = await response.text();

    // Try to extract shared data
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});<\/script>/);
    if (sharedDataMatch) {
      const sharedData = JSON.parse(sharedDataMatch[1]);
      const user = sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      if (user) return this.parseUserProfile(user);
    }

    // Try additional data patterns
    const additionalDataMatch = html.match(/"user":\s*({[^}]+(?:{[^}]*}[^}]*)*})/);
    if (additionalDataMatch) {
      try {
        const user = JSON.parse(additionalDataMatch[1]);
        return this.parseUserProfile(user);
      } catch { /* parse failed */ }
    }

    throw new Error(`Could not extract profile data for @${username}`);
  }

  /** Get user's recent posts */
  async getUserPosts(userId: string, first = 12, after?: string): Promise<{ posts: Post[]; hasNextPage: boolean; endCursor?: string }> {
    const data = await this.graphqlQuery(QUERY_HASHES.userMedia, {
      id: userId,
      first,
      after: after || '',
    });

    const timeline = data?.data?.user?.edge_owner_to_timeline_media;
    if (!timeline) return { posts: [], hasNextPage: false };

    const posts: Post[] = (timeline.edges || []).map((edge: any) => this.parsePostNode(edge.node));

    return {
      posts,
      hasNextPage: timeline.page_info?.has_next_page || false,
      endCursor: timeline.page_info?.end_cursor,
    };
  }

  /** Parse a GraphQL post node into our Post type */
  private parsePostNode(node: any): Post {
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const hashtags = caption.match(/#[\w\u0080-\uffff]+/g) || [];
    const mentions = caption.match(/@[\w.]+/g) || [];

    let mediaType: Post['mediaType'] = 'image';
    if (node.is_video) mediaType = 'video';
    if (node.__typename === 'GraphSidecar') mediaType = 'carousel';
    if (node.product_type === 'clips') mediaType = 'reel';

    const mediaUrls: string[] = [];
    if (node.display_url) mediaUrls.push(node.display_url);
    if (node.edge_sidecar_to_children?.edges) {
      for (const child of node.edge_sidecar_to_children.edges) {
        if (child.node.display_url) mediaUrls.push(child.node.display_url);
      }
    }

    return {
      id: node.id,
      platform: 'instagram',
      shortcode: node.shortcode,
      url: `${INSTAGRAM_BASE_URL}/p/${node.shortcode}/`,
      caption,
      hashtags: hashtags.map((h: string) => h.toLowerCase()),
      mentions: mentions.map((m: string) => m.toLowerCase()),
      likesCount: node.edge_media_preview_like?.count || node.edge_liked_by?.count || node.like_count || 0,
      commentsCount: node.edge_media_to_comment?.count || node.edge_media_preview_comment?.count || node.comment_count || 0,
      viewsCount: node.video_view_count,
      mediaType,
      mediaUrls,
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

  /** Parse media item from V1 API response */
  private parseMediaItem(media: any): Post {
    const caption = media.caption?.text || '';
    const hashtags = caption.match(/#[\w\u0080-\uffff]+/g) || [];
    const mentions = caption.match(/@[\w.]+/g) || [];

    let mediaType: Post['mediaType'] = 'image';
    if (media.media_type === 2) mediaType = 'video';
    if (media.media_type === 8) mediaType = 'carousel';
    if (media.product_type === 'clips') mediaType = 'reel';

    const mediaUrls: string[] = [];
    if (media.image_versions2?.candidates?.[0]?.url) {
      mediaUrls.push(media.image_versions2.candidates[0].url);
    }
    if (media.carousel_media) {
      for (const item of media.carousel_media) {
        if (item.image_versions2?.candidates?.[0]?.url) {
          mediaUrls.push(item.image_versions2.candidates[0].url);
        }
      }
    }

    return {
      id: media.pk?.toString() || media.id,
      platform: 'instagram',
      shortcode: media.code,
      url: `${INSTAGRAM_BASE_URL}/p/${media.code}/`,
      caption,
      hashtags: hashtags.map((h: string) => h.toLowerCase()),
      mentions: mentions.map((m: string) => m.toLowerCase()),
      likesCount: media.like_count || 0,
      commentsCount: media.comment_count || 0,
      viewsCount: media.play_count || media.view_count,
      mediaType,
      mediaUrls,
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

  /** Parse user data into InfluencerProfile */
  private parseUserProfile(user: any): InfluencerProfile {
    const followersCount = user.edge_followed_by?.count || user.follower_count || 0;
    const postsCount = user.edge_owner_to_timeline_media?.count || user.media_count || 0;

    // Calculate engagement rate from recent posts
    let engagementRate: number | undefined;
    const recentEdges = user.edge_owner_to_timeline_media?.edges || user.edge_felix_video_timeline?.edges || [];
    if (recentEdges.length > 0 && followersCount > 0) {
      const totalEngagement = recentEdges.slice(0, 12).reduce((sum: number, edge: any) => {
        const node = edge.node;
        const likes = node.edge_media_preview_like?.count || node.edge_liked_by?.count || 0;
        const comments = node.edge_media_to_comment?.count || 0;
        return sum + likes + comments;
      }, 0);
      engagementRate = (totalEngagement / Math.min(recentEdges.length, 12)) / followersCount * 100;
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
      postsCount,
      engagementRate,
      isVerified: user.is_verified || false,
      isBusinessAccount: user.is_business_account || false,
      isPrivate: user.is_private || false,
      category: user.category_name || user.business_category_name || '',
      contactEmail: user.business_email || user.public_email,
      contactPhone: user.business_phone_number || user.public_phone_number,
      externalUrl: user.external_url || '',
      recentPosts: recentEdges.slice(0, 12).map((edge: any) => this.parsePostNode(edge.node)),
      scrapedAt: new Date().toISOString(),
    };
  }
}
