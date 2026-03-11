import { Hono } from 'hono';
import type { Platform } from '../../core/types.js';
import { CookieManager } from '../../core/cookie-manager.js';
import { listJobs, getJob, getJobPosts, getJobProfiles, deleteJob, getAllProfiles, getProfileStats, getMissingProfileUsernames } from '../services/db.js';
import { jobManager } from '../services/job-manager.js';
import { exportCSV, exportXLSX } from '../services/export.js';
import { migrateProfilesToMaster, getInfluencers, getInfluencerStats, updateInfluencerGeo, listKeywordTargets, createKeywordTarget, updateKeywordTarget, deleteKeywordTarget } from '../services/master-db.js';
import { GeoClassifier } from '../../core/geo-classifier.js';
import { db } from '../services/db.js';
import { scheduler } from '../../services/scheduler.js';

const api = new Hono();
const cookieManager = new CookieManager();

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
    return new Response(buffer, {
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
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sortBy = c.req.query('sortBy') || 'followers';
  const order = (c.req.query('order') || 'desc') as 'asc' | 'desc';

  const result = getInfluencers({ platform, country, tier, dmStatus, search, limit, offset, sortBy, order });
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

// ─── Keyword Targets ───

api.get('/keywords', (c) => {
  const targets = listKeywordTargets();
  return c.json({ targets });
});

api.post('/keywords', async (c) => {
  const body = await c.req.json();
  const { pairId, platform, region, keyword, scrapingCycleHours, maxResultsPerRun } = body;
  if (!pairId || !platform || !region || !keyword) {
    return c.json({ error: 'Missing required fields: pairId, platform, region, keyword' }, 400);
  }
  try {
    const id = createKeywordTarget({ pairId, platform, region, keyword, scrapingCycleHours, maxResultsPerRun });
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

export { api };
