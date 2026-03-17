import { Hono } from 'hono';
import type { Platform } from '../../core/types.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { listJobs, getJob, getJobPosts, getJobProfiles, deleteJob, getAllProfiles, getProfileStats, getMissingProfileUsernames } from '../services/db.js';
import { jobManager } from '../services/job-manager.js';
import { exportCSV, exportXLSX } from '../services/export.js';
import { migrateProfilesToMaster, getInfluencers, getInfluencerStats, updateInfluencerGeo, listKeywordTargets, createKeywordTarget, updateKeywordTarget, deleteKeywordTarget, createCampaign, listCampaigns, getCampaign, getCampaignCookieJson, updateCampaignCookie, getCampaignTargets, addDMAccount, listDMAccounts, listCommentTemplates, createCommentTemplate, updateCommentTemplate, deleteCommentTemplate, getEngagementLogs, getCampaignRounds, updateDMAccount, saveScrapingCookiesToDB, getScrapingCookieStatusFromDB } from '../services/master-db.js';
import { registry } from '../../services/registry.js';
import { GeoClassifier } from '../../core/geo-classifier.js';
import { AIClassifier } from '../../services/ai-classifier.js';
import { db } from '../services/db.js';
import { scheduler } from '../../services/scheduler.js';

const api = new Hono();
const cookieManager = new CookieManager();

// Access dmEngine through registry (initialized in server.ts)
const getDmEngine = () => registry.dmEngine;

const VALID_PLATFORMS: Platform[] = ['instagram', 'twitter', 'tiktok', 'youtube', 'xiaohongshu', 'linkedin'];

// ─── Jobs ───

api.post('/jobs/hashtag', async (c) => {
  const body = await c.req.json();
  const { platform, hashtag, maxResults = 50, enrichProfiles = true } = body;

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return c.json({ error: 'Invalid platform' }, 400);
  }
  if (!hashtag || typeof hashtag !== 'string') {
    return c.json({ error: 'Hashtag is required' }, 400);
  }

  const tag = hashtag.replace(/^#/, '');
  // Generate pairId for source tracking: "instagram:manual:hashtag"
  // This ensures source_pair_ids is set even for manual API jobs
  const pairId = `${platform}:manual:${tag}`;
  const jobId = jobManager.startHashtagJob(platform as Platform, tag, maxResults, enrichProfiles, pairId);
  return c.json({ jobId, message: 'Job started' }, 201);
});

api.post('/jobs/profile', async (c) => {
  const body = await c.req.json();
  const { platform, username } = body;

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return c.json({ error: 'Invalid platform' }, 400);
  }
  if (!username || typeof username !== 'string') {
    return c.json({ error: 'Username is required' }, 400);
  }

  const jobId = jobManager.startProfileJob(platform as Platform, username);
  return c.json({ jobId, message: 'Job started' }, 201);
});

// ─── DM History (for history dashboard) ───

api.get('/dm-history', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const status = c.req.query('status') || '';
  const platform = c.req.query('platform') || '';
  const campaign = c.req.query('campaign') || '';
  const search = c.req.query('search') || '';
  const sort = c.req.query('sort') === 'asc' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const params: any[] = [];

  if (status) { conditions.push('q.execute_status = ?'); params.push(status); }
  if (platform) { conditions.push('q.platform = ?'); params.push(platform); }
  if (campaign) { conditions.push('q.campaign_id = ?'); params.push(campaign); }
  if (search) {
    conditions.push('(m.username LIKE ? OR m.full_name LIKE ? OR c.name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT q.id, q.influencer_key, q.campaign_id, q.platform, q.execute_status,
           q.account_username, q.error_message, q.proxy_ip, q.retry_count,
           q.executed_at, q.created_at, q.engagement_status,
           q.liked_post_url, q.comment_text,
           m.username as recipient, m.full_name as recipient_name,
           m.followers_count, m.profile_pic_url, m.detected_country, m.ai_country,
           c.name as campaign_name, c.brand as campaign_brand
    FROM dm_action_queue q
    LEFT JOIN influencer_master m ON q.influencer_key = m.influencer_key
    LEFT JOIN dm_campaigns c ON q.campaign_id = c.id
    ${where}
    ORDER BY COALESCE(q.executed_at, q.created_at) ${sort}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM dm_action_queue q
    LEFT JOIN influencer_master m ON q.influencer_key = m.influencer_key
    LEFT JOIN dm_campaigns c ON q.campaign_id = c.id
    ${where}
  `).get(...params) as any;

  const statsRows = db.prepare(`
    SELECT execute_status, COUNT(*) as cnt FROM dm_action_queue GROUP BY execute_status
  `).all() as any[];
  const stats = Object.fromEntries(statsRows.map((s: any) => [s.execute_status, s.cnt]));

  // Campaign list for filter dropdown
  const campaigns = db.prepare('SELECT id, name, platform FROM dm_campaigns ORDER BY created_at DESC').all();

  return c.json({ items: rows, total: totalRow.cnt, stats, campaigns, limit, offset });
});

api.get('/jobs', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const { jobs, total } = listJobs(limit, offset);
  return c.json({ jobs, total, limit, offset });
});

api.get('/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

api.get('/jobs/:id/posts', (c) => {
  const jobId = c.req.param('id');
  const job = getJob(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const sortBy = c.req.query('sortBy') || 'likes';
  const order = (c.req.query('order') || 'desc') as 'asc' | 'desc';
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  const result = getJobPosts(jobId, { sortBy, order, limit, offset });
  return c.json(result);
});

api.get('/jobs/:id/profiles', (c) => {
  const jobId = c.req.param('id');
  const job = getJob(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const profiles = getJobProfiles(jobId);
  return c.json({ profiles });
});

api.get('/jobs/:id/export', (c) => {
  const jobId = c.req.param('id');
  const job = getJob(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const format = c.req.query('format') || 'csv';

  if (format === 'xlsx') {
    const buffer = exportXLSX(jobId);
    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="scraper-${jobId.slice(0, 8)}.xlsx"`,
      },
    });
  }

  const csv = exportCSV(jobId);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="scraper-${jobId.slice(0, 8)}.csv"`,
    },
  });
});

// Re-enrich missing profiles
api.post('/jobs/re-enrich', async (c) => {
  const body = await c.req.json();
  const { platform } = body;

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return c.json({ error: 'Invalid platform' }, 400);
  }

  const missing = getMissingProfileUsernames(platform);
  if (missing.length === 0) {
    return c.json({ error: 'No missing profiles', missingCount: 0 }, 400);
  }

  try {
    const jobId = jobManager.startReEnrichJob(platform as Platform);
    return c.json({ jobId, missingCount: missing.length, message: 'Re-enrichment started' }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Missing profiles count
api.get('/profiles/missing', (c) => {
  const result: Record<string, number> = {};
  for (const p of VALID_PLATFORMS) {
    const missing = getMissingProfileUsernames(p);
    if (missing.length > 0) result[p] = missing.length;
  }
  return c.json({ missing: result });
});

api.delete('/jobs/:id', (c) => {
  const jobId = c.req.param('id');
  const job = getJob(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  deleteJob(jobId);
  return c.json({ message: 'Job deleted' });
});

// ─── All Profiles (master data) ───

api.get('/profiles', (c) => {
  const platform = c.req.query('platform') || undefined;
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const search = c.req.query('search') || undefined;
  const sortBy = c.req.query('sortBy') || 'followers';
  const order = (c.req.query('order') || 'desc') as 'asc' | 'desc';

  const result = getAllProfiles({ platform, limit, offset, search, sortBy, order });
  return c.json(result);
});

api.get('/profiles/stats', (c) => {
  const stats = getProfileStats();
  return c.json({ stats });
});

// ─── Platforms ───

api.get('/platforms', (c) => {
  const fsStatus = cookieManager.getCookieStatus();
  const dbStatus = getScrapingCookieStatusFromDB();
  const dbMap = new Map(dbStatus.map(d => [d.platform, d]));

  // Also get DM account cookie status from DB
  const dmAccounts = db.prepare(
    `SELECT platform, COUNT(*) as cnt, SUM(CASE WHEN cookie_status = 'valid' THEN 1 ELSE 0 END) as valid_cnt
     FROM dm_accounts GROUP BY platform`
  ).all() as any[];
  const dmMap = new Map(dmAccounts.map((d: any) => [d.platform, d]));

  const platforms = fsStatus.map(p => {
    const dbEntry = dbMap.get(p.platform);
    const dmEntry = dmMap.get(p.platform);
    const hasCookies = p.hasCookies || (dbEntry && dbEntry.cookieCount > 0) || (dmEntry && dmEntry.valid_cnt > 0);
    const cookieCount = p.cookieCount || dbEntry?.cookieCount || 0;

    // Check if scraping cookies are actually expired (not just present)
    let hasExpired = false;
    if (hasCookies) {
      const cookies = cookieManager.loadCookies(p.platform);
      const critical = cookieManager.getCriticalCookieNames(p.platform);
      const now = Math.floor(Date.now() / 1000);
      for (const c of cookies) {
        if (critical.includes(c.name) && c.expires && c.expires < now) {
          hasExpired = true;
          break;
        }
      }
      // Also check if critical cookies are missing
      const cookieNames = new Set(cookies.map(c => c.name));
      if (critical.some(name => !cookieNames.has(name))) {
        hasExpired = true;
      }
    }

    return {
      ...p,
      hasCookies: !!hasCookies,
      hasExpired,
      cookieCount,
      dmAccounts: dmEntry?.cnt || 0,
      dmValidAccounts: dmEntry?.valid_cnt || 0,
      updatedAt: dbEntry?.updatedAt || null,
    };
  });

  return c.json({ platforms });
});

// Get scraping cookies for a platform (returns stored JSON)
api.get('/platforms/:platform/cookies', (c) => {
  const platform = c.req.param('platform');
  try {
    const row = db.prepare('SELECT cookie_json, cookie_count, updated_at FROM scraping_cookies WHERE platform = ?').get(platform) as any;
    if (!row) return c.json({ platform, cookies: null, cookieCount: 0 });
    return c.json({ platform, cookies: row.cookie_json, cookieCount: row.cookie_count, updatedAt: row.updated_at });
  } catch {
    return c.json({ platform, cookies: null, cookieCount: 0 });
  }
});

// Upload scraping cookies (platform-level, separate from DM account cookies)
api.post('/platforms/:platform/cookies', async (c) => {
  const platform = c.req.param('platform');
  try {
    const body = await c.req.json();
    const cookieData = typeof body.cookies === 'string' ? body.cookies : JSON.stringify(body.cookies || body);
    const parsed = JSON.parse(cookieData);
    const cm = new CookieManager();
    const cookies = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, value]) => ({ name, value: String(value) }));
    cm.saveCookies(platform, cookies);

    const loaded = cm.loadCookies(platform);
    // Also persist to DB for ephemeral filesystem environments (e.g., Railway)
    saveScrapingCookiesToDB(platform, cookieData, loaded.length);
    return c.json({ status: 'ok', platform, cookieCount: loaded.length, message: `Scraping cookies saved for ${platform}` });
  } catch (error) {
    return c.json({ error: `Failed to save cookies: ${(error as Error).message}` }, 400);
  }
});

// ─── Master DB ───

api.post('/master/migrate', (c) => {
  const count = migrateProfilesToMaster();
  return c.json({ migrated: count, message: `Migrated ${count} profiles to influencer_master` });
});

api.get('/master/influencers', (c) => {
  const platform = c.req.query('platform') || undefined;
  const country = c.req.query('country') || undefined;
  const tier = c.req.query('tier') || undefined;
  const dmStatus = c.req.query('dmStatus') || undefined;
  const search = c.req.query('search') || undefined;
  const aiType = c.req.query('aiType') || undefined;
  const campaignId = c.req.query('campaignId') || undefined;
  const hasEmail = c.req.query('hasEmail') || undefined;
  const isVerified = c.req.query('isVerified') || undefined;
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sortBy = c.req.query('sortBy') || 'followers';
  const order = (c.req.query('order') || 'desc') as 'asc' | 'desc';

  const result = getInfluencers({ platform, country, tier, dmStatus, search, limit, offset, sortBy, order, aiType, campaignId, hasEmail, isVerified } as any);
  return c.json(result);
});

api.get('/master/stats', (c) => {
  const stats = getInfluencerStats();
  return c.json(stats);
});

// ─── Geo Tagging ───

api.post('/master/geo-tag', (c) => {
  const geoClassifier = new GeoClassifier();
  const rows = db.prepare(
    `SELECT influencer_key, platform, username, full_name, bio, profile_pic_url,
            followers_count, following_count, posts_count, engagement_rate,
            is_verified, is_business, is_private, category, contact_email, external_url
     FROM influencer_master WHERE detected_country IS NULL OR geo_confidence < 0.4`
  ).all() as any[];

  let tagged = 0;
  for (const row of rows) {
    const profile = {
      platform: row.platform,
      id: row.influencer_key,
      username: row.username,
      fullName: row.full_name || '',
      bio: row.bio || '',
      profilePicUrl: row.profile_pic_url || '',
      followersCount: row.followers_count || 0,
      followingCount: row.following_count || 0,
      postsCount: row.posts_count || 0,
      engagementRate: row.engagement_rate || undefined,
      isVerified: !!row.is_verified,
      isBusinessAccount: !!row.is_business,
      isPrivate: !!row.is_private,
      category: row.category || undefined,
      contactEmail: row.contact_email || undefined,
      externalUrl: row.external_url || undefined,
      scrapedAt: new Date().toISOString(),
    };

    const geo = geoClassifier.classify(profile as any);
    if (geo.confidence >= 0.4) {
      updateInfluencerGeo(row.platform, row.username, geo);
      tagged++;
    }
  }

  return c.json({ tagged, total: rows.length, message: `Geo-tagged ${tagged}/${rows.length} influencers` });
});

// ─── AI Classification ───

api.post('/master/ai-classify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { apiKey, platform, reClassify } = body as { apiKey?: string; platform?: string; reClassify?: boolean };

  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return c.json({ error: 'OpenAI API key required (body.apiKey or OPENAI_API_KEY env)' }, 400);

  try {
    const classifier = new AIClassifier(key);
    let classified: number;

    if (platform) {
      classified = await classifier.classifyByPlatform(platform);
    } else {
      classified = await classifier.classifyAll({ reClassify });
    }

    // Auto-assign to campaigns after classification
    const assigned = classifier.autoAssignToCampaigns();

    return c.json({
      classified,
      assigned,
      message: `AI classified ${classified} profiles, assigned ${assigned} to campaigns`,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// AI classification status
api.get('/master/ai-status', (c) => {
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master').get() as any).cnt;
  const classified = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master WHERE ai_classified_at IS NOT NULL').get() as any).cnt;
  const influencers = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master WHERE ai_is_influencer = 1').get() as any).cnt;
  const businesses = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master WHERE ai_is_influencer = 0 AND ai_classified_at IS NOT NULL').get() as any).cnt;
  const unclassified = total - classified;

  const byCountry = db.prepare(`
    SELECT ai_country, COUNT(*) as cnt FROM influencer_master
    WHERE ai_classified_at IS NOT NULL AND ai_is_influencer = 1
    GROUP BY ai_country ORDER BY cnt DESC
  `).all() as any[];

  return c.json({ total, classified, unclassified, influencers, businesses, byCountry });
});

// ─── Keyword Targets ───

api.get('/keywords', (c) => {
  const targets = listKeywordTargets();
  return c.json({ targets });
});

api.post('/keywords', async (c) => {
  const body = await c.req.json();
  const { pairId, platform, region, keyword, scrapingCycleHours, maxResultsPerRun, scrapeUntil } = body;
  if (!pairId || !platform || !region || !keyword) {
    return c.json({ error: 'Missing required fields: pairId, platform, region, keyword' }, 400);
  }
  try {
    const id = createKeywordTarget({ pairId, platform, region, keyword, scrapingCycleHours, maxResultsPerRun, scrapeUntil });
    return c.json({ id, message: 'Keyword target created' }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.patch('/keywords/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  updateKeywordTarget(id, body);
  return c.json({ message: 'Updated' });
});

api.delete('/keywords/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  deleteKeywordTarget(id);
  return c.json({ message: 'Deleted' });
});

api.post('/keywords/:pairId/run', (c) => {
  const pairId = c.req.param('pairId');
  try {
    const jobId = scheduler.runNow(pairId);
    // Save job reference on keyword target
    db.prepare(`UPDATE keyword_targets SET last_job_id = ?, last_job_status = 'running' WHERE pair_id = ?`).run(jobId, pairId);
    return c.json({ jobId, message: `Scraping started for ${pairId}` }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// POST /api/keywords/group - Create multi-platform keyword target group
api.post('/keywords/group', async (c) => {
  const body = await c.req.json();
  const { region, keyword, platforms, scrapingCycleHours, maxResultsPerRun, scrapeUntil } = body;
  if (!region || !keyword || !platforms?.length) {
    return c.json({ error: 'Missing required: region, keyword, platforms' }, 400);
  }
  const groupKey = `${region}:${keyword}`;
  const ids: Array<{ platform: string; id?: number; pairId?: string; error?: string }> = [];
  for (const platform of platforms) {
    const pairId = `${platform}:${region}:${keyword}`;
    try {
      const id = createKeywordTarget({ pairId, platform, region, keyword, scrapingCycleHours, maxResultsPerRun, groupKey, scrapeUntil });
      ids.push({ platform, id, pairId });
    } catch (err) {
      ids.push({ platform, error: (err as Error).message });
    }
  }
  return c.json({ groupKey, targets: ids }, 201);
});

// POST /api/keywords/group/:groupKey/run - Run all targets in a group
api.post('/keywords/group/:groupKey/run', (c) => {
  const groupKey = decodeURIComponent(c.req.param('groupKey'));
  const targets = listKeywordTargets().filter(t => t.groupKey === groupKey && t.isActive);
  if (targets.length === 0) return c.json({ error: 'No active targets in group' }, 404);
  const jobs: Array<{ platform: string; jobId?: string; error?: string }> = [];
  for (const target of targets) {
    try {
      const jobId = scheduler.runNow(target.pairId);
      jobs.push({ platform: target.platform, jobId });
    } catch (err) {
      jobs.push({ platform: target.platform, error: (err as Error).message });
    }
  }
  return c.json({ groupKey, jobs });
});

// ─── DM Campaigns ───

api.post('/campaigns', async (c) => {
  const body = await c.req.json();
  const { name, brand, platform, targetCountry, targetTiers, minFollowers, maxFollowers, messageTemplate, dailyLimit, delayMinSec, delayMaxSec, senderUsername, cookieJson } = body;
  if (!name || !platform || !messageTemplate) {
    return c.json({ error: 'Missing required fields: name, platform, messageTemplate' }, 400);
  }
  const id = crypto.randomUUID();

  // If cookieJson is provided, also create a DM account entry for backward compatibility
  let cookieStatus = 'unknown';
  if (cookieJson && senderUsername) {
    try {
      const parsed = JSON.parse(cookieJson);
      const cm = new CookieManager();
      const cookies = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, value]) => ({ name, value }));
      cm.saveAccountCookies(platform, senderUsername, cookies);
      const validation = cm.validateCookies(platform, senderUsername);
      cookieStatus = validation.valid ? 'valid' : 'expired';
      // Also register as DM account
      addDMAccount(platform, senderUsername);
      const acct = (db.prepare('SELECT id FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, senderUsername) as any);
      if (acct) {
        db.prepare(`UPDATE dm_accounts SET cookie_file = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?`)
          .run(`cookies/${platform}/${senderUsername}.json`, cookieStatus, new Date().toISOString(), acct.id);
      }
    } catch { /* ignore cookie processing errors */ }
  }

  createCampaign({ id, name, brand, platform, targetCountry, targetTiers, minFollowers, maxFollowers, messageTemplate, dailyLimit, delayMinSec, delayMaxSec, senderUsername, cookieJson });

  // Update cookie status after creation
  if (cookieJson) {
    db.prepare(`UPDATE dm_campaigns SET cookie_status = ? WHERE id = ?`).run(cookieStatus, id);
  }

  // Auto-map keyword group: platform-only (country is determined by AI classification)
  if (platform) {
    db.prepare(`UPDATE dm_campaigns SET linked_keyword_group = ? WHERE id = ?`).run(platform, id);
    console.log(`[API] Campaign ${name}: keyword group → ${platform} (country by AI: ${targetCountry || 'any'})`);
  }

  // Auto-generate queue from existing profiles
  let autoQueued = 0;
  try {
    autoQueued = getDmEngine().generateQueue(id);
  } catch { /* ignore - no matching profiles yet */ }

  return c.json({ id, autoQueued, message: autoQueued > 0 ? `캠페인 생성 완료! 기존 프로필에서 ${autoQueued}명 자동 배정됨` : '캠페인 생성 완료' }, 201);
});

api.get('/campaigns', (c) => {
  const limit = parseInt(c.req.query('limit') || '0');
  const offset = parseInt(c.req.query('offset') || '0');
  const campaigns = listCampaigns(limit, offset);
  return c.json({ campaigns });
});

api.patch('/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  // Separate cookie-related fields for special handling
  const { cookieJson, senderUsername, ...rest } = body;

  const fields: string[] = [];
  const params: any[] = [];
  for (const [key, val] of Object.entries(rest)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = ?`);
    params.push(typeof val === 'object' ? JSON.stringify(val) : val);
  }

  // Handle senderUsername → also sync dm_accounts
  if (senderUsername !== undefined) {
    fields.push('sender_username = ?');
    params.push(senderUsername);
  }

  // Handle cookieJson → also sync dm_accounts and validate
  if (cookieJson !== undefined) {
    fields.push('cookie_json = ?');
    params.push(cookieJson);

    if (cookieJson) {
      try {
        const parsed = JSON.parse(cookieJson);
        const cm = new CookieManager();
        const cookies = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, value]) => ({ name, value }));
        const campaign = getCampaign(id);
        const platform = rest.platform || campaign?.platform || 'instagram';
        const username = senderUsername || campaign?.sender_username;

        if (username) {
          cm.saveAccountCookies(platform, username, cookies);
          const validation = cm.validateCookies(platform, username);
          fields.push('cookie_status = ?');
          params.push(validation.valid ? 'valid' : 'expired');
          fields.push('cookie_last_checked_at = ?');
          params.push(new Date().toISOString());
          if (validation.expiresAt) {
            fields.push('cookie_expires_at = ?');
            params.push(validation.expiresAt);
          }

          // Sync dm_accounts
          addDMAccount(platform, username);
          const acct = db.prepare('SELECT id FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, username) as any;
          if (acct) {
            db.prepare('UPDATE dm_accounts SET cookie_json = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?')
              .run(cookieJson, validation.valid ? 'valid' : 'expired', new Date().toISOString(), acct.id);
          }
        }
      } catch { /* ignore invalid JSON */ }
    }
  } else if (senderUsername) {
    // senderUsername changed without new cookies → sync existing campaign cookies to new account
    const campaign = getCampaign(id);
    if (campaign?.cookie_json && senderUsername !== campaign.sender_username) {
      const platform = rest.platform || campaign.platform;
      addDMAccount(platform, senderUsername);
      const acct = db.prepare('SELECT id FROM dm_accounts WHERE platform = ? AND username = ?').get(platform, senderUsername) as any;
      if (acct) {
        db.prepare('UPDATE dm_accounts SET cookie_json = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?')
          .run(campaign.cookie_json, campaign.cookie_status || 'unknown', new Date().toISOString(), acct.id);
      }
    }
  }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE dm_campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
  return c.json({ message: 'Updated' });
});

api.delete('/campaigns/:id', (c) => {
  const id = c.req.param('id');
  const campaign = getCampaign(id);
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);
  // Don't delete active campaigns
  if (campaign.status === 'active') {
    return c.json({ error: 'Cannot delete an active campaign. Pause it first.' }, 400);
  }
  // Delete queue items, engagement logs, rounds, then campaign
  db.prepare('DELETE FROM dm_action_queue WHERE campaign_id = ?').run(id);
  db.prepare('DELETE FROM dm_engagement_log WHERE campaign_id = ?').run(id);
  db.prepare('DELETE FROM dm_rounds WHERE campaign_id = ?').run(id);
  db.prepare('DELETE FROM dm_campaigns WHERE id = ?').run(id);
  return c.json({ message: 'Campaign deleted' });
});

api.post('/campaigns/:id/queue', (c) => {
  const id = c.req.param('id');
  try {
    const queued = getDmEngine().generateQueue(id);
    return c.json({ queued, message: `${queued} influencers added to queue` });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.post('/campaigns/:id/start', (c) => {
  const id = c.req.param('id');
  getDmEngine().processCampaign(id).catch(err => {
    console.error(`[DM] Campaign ${id} error:`, err);
  });
  return c.json({ message: 'Campaign started' });
});

api.post('/campaigns/:id/pause', (c) => {
  const id = c.req.param('id');
  getDmEngine().pauseCampaign(id);
  return c.json({ message: 'Campaign paused' });
});

// Batch start multiple campaigns
api.post('/campaigns/batch-start', async (c) => {
  const body = await c.req.json();
  const ids: string[] = body.ids || [];
  if (ids.length === 0) return c.json({ error: 'No campaign IDs provided' }, 400);

  const results: Array<{ id: string; name: string; status: string }> = [];
  for (const id of ids) {
    const campaign = db.prepare('SELECT name FROM dm_campaigns WHERE id = ?').get(id) as any;
    if (!campaign) { results.push({ id, name: '?', status: 'not_found' }); continue; }
    try {
      getDmEngine().processCampaign(id).catch(err => {
        console.error(`[DM] Batch campaign ${id} error:`, err);
      });
      results.push({ id, name: campaign.name, status: 'started' });
    } catch (err) {
      results.push({ id, name: campaign.name, status: 'error: ' + (err as Error).message.slice(0, 50) });
    }
  }
  return c.json({ started: results.filter(r => r.status === 'started').length, results });
});

// Batch pause multiple campaigns
api.post('/campaigns/batch-pause', async (c) => {
  const body = await c.req.json();
  const ids: string[] = body.ids || [];
  for (const id of ids) {
    try { getDmEngine().pauseCampaign(id); } catch {}
  }
  return c.json({ paused: ids.length });
});

// ─── DM Accounts ───

api.post('/dm-accounts', async (c) => {
  const body = await c.req.json();
  const { platform, username, sessionFile } = body;
  if (!platform || !username) {
    return c.json({ error: 'Missing required fields: platform, username' }, 400);
  }
  addDMAccount(platform, username, sessionFile);
  return c.json({ message: 'Account added' }, 201);
});

api.get('/dm-accounts', (c) => {
  const platform = c.req.query('platform') || undefined;
  const accounts = listDMAccounts(platform);
  return c.json({ accounts });
});

api.delete('/dm-accounts/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  db.prepare('DELETE FROM dm_accounts WHERE id = ?').run(id);
  return c.json({ message: 'Account deleted' });
});

// ─── Comment Templates ───

api.get('/comment-templates', (c) => {
  const platform = c.req.query('platform') || undefined;
  const category = c.req.query('category') || undefined;
  const templates = listCommentTemplates(platform, category);
  return c.json({ templates });
});

api.post('/comment-templates', async (c) => {
  const body = await c.req.json();
  const { platform, category, template, variables, campaignId } = body;
  if (!platform || !category || !template) {
    return c.json({ error: 'Missing required: platform, category, template' }, 400);
  }
  const id = createCommentTemplate({ platform, category, template, variables, campaignId });
  return c.json({ id, message: 'Template created' }, 201);
});

api.patch('/comment-templates/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { platform, category, template, variables, campaignId } = body;
  updateCommentTemplate(id, { platform, category, template, variables, campaignId });
  return c.json({ message: 'Template updated' });
});

api.delete('/comment-templates/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  deleteCommentTemplate(id);
  return c.json({ message: 'Template deleted' });
});

// ─── DM Account per-account filter update ───

api.patch('/dm-accounts/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  updateDMAccount(id, body);
  return c.json({ message: 'Account updated' });
});

// ─── Campaign Rounds & Engagement Logs ───

api.get('/campaigns/:id/rounds', (c) => {
  const id = c.req.param('id');
  const rounds = getCampaignRounds(id);
  return c.json({ rounds });
});

api.get('/campaigns/:id/engagements', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '100');
  const logs = getEngagementLogs(id, limit);
  return c.json({ engagements: logs });
});

api.post('/campaigns/replenish', (c) => {
  const added = getDmEngine().autoReplenishQueues();
  return c.json({ added, message: `${added} targets added across active campaigns` });
});

// Campaign activity log (recent actions with details)
api.get('/campaigns/:id/activity', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = db.prepare(`
    SELECT q.id, q.influencer_key, q.execute_status, q.engagement_status, q.error_message,
           q.account_username, q.executed_at, q.created_at, q.message_rendered,
           q.liked_post_url, q.comment_text, q.commented_post_url,
           q.reply_detected, q.reply_detected_at,
           m.username, m.full_name, m.followers_count, m.profile_pic_url, m.detected_country, m.ai_country
    FROM dm_action_queue q
    LEFT JOIN influencer_master m ON q.influencer_key = m.influencer_key
    WHERE q.campaign_id = ?
    ORDER BY
      CASE q.execute_status
        WHEN 'processing' THEN 0
        WHEN 'success' THEN 1
        WHEN 'failed' THEN 2
        ELSE 3
      END,
      q.executed_at DESC, q.id DESC
    LIMIT ?
  `).all(id, limit) as any[];

  const summary = db.prepare(`
    SELECT execute_status, COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? GROUP BY execute_status
  `).all(id) as any[];

  const replyCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM dm_action_queue WHERE campaign_id = ? AND reply_detected = 1`
  ).get(id) as any)?.cnt || 0;

  return c.json({ activity: rows, summary: Object.fromEntries(summary.map((s: any) => [s.execute_status, s.cnt])), replyCount });
});

// Campaign targets (assigned influencers)
api.get('/campaigns/:id/targets', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const result = getCampaignTargets(id, { limit, offset });
  return c.json(result);
});

// Campaign-level cookie upload
api.post('/campaigns/:id/upload-cookies', async (c) => {
  const id = c.req.param('id');
  const campaign = getCampaign(id);
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

  try {
    const body = await c.req.json();
    const { cookies: cookieData, senderUsername } = body;
    if (!cookieData) return c.json({ error: 'No cookie data provided' }, 400);

    const username = senderUsername || campaign.sender_username;
    if (!username) return c.json({ error: 'Sender username required' }, 400);

    // Parse and save cookies
    const parsed = JSON.parse(cookieData);
    const cm = new CookieManager();
    const cookies = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, value]) => ({ name, value }));

    // Save per-account cookies (for DM sending)
    cm.saveAccountCookies(campaign.platform, username, cookies);

    // Validate
    const validation = cm.validateCookies(campaign.platform, username);
    const status = validation.valid ? 'valid' : 'expired';

    // Update campaign
    updateCampaignCookie(id, cookieData, status, validation.expiresAt);
    db.prepare(`UPDATE dm_campaigns SET sender_username = ? WHERE id = ?`).run(username, id);

    // Sync to dm_accounts
    addDMAccount(campaign.platform, username);
    const acct = (db.prepare('SELECT id FROM dm_accounts WHERE platform = ? AND username = ?').get(campaign.platform, username) as any);
    if (acct) {
      db.prepare(`UPDATE dm_accounts SET cookie_file = ?, cookie_status = ?, cookie_last_checked_at = ?, status = 'active' WHERE id = ?`)
        .run(`cookies/${campaign.platform}/${username}.json`, status, new Date().toISOString(), acct.id);
    }

    return c.json({ message: 'Cookies uploaded', status, missingCookies: validation.missingCookies, expiresAt: validation.expiresAt });
  } catch (err) {
    return c.json({ error: `Failed: ${(err as Error).message}` }, 400);
  }
});

// Campaign cookie health check
api.get('/campaigns/:id/cookie-json', (c) => {
  const id = c.req.param('id');
  const campaign = getCampaign(id);
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);
  const json = getCampaignCookieJson(id);
  return c.json({ cookieJson: json || null, senderUsername: campaign.sender_username || null, cookieStatus: campaign.cookie_status || 'unknown' });
});

api.post('/campaigns/:id/check-cookies', (c) => {
  const id = c.req.param('id');
  const campaign = getCampaign(id);
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404);
  if (!campaign.sender_username) return c.json({ error: 'No sender account configured' }, 400);

  const cm = new CookieManager();
  const validation = cm.validateCookies(campaign.platform, campaign.sender_username);
  const status = validation.valid ? 'valid' : (cm.hasAccountCookies(campaign.platform, campaign.sender_username) ? 'expired' : 'unknown');
  db.prepare(`UPDATE dm_campaigns SET cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), id);

  return c.json({ platform: campaign.platform, username: campaign.sender_username, status, missingCookies: validation.missingCookies });
});

// ─── Cookie Health ───

api.get('/cookie-health', (c) => {
  // Return all DM accounts with cookie status
  const accounts = db.prepare(
    `SELECT id, platform, username, cookie_status, cookie_last_checked_at, cookie_expires_at, cookie_file
     FROM dm_accounts ORDER BY platform, username`
  ).all() as any[];
  return c.json({ accounts });
});

api.post('/cookie-health/:platform/:username/check', async (c) => {
  const platform = c.req.param('platform');
  const username = c.req.param('username');

  const chs = registry.cookieHealthService;
  if (!chs) {
    // Fallback: validate cookies directly
    const cm = new CookieManager();
    const validation = cm.validateCookies(platform, username);
    const now = new Date().toISOString();
    const status = validation.valid ? 'valid' : (cm.hasAccountCookies(platform, username) ? 'expired' : 'unknown');
    db.prepare(`UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ? WHERE platform = ? AND username = ?`)
      .run(status, now, platform, username);
    return c.json({ platform, username, status, missingCookies: validation.missingCookies, expiresAt: validation.expiresAt });
  }

  const result = await chs.checkAccount(platform, username);
  return c.json(result);
});

api.post('/dm-accounts/:id/upload-cookies', async (c) => {
  const id = parseInt(c.req.param('id'));

  // Get account info
  const account = db.prepare('SELECT * FROM dm_accounts WHERE id = ?').get(id) as any;
  if (!account) return c.json({ error: 'Account not found' }, 404);

  try {
    let cookieData: string;
    const contentType = c.req.header('content-type') || '';

    if (contentType.includes('application/json')) {
      const jsonBody = await c.req.json();
      cookieData = typeof jsonBody.cookies === 'string' ? jsonBody.cookies : JSON.stringify(jsonBody.cookies);
    } else {
      const body = await c.req.parseBody();
      const file = body['file'];
      if (file && typeof file === 'object' && 'text' in file) {
        cookieData = await (file as File).text();
      } else if (typeof body.cookies === 'string') {
        cookieData = body.cookies;
      } else {
        return c.json({ error: 'No cookie data provided. Send as JSON body or file upload with "cookies" field' }, 400);
      }
    }

    // Parse and save cookies
    const parsed = JSON.parse(cookieData);
    const cm = new CookieManager();
    const cookies = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, value]) => ({ name, value }));
    cm.saveAccountCookies(account.platform, account.username, cookies);

    // Update DB
    const cookieFile = `cookies/${account.platform}/${account.username}.json`;
    const now = new Date().toISOString();
    db.prepare(`UPDATE dm_accounts SET cookie_file = ?, cookie_status = 'unknown', cookie_last_checked_at = ? WHERE id = ?`)
      .run(cookieFile, now, id);

    // Validate immediately
    const validation = cm.validateCookies(account.platform, account.username);
    const status = validation.valid ? 'valid' : 'expired';
    db.prepare(`UPDATE dm_accounts SET cookie_status = ?, cookie_expires_at = ? WHERE id = ?`)
      .run(status, validation.expiresAt || null, id);

    // Re-activate if was cookie_expired
    if (status === 'valid' && account.status === 'cookie_expired') {
      db.prepare(`UPDATE dm_accounts SET status = 'active' WHERE id = ?`).run(id);
    }

    return c.json({
      message: 'Cookies uploaded',
      cookieFile,
      status,
      missingCookies: validation.missingCookies,
      expiresAt: validation.expiresAt,
    });
  } catch (err) {
    return c.json({ error: `Failed to process cookies: ${(err as Error).message}` }, 400);
  }
});

// ─── Dashboard Stats (aggregate endpoint) ───

api.get('/dashboard/stats', (c) => {
  const totalInfluencers = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master').get() as any).cnt;
  const aiClassified = (db.prepare('SELECT COUNT(*) as cnt FROM influencer_master WHERE ai_classified_at IS NOT NULL').get() as any).cnt;

  const campaigns = db.prepare('SELECT status, COUNT(*) as cnt FROM dm_campaigns GROUP BY status').all() as any[];
  const campaignMap = Object.fromEntries(campaigns.map((c: any) => [c.status, c.cnt]));

  const dmStats = db.prepare(`
    SELECT
      SUM(CASE WHEN execute_status = 'success' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN execute_status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN execute_status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM dm_action_queue
  `).get() as any;

  const keywords = db.prepare('SELECT COUNT(*) as cnt FROM keyword_targets WHERE is_active = 1').get() as any;
  const totalExtracted = (db.prepare('SELECT SUM(total_extracted) as total FROM keyword_targets').get() as any)?.total || 0;

  // Scraping success rate: (completed jobs with resultCount > 0) / (total completed jobs)
  const scrapingStats = db.prepare(`
    SELECT
      COUNT(*) as totalCompleted,
      SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) as successCount
    FROM jobs WHERE status = 'completed'
  `).get() as any;
  const scrapingSuccessRate = scrapingStats?.totalCompleted > 0
    ? Math.round((scrapingStats.successCount / scrapingStats.totalCompleted) * 100)
    : 0;

  return c.json({
    totalInfluencers,
    aiClassified,
    activeCampaigns: (campaignMap.active || 0) + (campaignMap.processing || 0),
    totalCampaigns: campaigns.reduce((a: number, c: any) => a + c.cnt, 0),
    totalSent: dmStats?.sent || 0,
    totalFailed: dmStats?.failed || 0,
    totalPending: dmStats?.pending || 0,
    activeKeywords: keywords?.cnt || 0,
    totalExtracted,
    scrapingSuccessRate,
    scrapingTotalCompleted: scrapingStats?.totalCompleted || 0,
  });
});

// Recent activity feed for dashboard
api.get('/dashboard/activity', (c) => {
  try {
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 50);
  const activities: { type: string; message: string; ts: string }[] = [];

  // Recent scraping jobs (last 24h)
  try {
    const recentJobs = db.prepare(`
      SELECT id, platform, query, status, result_count, created_at, completed_at
      FROM jobs WHERE created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC LIMIT 20
    `).all() as any[];

    for (const j of recentJobs) {
      if (j.status === 'completed' || j.status === 'done') {
        activities.push({
          type: 'scraping_completed',
          message: `스크래핑 완료: ${j.query} (${j.platform}) — ${j.result_count || 0}건`,
          ts: j.completed_at || j.created_at,
        });
      } else if (j.status === 'running') {
        activities.push({
          type: 'scraping_started',
          message: `스크래핑 진행중: ${j.query} (${j.platform})`,
          ts: j.created_at,
        });
      } else if (j.status === 'failed') {
        activities.push({
          type: 'scraping_failed',
          message: `스크래핑 실패: ${j.query} (${j.platform})`,
          ts: j.completed_at || j.created_at,
        });
      }
    }
  } catch { /* jobs table query error */ }

  // Recent DM actions (last 24h)
  try {
    const recentDMs = db.prepare(`
      SELECT q.execute_status, q.executed_at, q.account_username,
             m.username as recipient_username,
             c.name as campaign_name, c.platform
      FROM dm_action_queue q
      JOIN dm_campaigns c ON q.campaign_id = c.id
      LEFT JOIN influencer_master m ON q.influencer_key = m.influencer_key
      WHERE q.executed_at > datetime('now', '-24 hours')
      ORDER BY q.executed_at DESC LIMIT 20
    `).all() as any[];

    for (const d of recentDMs) {
      if (d.execute_status === 'success') {
        activities.push({
          type: 'dm_sent',
          message: `DM 발송: @${d.recipient_username || '?'} (${d.campaign_name})`,
          ts: d.executed_at,
        });
      } else if (d.execute_status === 'failed') {
        activities.push({
          type: 'dm_failed',
          message: `DM 실패: @${d.recipient_username || '?'} (${d.campaign_name})`,
          ts: d.executed_at,
        });
      }
    }
  } catch { /* dm_action_queue may not exist yet */ }

  // Recent AI classifications (last 24h)
  try {
    const recentAI = db.prepare(`
      SELECT COUNT(*) as cnt, MAX(ai_classified_at) as last_at
      FROM influencer_master
      WHERE ai_classified_at > datetime('now', '-24 hours')
    `).get() as any;

    if (recentAI?.cnt > 0) {
      activities.push({
        type: 'auto_assign',
        message: `AI 분류 완료: ${recentAI.cnt}명 분류됨`,
        ts: recentAI.last_at,
      });
    }
  } catch { /* AI classification query error */ }

  // Sort by timestamp descending
  activities.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  return c.json({ activities: activities.slice(0, limit) });
  } catch (err) {
    console.error('[Dashboard Activity Error]', err);
    return c.json({ activities: [], error: (err as Error).message });
  }
});

// ─── Debug: Server Logs ───

api.get('/debug/logs', async (c) => {
  const { getRecentLogs } = await import('../../utils/logger.js');
  const filter = c.req.query('filter') || '';
  const logs = getRecentLogs(filter);
  return c.json({ count: logs.length, logs });
});

// ─── Debug: Scrape Test ───

api.post('/debug/scrape-test/:platform', async (c) => {
  const platform = c.req.param('platform') as Platform;
  if (!VALID_PLATFORMS.includes(platform)) {
    return c.json({ error: 'Invalid platform' }, 400);
  }

  const diag: Record<string, any> = {
    platform,
    startedAt: new Date().toISOString(),
    steps: [] as string[],
  };

  try {
    // Step 1: Check cookies in DB
    const cm = new CookieManager();
    const hasCookies = cm.hasCookies(platform);
    diag.hasCookies = hasCookies;
    diag.steps.push(`hasCookies(${platform}) = ${hasCookies}`);

    if (hasCookies) {
      const cookies = cm.loadCookies(platform);
      diag.cookieCount = cookies.length;
      diag.cookieNames = cookies.map(c => c.name);
      diag.steps.push(`Loaded ${cookies.length} cookies: ${cookies.map(c => c.name).join(', ')}`);

      // Check critical cookies
      const critical = cm.getCriticalCookieNames(platform);
      const cookieNameSet = new Set(cookies.map(c => c.name));
      const missing = critical.filter(n => !cookieNameSet.has(n));
      diag.criticalCookies = critical;
      diag.missingCritical = missing;
      diag.steps.push(`Critical cookies: ${critical.join(', ')} — missing: ${missing.length > 0 ? missing.join(', ') : 'none'}`);

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      const expired = cookies.filter(c => c.expires && c.expires < now);
      diag.expiredCookies = expired.map(c => ({ name: c.name, expires: new Date((c.expires || 0) * 1000).toISOString() }));
      if (expired.length > 0) {
        diag.steps.push(`WARNING: ${expired.length} cookies expired: ${expired.map(c => c.name).join(', ')}`);
      }
    } else {
      diag.steps.push(`No cookies found for ${platform} — scraping will likely fail (login required)`);
    }

    // Step 2: Test Playwright browser launch
    const { StealthBrowser } = await import('../../core/anti-detection/index.js');
    const { ProxyRouter } = await import('../../core/proxy.js');
    const { randomUUID } = await import('crypto');

    // Load proxies from DB
    let proxyUrls: string[] = [];
    try {
      const rows = db.prepare('SELECT url FROM proxy_settings WHERE is_active = 1').all() as any[];
      proxyUrls = rows.map((r: any) => r.url).filter(Boolean);
    } catch {}
    diag.proxyCount = proxyUrls.length;
    diag.steps.push(`Loaded ${proxyUrls.length} proxies from DB`);

    const proxyRouter = new ProxyRouter(proxyUrls);
    const browser = new StealthBrowser(proxyRouter);

    diag.steps.push('Launching Playwright browser...');
    const launchStart = Date.now();
    await browser.launch({ headless: true });
    diag.browserLaunchMs = Date.now() - launchStart;
    diag.steps.push(`Browser launched in ${diag.browserLaunchMs}ms`);

    const sessionId = randomUUID();
    const proxy = proxyRouter.getProxyForPlatform(platform);
    if (proxy) {
      diag.proxyUsed = `${proxy.protocol}://${proxy.host}:${proxy.port} (type: ${proxy.type}, provider: ${proxy.provider})`;
      diag.proxyPlaywright = proxyRouter.toPlaywrightProxy(proxy);
      diag.proxyPlaywright.password = '***';
    } else {
      diag.proxyUsed = 'NONE';
    }
    diag.steps.push(`Proxy for ${platform}: ${diag.proxyUsed}`);
    await browser.createStealthContext(sessionId, { region: 'US', proxy });

    // Set cookies
    if (hasCookies) {
      const cookies = cm.loadCookies(platform);
      await browser.setCookies(sessionId, cm.toPlaywrightCookies(cookies));
      diag.steps.push(`Set ${cookies.length} cookies on browser context`);
    }

    const page = await browser.createPage(sessionId, {});

    // Step 3: Navigate to platform homepage
    const urls: Record<string, string> = {
      instagram: 'https://www.instagram.com/',
      twitter: 'https://x.com/home',
      tiktok: 'https://www.tiktok.com/',
      youtube: 'https://www.youtube.com/',
      xiaohongshu: 'https://www.xiaohongshu.com/',
      linkedin: 'https://www.linkedin.com/',
    };

    const testUrl = urls[platform] || `https://www.${platform}.com/`;
    diag.steps.push(`Navigating to ${testUrl}...`);
    const navStart = Date.now();
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    diag.navigationMs = Date.now() - navStart;

    // Wait a bit for redirects
    await new Promise(r => setTimeout(r, 3000));

    const finalUrl = page.url();
    const pageTitle = await page.title();
    diag.finalUrl = finalUrl;
    diag.pageTitle = pageTitle;
    diag.steps.push(`Page loaded: ${finalUrl} — title: "${pageTitle}" (${diag.navigationMs}ms)`);

    // Check for login redirect
    const loginIndicators = ['/login', '/accounts/login', '/i/flow/login', 'signin', '/challenge'];
    const isLoginRedirect = loginIndicators.some(ind => finalUrl.includes(ind));
    diag.isLoginRedirect = isLoginRedirect;
    if (isLoginRedirect) {
      diag.steps.push(`REDIRECT TO LOGIN DETECTED — cookies are expired or invalid!`);
    } else {
      diag.steps.push(`No login redirect — session appears valid`);
    }

    // Step 4: Try a quick search if logged in
    if (!isLoginRedirect) {
      const searchUrls: Record<string, string> = {
        instagram: 'https://www.instagram.com/popular/kbeauty/',
        twitter: 'https://x.com/search?q=test&src=typed_query&f=live',
        tiktok: 'https://www.tiktok.com/search?q=test',
        youtube: 'https://www.youtube.com/results?search_query=test',
        xiaohongshu: 'https://www.xiaohongshu.com/search_result?keyword=test',
        linkedin: 'https://www.linkedin.com/search/results/all/?keywords=test',
      };

      const searchUrl = searchUrls[platform];
      if (searchUrl) {
        diag.steps.push(`Testing search: ${searchUrl}...`);
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
          // Fallback if networkidle times out
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        });
        await new Promise(r => setTimeout(r, 8000));

        const searchFinalUrl = page.url();
        const searchTitle = await page.title();
        diag.searchFinalUrl = searchFinalUrl;
        diag.searchTitle = searchTitle;
        diag.steps.push(`Search page: ${searchFinalUrl} — title: "${searchTitle}"`);

        // Check if search page also redirected to login
        const searchLoginRedirect = loginIndicators.some(ind => searchFinalUrl.includes(ind));
        diag.searchLoginRedirect = searchLoginRedirect;
        if (searchLoginRedirect) {
          diag.steps.push(`Search page also redirected to login!`);
        }

        // Check page content for results
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
        diag.bodyTextPreview = bodyText.slice(0, 300);
        diag.steps.push(`Body text preview: "${bodyText.slice(0, 150)}..."`);

        // Step 5: DOM analysis — check what elements exist for data extraction
        const domAnalysis = await page.evaluate((plat: string) => {
          const analysis: Record<string, any> = {};

          if (plat === 'twitter') {
            // Check tweet article elements
            analysis.tweetArticles = document.querySelectorAll('article[data-testid="tweet"]').length;
            analysis.tweetArticlesAlt = document.querySelectorAll('article').length;
            analysis.tweetTexts = document.querySelectorAll('[data-testid="tweetText"]').length;
            analysis.cellInnerDivs = document.querySelectorAll('[data-testid="cellInnerDiv"]').length;
            // Check what data-testid attributes exist
            const testIds = new Set<string>();
            document.querySelectorAll('[data-testid]').forEach(el => testIds.add(el.getAttribute('data-testid') || ''));
            analysis.dataTestIds = Array.from(testIds).slice(0, 30);
            // Sample tweet text
            const firstTweet = document.querySelector('[data-testid="tweetText"]');
            analysis.firstTweetText = firstTweet?.textContent?.slice(0, 100) || null;
          } else if (plat === 'instagram') {
            analysis.articles = document.querySelectorAll('article').length;
            analysis.links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length;
            analysis.jsonScripts = document.querySelectorAll('script[type="application/json"]').length;
            analysis.jsonLd = document.querySelectorAll('script[type="application/ld+json"]').length;
            // Check for ytInitialData (wrong platform but check anyway)
            analysis.hasSharedData = !!(window as any)._sharedData;
          } else if (plat === 'tiktok') {
            analysis.videoCards = document.querySelectorAll('[class*="DivItemContainer"], [data-e2e="search-card-item"]').length;
            analysis.videoLinks = document.querySelectorAll('a[href*="/video/"]').length;
            analysis.hasUniversalData = !!(window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
            analysis.hasSigiState = !!(window as any).SIGI_STATE;
            analysis.searchResultItems = document.querySelectorAll('[class*="search"]').length;
            // Dump UNIVERSAL_DATA structure
            const ud = (window as any).__UNIVERSAL_DATA_FOR_REHYDRATION__;
            if (ud) {
              const ds = ud.__DEFAULT_SCOPE__ || {};
              analysis.universalDataKeys = Object.keys(ud);
              analysis.defaultScopeKeys = Object.keys(ds);
              // Check each scope for data
              for (const key of Object.keys(ds)) {
                const scope = ds[key];
                const scopeKeys = scope ? Object.keys(scope).slice(0, 15) : [];
                analysis[`scope_${key}_keys`] = scopeKeys;
                if (scope?.itemList) analysis[`scope_${key}_itemCount`] = scope.itemList.length;
                if (scope?.data) {
                  const dataKeys = Object.keys(scope.data).slice(0, 10);
                  analysis[`scope_${key}_dataKeys`] = dataKeys;
                  if (scope.data?.itemList) analysis[`scope_${key}_dataItemCount`] = scope.data.itemList.length;
                }
              }
            }
            // Check for other common TikTok data containers
            analysis.hasNextData = !!(window as any).__NEXT_DATA__;
            analysis.allScriptCount = document.querySelectorAll('script').length;
            // Check e2e attributes
            const e2eEls = document.querySelectorAll('[data-e2e]');
            const e2eTypes = new Set<string>();
            e2eEls.forEach(el => e2eTypes.add(el.getAttribute('data-e2e') || ''));
            analysis.e2eAttributes = Array.from(e2eTypes).slice(0, 20);
          } else if (plat === 'youtube') {
            analysis.videoRenderers = document.querySelectorAll('ytd-video-renderer').length;
            analysis.richItemRenderers = document.querySelectorAll('ytd-rich-item-renderer').length;
            analysis.videoLinks = document.querySelectorAll('a[href*="watch?v="]').length;
            analysis.hasYtInitialData = !!(window as any).ytInitialData;
          }

          return analysis;
        }, platform);

        diag.domAnalysis = domAnalysis;
        diag.steps.push(`DOM analysis: ${JSON.stringify(domAnalysis)}`);
      }
    }

    await browser.closeContext(sessionId);
    await browser.closeAll();

    diag.completedAt = new Date().toISOString();
    diag.totalMs = Date.now() - new Date(diag.startedAt).getTime();
    diag.steps.push(`Test completed in ${diag.totalMs}ms`);

    return c.json(diag);
  } catch (err) {
    diag.error = (err as Error).message;
    diag.stack = (err as Error).stack?.split('\n').slice(0, 5);
    diag.steps.push(`ERROR: ${(err as Error).message}`);
    return c.json(diag, 500);
  }
});

// Debug endpoint: run ACTUAL TwitterScraper.searchByHashtag
api.post('/debug/twitter-real-test', async (c) => {
  try {
    const { TwitterScraper } = await import('../../platforms/twitter/index.js');
    const scraper = new TwitterScraper();
    const posts: any[] = [];
    const startTime = Date.now();

    for await (const post of scraper.searchByHashtag('韓国美容', { maxResults: 20 })) {
      posts.push({ id: post.id, caption: post.caption?.slice(0, 80), username: post.owner?.username, likes: post.likesCount });
    }

    return c.json({
      postCount: posts.length,
      durationMs: Date.now() - startTime,
      posts: posts.slice(0, 10),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 5) }, 500);
  }
});

// Debug endpoint: run Twitter scraper's exact DOM extraction logic
api.post('/debug/twitter-dom-test', async (c) => {
  const diag: Record<string, any> = { steps: [] as string[] };

  try {
    const { StealthBrowser } = await import('../../core/anti-detection/index.js');
    const { ProxyRouter } = await import('../../core/proxy.js');
    const { randomUUID } = await import('crypto');

    const cm = new CookieManager();
    const proxyRouter = new ProxyRouter();
    const browser = new StealthBrowser(proxyRouter);

    await browser.launch({ headless: true });
    const sessionId = randomUUID();
    await browser.createStealthContext(sessionId, { region: 'US' });

    // Load cookies
    if (cm.hasCookies('twitter')) {
      const cookies = cm.loadCookies('twitter');
      await browser.setCookies(sessionId, cm.toPlaywrightCookies(cookies));
      diag.steps.push(`Set ${cookies.length} cookies`);
    }

    // Create page WITH interceptResponses (same as actual scraper)
    let interceptedCount = 0;
    const apiTweets: any[] = [];
    const page = await browser.createPage(sessionId, {
      interceptResponses: (url, body) => {
        if (url.includes('/graphql/') || url.includes('/i/api/') || url.includes('SearchTimeline') || url.includes('adaptive.json')) {
          interceptedCount++;
          diag.steps.push(`API intercepted: ${url.split('?')[0].slice(-60)} (${body.length} bytes)`);
        }
      },
    });

    // Navigate DIRECTLY to search (same as scraper - NOT home first)
    const searchUrl = 'https://x.com/search?q=%E9%9F%93%E5%9B%BD%E7%BE%8E%E5%AE%B9&src=typed_query&f=live';
    diag.steps.push(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    diag.steps.push(`Page loaded, waiting 6s...`);
    await new Promise(r => setTimeout(r, 6000));

    const currentUrl = page.url();
    const pageTitle = await page.title();
    diag.steps.push(`URL: ${currentUrl}, Title: "${pageTitle}"`);
    diag.interceptedCount = interceptedCount;

    // waitForSelector (same as scraper)
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
      diag.steps.push('waitForSelector: found tweets');
    } catch {
      diag.steps.push('waitForSelector: TIMED OUT - no tweets in DOM');
    }

    // DOM extraction (same as scraper's extractTweetsFromDOM)
    const domResult = await page.evaluate(() => {
      const results: any[] = [];
      const debug: string[] = [];
      const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
      debug.push(`article[data-testid="tweet"]: ${tweetEls.length}`);
      debug.push(`all articles: ${document.querySelectorAll('article').length}`);
      debug.push(`tweetText elements: ${document.querySelectorAll('[data-testid="tweetText"]').length}`);
      debug.push(`URL: ${window.location.href}`);

      tweetEls.forEach((el: Element) => {
        try {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const text = textEl?.textContent || '';
          const userLinks = el.querySelectorAll('a[href^="/"]');
          let username = '';
          for (const link of userLinks) {
            const href = (link as HTMLAnchorElement).href || '';
            const match = href.match(/\/([A-Za-z0-9_]+)$/);
            if (match && !['search', 'explore', 'home', 'notifications', 'messages', 'i', 'settings'].includes(match[1])) {
              username = match[1];
              break;
            }
          }
          let tweetId = '';
          const timeEl = el.querySelector('time');
          if (timeEl) {
            const parentLink = timeEl.closest('a');
            if (parentLink) {
              const idMatch = parentLink.href?.match(/\/status\/(\d+)/);
              if (idMatch) tweetId = idMatch[1];
            }
          }
          const timestamp = timeEl?.getAttribute('datetime') || '';
          if (username || text) {
            results.push({ id: tweetId, text: text.slice(0, 100), username, timestamp });
          }
        } catch {}
      });

      return { results, debug };
    });

    diag.domDebug = domResult.debug;
    diag.domTweets = domResult.results;
    diag.domTweetCount = domResult.results.length;
    diag.steps.push(`DOM extraction: ${domResult.results.length} tweets`);

    await browser.closeContext(sessionId);
    await browser.closeAll();
    return c.json(diag);
  } catch (err) {
    diag.error = (err as Error).message;
    return c.json(diag, 500);
  }
});

// ─── Proxy Management ───

api.get('/proxies', (c) => {
  const proxies = db.prepare('SELECT * FROM proxy_settings ORDER BY is_active DESC, created_at DESC').all();
  return c.json(proxies);
});

api.post('/proxies', async (c) => {
  const { name, url, type, provider, country } = await c.req.json();
  if (!name || !url) return c.json({ error: 'name and url required' }, 400);
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO proxy_settings (name, url, type, provider, country, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(name, url, type || 'residential', provider || 'custom', country || null, now, now);
  return c.json({ id: result.lastInsertRowid, name, url, type, provider, country });
});

api.patch('/proxies/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const sets: string[] = [];
  const params: any[] = [];
  for (const key of ['name', 'url', 'type', 'provider', 'country', 'is_active']) {
    if (body[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (sets.length === 0) return c.json({ error: 'nothing to update' }, 400);
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE proxy_settings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return c.json({ ok: true });
});

api.delete('/proxies/:id', (c) => {
  const id = c.req.param('id');
  db.prepare('DELETE FROM proxy_settings WHERE id = ?').run(id);
  return c.json({ ok: true });
});

// ─── Scheduler Control ───

api.post('/scheduler/pause', (c) => {
  scheduler.stop();
  return c.json({ message: 'Scheduler stopped' });
});

api.post('/scheduler/resume', (c) => {
  scheduler.start();
  return c.json({ message: 'Scheduler started' });
});

export { api };
