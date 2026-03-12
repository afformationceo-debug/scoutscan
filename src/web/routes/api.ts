import { Hono } from 'hono';
import type { Platform } from '../../core/types.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { listJobs, getJob, getJobPosts, getJobProfiles, deleteJob, getAllProfiles, getProfileStats, getMissingProfileUsernames } from '../services/db.js';
import { jobManager } from '../services/job-manager.js';
import { exportCSV, exportXLSX } from '../services/export.js';
import { migrateProfilesToMaster, getInfluencers, getInfluencerStats, updateInfluencerGeo, listKeywordTargets, createKeywordTarget, updateKeywordTarget, deleteKeywordTarget, createCampaign, listCampaigns, getCampaign, getCampaignCookieJson, updateCampaignCookie, getCampaignTargets, addDMAccount, listDMAccounts, listCommentTemplates, createCommentTemplate, updateCommentTemplate, deleteCommentTemplate, getEngagementLogs, getCampaignRounds, updateDMAccount } from '../services/master-db.js';
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
  const jobId = jobManager.startHashtagJob(platform as Platform, tag, maxResults, enrichProfiles);
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
  const status = cookieManager.getCookieStatus();
  return c.json({ platforms: status });
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
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sortBy = c.req.query('sortBy') || 'followers';
  const order = (c.req.query('order') || 'desc') as 'asc' | 'desc';

  const result = getInfluencers({ platform, country, tier, dmStatus, search, limit, offset, sortBy, order, aiType } as any);
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

  return c.json({ id, message: 'Campaign created' }, 201);
});

api.get('/campaigns', (c) => {
  const campaigns = listCampaigns();
  return c.json({ campaigns });
});

api.patch('/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields: string[] = [];
  const params: any[] = [];
  for (const [key, val] of Object.entries(body)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = ?`);
    params.push(typeof val === 'object' ? JSON.stringify(val) : val);
  }
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE dm_campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
  return c.json({ message: 'Updated' });
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

  return c.json({ activity: rows, summary: Object.fromEntries(summary.map((s: any) => [s.execute_status, s.cnt])) });
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
      db.prepare(`UPDATE dm_accounts SET cookie_file = ?, cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?`)
        .run(`cookies/${campaign.platform}/${username}.json`, status, new Date().toISOString(), acct.id);
    }

    return c.json({ message: 'Cookies uploaded', status, missingCookies: validation.missingCookies, expiresAt: validation.expiresAt });
  } catch (err) {
    return c.json({ error: `Failed: ${(err as Error).message}` }, 400);
  }
});

// Campaign cookie health check
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

export { api };
