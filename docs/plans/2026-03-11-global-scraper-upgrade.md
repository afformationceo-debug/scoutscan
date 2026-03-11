# Global Scraper Platform Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the social scraping platform with 5x faster profile enrichment, 3-layer master DB, NLP country detection, delta scraping with cron, and CLI DM funnel.

**Architecture:** Monolithic extension of existing Hono + SQLite stack. Five phases implemented sequentially — each phase produces independently testable output.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Playwright, p-limit, franc, node-cron, instagram-private-api

**Spec:** `docs/superpowers/specs/2026-03-11-global-scraper-upgrade-design.md`

---

## Phase 1: Scraping Engine Speed Optimization

### Task 1.1: Install p-limit dependency

**Files:**
- Modify: `package.json`

**Step 1: Install p-limit**

Run: `npm install p-limit`

**Step 2: Verify import works**

Run: `node -e "import('p-limit').then(m => console.log('OK', typeof m.default))"`

Expected: `OK function`

**Step 3: Commit**

```
git add package.json package-lock.json
git commit -m "chore: add p-limit for parallel enrichment"
```

---

### Task 1.2: Remove closeAll() from getProfileOnce()

**Files:**
- Modify: `src/platforms/instagram/scraper.ts:261-343`

**Why:** `getProfileOnce()` currently calls `this.browser.closeAll()` (line 332) after each profile fetch, destroying the entire browser process. This forces a full browser relaunch (5-8s) for every subsequent profile. We must change this to `closeContext(sessionId)` only.

**Step 1: Wrap getProfileOnce() internals in try/finally with closeContext only**

Replace the method body so context cleanup is in `finally`:

```typescript
private async getProfileOnce(username: string, region: string, proxy?: any): Promise<InfluencerProfile> {
    logger.info(`[Instagram] Fetching profile: @${username} (region: ${region})`);
    await this.browser.launch({ headless: true });
    const sessionId = randomUUID();

    try {
      let profileData: any = null;
      await this.browser.createStealthContext(sessionId, { region, proxy });

      if (this.cookieManager.hasCookies('instagram')) {
        const cookies = this.cookieManager.loadCookies('instagram');
        await this.browser.setCookies(sessionId, this.cookieManager.toPlaywrightCookies(cookies));
      }

      const page = await this.browser.createPage(sessionId, {
        blockMedia: true,
        interceptResponses: (url, body) => {
          if (url.includes('web_profile_info') || url.includes('/graphql/query')) {
            try {
              const data = JSON.parse(body);
              const user = data?.data?.user || data?.graphql?.user;
              if (user && user.username) profileData = user;
            } catch {}
          }
        },
      });

      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await randomDelay(3000, 5000);

      if (!profileData) {
        profileData = await page.evaluate(() => {
          // ... existing extraction logic (unchanged) ...
        });
      }

      await simulateReading(page, 2000);

      if (!profileData) throw new Error(`No profile data found for @${username}`);
      if (profileData._fromMeta) return this.parseMetaProfile(profileData, username);
      return this.parseUserProfile(profileData);
    } finally {
      await this.browser.closeContext(sessionId);
    }
  }
```

Key change: `closeAll()` removed, `closeContext(sessionId)` in `finally` block.

**Step 2: Remove closeAll() from getProfile() catch block (line 242)**

Remove this line entirely since `getProfileOnce()` now handles cleanup in its `finally` block.

**Step 3: Verify build**

Run: `npx tsc --noEmit`

Expected: No errors.

**Step 4: Commit**

```
git add src/platforms/instagram/scraper.ts
git commit -m "perf: remove closeAll() from getProfileOnce, reuse browser across enrichment"
```

---

### Task 1.3: API-First Mode (Fast Path)

**Files:**
- Modify: `src/platforms/instagram/scraper.ts` — `getProfile()` method (lines 219-258)

**Why:** Currently `getProfile()` tries browser 3 times, then API fallback. We reverse this: try API first (~200ms), browser fallback only on failure. The `InstagramAPI.getProfile()` method already exists at `src/platforms/instagram/api.ts:211-229`.

**Step 1: Add API success rate tracking**

After line 41, add instance properties:

```typescript
  private apiSuccessCount = 0;
  private apiAttemptCount = 0;
  private useApiFirst = true;
```

**Step 2: Rewrite getProfile() to API-first**

```typescript
async getProfile(username: string, options: ScrapingOptions = {}): Promise<InfluencerProfile> {
    // Phase 1: API-first (if enabled)
    if (this.useApiFirst) {
      try {
        this.apiAttemptCount++;
        await this.api.initSession();
        const profile = await this.api.getProfile(username);
        this.apiSuccessCount++;
        return profile;
      } catch (apiError) {
        logger.debug(`[Instagram] API failed for @${username}: ${(apiError as Error).message}, trying browser`);
        if (this.apiAttemptCount >= 10 && (this.apiSuccessCount / this.apiAttemptCount) < 0.5) {
          logger.warn(`[Instagram] API success rate ${Math.round(this.apiSuccessCount/this.apiAttemptCount*100)}% — switching to browser-first`);
          this.useApiFirst = false;
        }
      }
    }

    // Phase 2: Browser fallback (max 2 retries)
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const region = REGIONS[attempt % REGIONS.length];
      const proxy = this.proxyRouter.getRotatingProxy();
      try {
        return await this.getProfileOnce(username, region, proxy);
      } catch (error) {
        lastError = error as Error;
        logger.warn(`[Instagram] @${username} browser attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);
        if (proxy && (lastError.message.includes('429') || lastError.message.includes('blocked'))) {
          this.proxyRouter.markBlocked(proxy);
        }
        if (attempt < maxRetries - 1) await backoffDelay(attempt, 3000, 15000);
      }
    }

    throw new Error(`All methods failed for @${username}: ${lastError?.message}`);
  }
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```
git add src/platforms/instagram/scraper.ts
git commit -m "perf: switch to API-first profile fetching with auto-fallback"
```

---

### Task 1.4: Parallel Enrichment with pLimit(3)

**Files:**
- Modify: `src/web/services/job-manager.ts` — enrichment loops in `runHashtagJob()` and `runReEnrichJob()`

**Step 1: Add pLimit import**

```typescript
import pLimit from 'p-limit';
```

**Step 2: Replace sequential enrichment in runHashtagJob() (lines 175-201)**

```typescript
        const limit = pLimit(3);
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 5;
        let failedUsernames: string[] = [];

        const enrichTasks = newUsernames.map(username =>
          limit(async () => {
            try {
              const profile = await engine.getProfile(platform, username);
              insertProfile(jobId, profile);
              profilesCount++;
              consecutiveFailures = 0;
              this.sendSSE(jobId, 'profile', profile);
              this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: newUsernames.length });
            } catch (err) {
              consecutiveFailures++;
              failedUsernames.push(username);
              console.warn(`[enrichment] Failed @${username}: ${(err as Error).message}`);
              this.sendSSE(jobId, 'profile_error', { username, error: (err as Error).message, consecutiveFailures });
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                this.sendSSE(jobId, 'profile_pause', { reason: 'consecutive_failures', pauseSeconds: 30 });
                await new Promise(r => setTimeout(r, 30000));
                consecutiveFailures = 0;
              }
            }
            const delay = 800 + Math.random() * 1200;
            await new Promise(r => setTimeout(r, delay));
          })
        );
        await Promise.allSettled(enrichTasks);
```

**Step 3: Apply same pattern to runReEnrichJob() (lines 267-290)**

**Step 4: Verify build**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```
git add src/web/services/job-manager.ts
git commit -m "perf: parallel profile enrichment with pLimit(3)"
```

---

### Task 1.5: Remove closeAll() from searchByHashtag()

**Files:**
- Modify: `src/platforms/instagram/scraper.ts:165-166, 179`

**Step 1: Line 166 — remove closeAll(), keep closeContext()**

```typescript
// BEFORE:
        await this.browser.closeContext(sessionId);
        await this.browser.closeAll();
// AFTER:
        await this.browser.closeContext(sessionId);
```

**Step 2: Line 179 — replace closeAll() with safe closeContext()**

```typescript
// BEFORE:
        await this.browser.closeAll();
// AFTER:
        await this.browser.closeContext(sessionId).catch(() => {});
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```
git add src/platforms/instagram/scraper.ts
git commit -m "perf: remove closeAll from searchByHashtag, context-only cleanup"
```

---

## Phase 2: DB Schema Extension (3-Layer Master DB)

### Task 2.1: Add new table schemas to db.ts

**Files:**
- Modify: `src/web/services/db.ts` — add table creation after line 80

**Step 1: Add 5 new CREATE TABLE statements**

After the existing `db.exec(...)` block that creates jobs/posts/profiles tables, add a second `db.exec(...)` block with:
- `keyword_targets` (as defined in spec Section 2.2)
- `influencer_master` (as defined in spec Section 2.3)
- `dm_campaigns` (as defined in spec Section 2.4)
- `dm_action_queue` (as defined in spec Section 2.5)
- `dm_accounts` (as defined in spec Section 2.6)

Include all indexes.

Full SQL is in `docs/superpowers/specs/2026-03-11-global-scraper-upgrade-design.md` Sections 2.2-2.6.

**Step 2: Verify DB init**

Run: `node --import tsx/esm -e "await import('./src/web/services/db.ts')"`

Expected: No errors, tables created.

**Step 3: Commit**

```
git add src/web/services/db.ts
git commit -m "feat: add 5 new master DB tables (keyword_targets, influencer_master, dm_*)"
```

---

### Task 2.2: Add TypeScript types for new tables

**Files:**
- Modify: `src/core/types.ts`

**Step 1: Add interfaces**

After the existing `Job` interface, add:
- `KeywordTarget`
- `InfluencerMaster`
- `DMCampaign`
- `DMActionItem`
- `DMAccount`

Field definitions match the DB schema from Task 2.1, with camelCase naming.

**Step 2: Verify build**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
git add src/core/types.ts
git commit -m "feat: add TypeScript types for master DB tables"
```

---

### Task 2.3: Create master-db.ts CRUD service

**Files:**
- Create: `src/web/services/master-db.ts`

**Step 1: Implement the following functions**

- `calculateScoutTier(followers, engagementRate)` — S/A/B/C based on spec thresholds
- `upsertInfluencer(profile, pairId?)` — INSERT ... ON CONFLICT DO UPDATE with per-field merge policy
- `getInfluencers(opts)` — paginated query with platform/country/tier/dmStatus/search filters
- `getInfluencerStats()` — total, byCountry, byTier aggregates
- `migrateProfilesToMaster()` — one-time migration from profiles table (deduplicated by latest scraped_at)
- `createKeywordTarget(target)` — INSERT into keyword_targets
- `listKeywordTargets()` — SELECT all
- `updateKeywordTarget(id, updates)` — partial UPDATE
- `deleteKeywordTarget(id)` — DELETE
- `createCampaign(campaign)` — INSERT into dm_campaigns
- `listCampaigns()` — SELECT all
- `addDMAccount(platform, username, sessionFile?)` — INSERT OR IGNORE
- `listDMAccounts(platform?)` — SELECT
- `resetDailyLimits()` — UPDATE dm_accounts SET daily_sent = 0
- `updateInfluencerGeo(platform, username, geoResult)` — UPDATE geo fields

**Step 2: Verify build**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
git add src/web/services/master-db.ts
git commit -m "feat: master-db CRUD service with UPSERT, scout tier, migrations"
```

---

### Task 2.4: Wire UPSERT into enrichment pipeline

**Files:**
- Modify: `src/web/services/job-manager.ts`

**Step 1: Import and call upsertInfluencer after each insertProfile()**

```typescript
import { upsertInfluencer } from './master-db.js';

// After each insertProfile(jobId, profile):
upsertInfluencer(profile);
```

Apply to: `runHashtagJob()`, `runReEnrichJob()`, `runProfileJob()`, and retry loops.

**Step 2: Verify build**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
git add src/web/services/job-manager.ts
git commit -m "feat: auto-upsert to influencer_master on profile enrichment"
```

---

### Task 2.5: Add master DB API endpoints + run migration

**Files:**
- Modify: `src/web/routes/api.ts`

**Step 1: Add endpoints**

```
POST /api/master/migrate      — one-time profiles→influencer_master migration
GET  /api/master/influencers   — paginated query with filters
GET  /api/master/stats         — aggregated stats (total, byCountry, byTier)
```

**Step 2: Verify build + trigger migration**

Run: `npx tsc --noEmit`

Start dashboard, then: `curl -X POST http://localhost:3000/api/master/migrate`

Verify: `curl http://localhost:3000/api/master/stats` returns counts.

**Step 3: Commit**

```
git add src/web/routes/api.ts
git commit -m "feat: master DB API endpoints (migrate, influencers, stats)"
```

---

## Phase 3: NLP Country Detection (GeoClassifier)

### Task 3.1: Install franc dependency

Run: `npm install franc`

Commit: `git commit -m "chore: add franc for NLP language detection"`

---

### Task 3.2: Create mapping data files

**Files:**
- Create: `src/data/lang-country-map.ts`
- Create: `src/data/city-country-map.ts`
- Create: `src/data/country-hashtags.ts`

**lang-country-map.ts**: ISO 639-3 → BCP 47 conversion table + BCP 47 → country mapping (spec Section 3.2).

**city-country-map.ts**: 500+ cities/regions in English + local scripts. Focus on TW, KR, JP, VN, TH, ID, MY, CN, US, GB.

**country-hashtags.ts**: Country-specific hashtag patterns (e.g., `#台灣`, `#한국`, `#日本`).

Commit: `git commit -m "feat: NLP mapping data (lang→country, cities, hashtags)"`

---

### Task 3.3: Implement GeoClassifier

**Files:**
- Create: `src/core/geo-classifier.ts`

Implement per spec Section 3:
- 5 weighted signals: bioLang(0.30), captionLang(0.25), location(0.20), hashtags(0.15), namePattern(0.10)
- `classifyChineseVariant()` using Unicode CJK range analysis
- Confidence < 0.4 → `UNKNOWN`
- franc requires min 10 chars for reliable detection
- Export `GeoClassifier` class and `GeoResult` interface

Commit: `git commit -m "feat: GeoClassifier with 5-signal weighted country detection"`

---

### Task 3.4: Wire GeoClassifier into enrichment + bulk geo-tag endpoint

**Files:**
- Modify: `src/web/services/job-manager.ts` — call GeoClassifier after upsertInfluencer
- Modify: `src/web/routes/api.ts` — add `POST /api/master/geo-tag` for bulk tagging

Commit: `git commit -m "feat: wire GeoClassifier into enrichment + bulk geo-tag endpoint"`

---

## Phase 4: Delta Scraping + Cron Scheduler

### Task 4.1: Install node-cron

Run: `npm install node-cron && npm install -D @types/node-cron`

Commit: `git commit -m "chore: add node-cron for scheduled scraping"`

---

### Task 4.2: Add since to SearchOptions + delta filtering

**Files:**
- Modify: `src/core/types.ts` — add `since?: string` to SearchOptions
- Modify: `src/platforms/instagram/scraper.ts` — filter posts by since timestamp in searchByHashtag()

Delta filtering: collect all posts, skip `post.timestamp < since`, early-stop after 20 consecutive old posts.

Commit: `git commit -m "feat: delta scraping with since parameter + server-side filtering"`

---

### Task 4.3: Create SchedulerService

**Files:**
- Create: `src/services/scheduler.ts`
- Modify: `src/web/server.ts` — import + start scheduler

SchedulerService:
- Cron 1: hourly check `keyword_targets WHERE next_scrape_at <= NOW AND is_active = 1`
- Cron 2: midnight `dm_accounts.daily_sent = 0`
- `runNow(pairId)` for immediate execution
- Updates `last_scraped_at` and `next_scrape_at` after each run

Commit: `git commit -m "feat: SchedulerService with hourly cron + midnight DM reset"`

---

### Task 4.4: Keyword targets API + Keywords tab UI

**Files:**
- Modify: `src/web/routes/api.ts` — CRUD endpoints for keyword_targets + run-now
- Modify: `src/web/views/data.html` — Keywords tab
- Modify: `src/web/public/app.js` — Keywords tab logic

API endpoints:
```
GET    /api/keywords
POST   /api/keywords
PATCH  /api/keywords/:id
DELETE /api/keywords/:id
POST   /api/keywords/:pairId/run
```

UI: table with all fields, add form, toggle active, run now button, inline cycle edit.

Commit: `git commit -m "feat: Keywords management tab with CRUD + Run Now"`

---

## Phase 5: DM Sending Funnel

### Task 5.1: Install instagram-private-api

Run: `npm install instagram-private-api`

Commit: `git commit -m "chore: add instagram-private-api for DM sending"`

---

### Task 5.2: Create DMEngine core

**Files:**
- Create: `src/services/dm-engine.ts`

Key methods:
- `processCampaign(campaignId)` — main send loop with anti-bot stealth
- `sendInstagramDM(account, recipient, message)` — via instagram-private-api mobile API
- `sendBrowserDM(platform, account, recipient, message)` — Playwright fallback for other platforms
- `getAvailableAccount(platform)` — pick account with daily_sent < daily_limit, lazy reset
- `renderTemplate(template, influencer)` — {{variable}} substitution

Anti-bot stealth (spec Section 5.3):
- Random delay: campaign.delay_min_sec to delay_max_sec
- Account rotation: every 10 messages
- Cooldown: 15-30 min after 20 sends
- Daily limit: 40/account (configurable)

Commit: `git commit -m "feat: DMEngine with instagram-private-api + multi-account rotation"`

---

### Task 5.3: DM campaign API endpoints

**Files:**
- Modify: `src/web/routes/api.ts`

Endpoints:
```
POST   /api/campaigns           — create
GET    /api/campaigns           — list
PATCH  /api/campaigns/:id       — update
POST   /api/campaigns/:id/queue — generate action queue from targeting query
POST   /api/campaigns/:id/start — start sending
POST   /api/campaigns/:id/pause — pause sending
POST   /api/dm-accounts         — add account
GET    /api/dm-accounts         — list accounts
DELETE /api/dm-accounts/:id     — remove account
```

Commit: `git commit -m "feat: DM campaign + accounts API endpoints"`

---

### Task 5.4: Campaigns + Accounts tab UI

**Files:**
- Modify: `src/web/views/data.html`
- Modify: `src/web/public/app.js`

Campaigns tab:
- Campaign list with progress bars
- Create form (targeting, template editor with variable preview)
- Start/Pause controls
- Send activity log

Accounts tab:
- Account list (platform, username, daily progress, status)
- Add/remove accounts

Commit: `git commit -m "feat: Campaigns + Accounts management tab UI"`

---

### Task 5.5: Enhanced Profiles tab with master DB

**Files:**
- Modify: `src/web/views/data.html`
- Modify: `src/web/public/app.js`

Changes:
- Switch data source from `/api/profiles` to `/api/master/influencers`
- Add columns: Country (flag emoji), Language, Tier (S/A/B/C badge), DM Status, Source Keywords
- Add filters: country tabs, tier filter, DM status filter

Commit: `git commit -m "feat: enhanced Profiles tab from master DB with country/tier/DM"`

---

## Final Verification Checklist

1. **Phase 1**: Profile enrichment 3-5x faster (API-first + parallel)
2. **Phase 2**: influencer_master populated via UPSERT with scout tiers
3. **Phase 3**: detected_country populated for profiles (confidence > 0.4)
4. **Phase 4**: Keywords scheduled, delta scraping works, cron runs
5. **Phase 5**: DM campaigns can be created, queued, sent (Instagram first)
6. **UI**: 4 tabs (Profiles, Keywords, Campaigns, Accounts) all functional
7. **No regressions**: Search, history, export features intact
