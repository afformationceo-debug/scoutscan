# Social Scraper Platform

## Tech Stack
- **Runtime**: Node.js + TypeScript (ESM)
- **Web**: Hono framework, Alpine.js, Tailwind CSS, HTMX
- **DB**: SQLite (better-sqlite3), WAL mode
- **Scraping**: Playwright, Crawlee, puppeteer-extra-plugin-stealth
- **DM**: instagram-private-api (mobile API), Playwright (browser DM)
- **Scheduling**: node-cron
- **Concurrency**: p-limit, p-queue

## Project Structure
```
src/
├── core/           # Browser, anti-detection, engine, types, geo-classifier
├── platforms/      # Instagram (full), Twitter/TikTok/YouTube/LinkedIn/Xiaohongshu (stubs)
├── services/       # dm-engine, scheduler, engagement-engine
├── data/           # Country/language mapping data
├── utils/          # delay, headers, logger
└── web/
    ├── views/      # HTML templates (layout, dashboard, search, data, etc.)
    ├── public/     # app.js (Alpine.js components)
    ├── routes/     # api.ts, sse.ts, pages.ts
    └── services/   # db.ts, master-db.ts, job-manager.ts, export.ts, sse-manager.ts
```

## DB Tables
- `jobs`, `posts`, `profiles` - Scraping data
- `keyword_targets` - Scheduled scraping targets (pairId, platform, region, keyword)
- `influencer_master` - Deduplicated influencer profiles with scout tiers (S/A/B/C)
- `dm_campaigns`, `dm_action_queue`, `dm_accounts` - DM automation
- `comment_templates` - Engagement comment templates
- `dm_engagement_log` - Like/comment engagement tracking
- `dm_rounds` - DM round tracking per account

## Design System (KaiaScan Dark Theme)
```
Background: #0A0A0A (body) → #1A1A1A (cards) → #1E1E1E (hover)
Borders: #2E2E2E
Accent: #BFF009 (neon lime), hover: #D4FF3D
Text: #FFFFFF (primary), #A0A0A0 (secondary), #666666 (muted)
Success: #00C853, Error: #FF5252, Warning: #FFB74D
Fonts: Inter (body), Manrope (headings), IBM Plex Mono (data)
Badge: 15% opacity background + solid text color
Max width: 1440px
```

## Key Patterns
- Scout tiers: S (100K+ followers, 3%+ ER), A (10K+, 2%+), B (1K+, 1%+), C (rest)
- Geo classification: bio/hashtag/language analysis, confidence ≥ 0.4
- SSE for real-time job/campaign progress
- Job queue with pLimit(3) concurrent execution
- DM accounts rotate every 10 messages, cooldown after 20 sends
- Anti-bot: random delays, consecutive failure pause, stealth browser

## Commands
- `npm run dashboard` → http://localhost:3000
- `npm run dev` → CLI mode
- `npm run build` → TypeScript compilation
