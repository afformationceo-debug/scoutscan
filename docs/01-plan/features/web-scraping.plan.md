# Plan: Web Scraping Platform (Apify/Brightdata-level)

## Goal
Build a production-grade social media scraping platform that matches or exceeds Apify/Brightdata capabilities, starting with Instagram hashtag-based influencer data collection.

## Scope
- **Phase 1 (MVP)**: Instagram hashtag search + profile scraping
- **Phase 2**: Twitter/X, TikTok, YouTube expansion
- **Phase 3**: API service layer + scheduling

## Key Requirements
1. Instagram hashtag-based search (return posts + influencer profiles)
2. Anti-detection: proxy rotation, browser fingerprinting, TLS spoofing, human-like behavior
3. Multi-platform architecture (extensible to Twitter, TikTok, YouTube)
4. Structured JSON output with normalized data schema
5. Rate limiting with human-like pacing
6. Session management with cookie persistence

## Tech Stack
- **Runtime**: Node.js + TypeScript
- **Scraping Framework**: Crawlee (by Apify, open-source)
- **Browser Automation**: Playwright + playwright-extra + stealth plugin
- **Fingerprinting**: fingerprint-suite (by Apify)
- **Proxy**: Residential proxy support with rotation
- **Reference API**: Apify API for benchmarking/fallback

## Risk Assessment
- Instagram GraphQL endpoints change frequently -> need endpoint discovery logic
- TLS fingerprinting detection -> use real browser (Playwright)
- Account bans -> use unauthenticated public data first
- Rate limits -> conservative pacing with exponential backoff

## Success Criteria
- Scrape 1000+ posts per hashtag search
- Extract full influencer profile data (followers, posts, engagement)
- Zero detection/blocks with residential proxies
- < 5s per profile data extraction
