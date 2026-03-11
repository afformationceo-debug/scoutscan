# Design: Web Scraping Platform

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLI / API Layer                    │
├─────────────────────────────────────────────────────┤
│               Scraper Orchestrator                   │
│  (queue management, retry, result aggregation)       │
├──────────┬──────────┬──────────┬────────────────────┤
│Instagram │ Twitter  │ TikTok   │ YouTube            │
│ Adapter  │ Adapter  │ Adapter  │ Adapter            │
├──────────┴──────────┴──────────┴────────────────────┤
│              Core Scraping Engine                     │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Browser  │ │  Proxy   │ │  Anti-Detection   │   │
│  │ Manager  │ │  Router  │ │  Middleware Stack  │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Session  │ │  Rate    │ │  Fingerprint      │   │
│  │ Manager  │ │  Limiter │ │  Generator        │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Module Design

### 1. Core Engine (`src/core/`)
- **BrowserManager**: Playwright browser pool with stealth, context isolation
- **ProxyRouter**: Residential/mobile proxy rotation with session binding
- **SessionManager**: Cookie persistence, session aging, device fingerprint consistency
- **RateLimiter**: Per-platform throttling with human-like jitter
- **FingerprintGenerator**: Realistic browser fingerprints (canvas, WebGL, navigator)

### 2. Platform Adapters (`src/platforms/`)
Each adapter implements `PlatformScraper` interface:
```typescript
interface PlatformScraper {
  searchByHashtag(tag: string, options?: SearchOptions): AsyncGenerator<Post>
  getProfile(username: string): Promise<Profile>
  getPostDetails(postId: string): Promise<PostDetail>
}
```

### 3. Instagram Adapter Strategy
- **Primary**: GraphQL API (`/graphql/query/`) for hashtag search + profile data
- **Fallback**: Browser-based scraping with Playwright stealth
- **Endpoints**:
  - Hashtag: `query_hash` based GraphQL with cursor pagination
  - Profile: `/api/v1/users/web_profile_info/`
  - Posts: `/graphql/query/` with user media query

### 4. Data Schema (Normalized)
```typescript
interface InfluencerProfile {
  platform: 'instagram' | 'twitter' | 'tiktok' | 'youtube'
  username: string
  fullName: string
  bio: string
  profilePicUrl: string
  followersCount: number
  followingCount: number
  postsCount: number
  engagementRate: number
  isVerified: boolean
  isBusinessAccount: boolean
  category: string
  contactEmail?: string
  externalUrl?: string
  recentPosts: Post[]
}
```

## Implementation Order
1. Core engine (proxy, session, rate limiter, fingerprint)
2. Instagram GraphQL API client
3. Instagram hashtag scraper
4. Instagram profile scraper
5. CLI interface
6. Twitter/YouTube/TikTok stubs
