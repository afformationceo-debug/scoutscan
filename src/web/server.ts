import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { api } from './routes/api.js';
import { sse } from './routes/sse.js';
import { pages } from './routes/pages.js';
import { recoverStuckJobs, migrateCookiesFromFilesystemToDB, db } from './services/db.js';
import { scheduler } from '../services/scheduler.js';
import { seedInitialUser, authenticateUser, createSession, validateSession, deleteSession } from './services/auth.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Browser Context Pool + Engine Initialization ───

import { ProxyRouter } from '../core/proxy.js';
import { StealthBrowser } from '../core/anti-detection/stealth-browser.js';
import { CookieManager } from '../core/cookie-manager.js';
import { cookieDbAdapter } from './services/db.js';
import { BrowserContextPool } from '../services/browser-context-pool.js';
import { DMEngine } from '../services/dm-engine.js';
import { EngagementEngine } from '../services/engagement-engine.js';
import { CookieHealthService } from '../services/cookie-health.js';
import { registry } from '../services/registry.js';

// 0. Connect CookieManager to DB (must happen before any CookieManager instance is used)
CookieManager.setDbAdapter(cookieDbAdapter);

// 0.5. One-time migration: filesystem cookies → DB (runs on first boot after upgrade)
const migratedCookies = migrateCookiesFromFilesystemToDB();
if (migratedCookies > 0) console.log(`[Startup] Migrated ${migratedCookies} cookie file(s) from filesystem to DB`);

// 1. Create shared infrastructure (load proxies from DB)
let proxyUrls: string[] = [];
try {
  const proxyRows = db.prepare('SELECT url FROM proxy_settings WHERE is_active = 1').all() as any[];
  proxyUrls = proxyRows.map((r: any) => r.url).filter(Boolean);
  if (proxyUrls.length > 0) console.log(`[Startup] Loaded ${proxyUrls.length} proxy(s) from DB`);
} catch {
  // Table may not exist yet on first boot
}
const proxyRouter = new ProxyRouter(proxyUrls);
const cookieManager = new CookieManager();

// 2. Create SEPARATE browser processes for DM and Scraping (crash isolation)
//    DM Chromium crash → scraping unaffected
//    Scraping Chromium crash → DM unaffected
const dmBrowser = new StealthBrowser(proxyRouter);
const scrapingBrowser = new StealthBrowser(new ProxyRouter(proxyUrls));

// 3. Create BrowserContextPool for DM (40 concurrent contexts)
const pool = new BrowserContextPool(dmBrowser, cookieManager, 40);

// 4. Create engines with pool injection
const dmEngine = new DMEngine(pool);
const engagementEngine = new EngagementEngine(pool);
dmEngine.setEngagementEngine(engagementEngine);

// 5. Create and start CookieHealthService
const cookieHealthService = new CookieHealthService(cookieManager);

// 6. Register all services in the shared registry
registry.dmEngine = dmEngine;
registry.engagementEngine = engagementEngine;
registry.pool = pool;
registry.cookieHealthService = cookieHealthService;
registry.scrapingBrowser = scrapingBrowser;

// Seed initial user (creates user + migrates existing data)
seedInitialUser();

const app = new Hono();

// Middleware
app.use('*', cors());

// Static files
app.use('/public/*', serveStatic({ root: 'src/web/' }));

// ─── Health Check (no auth, used by Railway) ───
app.get('/health', (c) => c.json({ status: 'ok' }));

// ─── Login Page & Auth Routes (no auth required) ───

const loginViewPath = join(import.meta.dirname, 'views', 'login.html');

app.get('/login', (c) => {
  // If already logged in, redirect to dashboard
  const sessionId = getCookie(c, 'session_id');
  if (sessionId) {
    const user = validateSession(sessionId);
    if (user) return c.redirect('/');
  }
  const html = readFileSync(loginViewPath, 'utf-8');
  return c.html(html);
});

app.post('/login', async (c) => {
  const body = await c.req.json();
  const { email, password } = body;

  if (!email || !password) {
    return c.json({ success: false, error: '이메일과 비밀번호를 입력하세요.' }, 400);
  }

  const user = authenticateUser(email, password);
  if (!user) {
    return c.json({ success: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const sessionId = createSession(user.id);
  setCookie(c, 'session_id', sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60, // 7 days
    secure: process.env.NODE_ENV === 'production',
  });

  return c.json({ success: true, user: { email: user.email, name: user.name } });
});

app.get('/logout', (c) => {
  const sessionId = getCookie(c, 'session_id');
  if (sessionId) {
    deleteSession(sessionId);
    deleteCookie(c, 'session_id', { path: '/' });
  }
  return c.redirect('/login');
});

// ─── Auth Middleware (protect everything else) ───

app.use('*', async (c, next) => {
  // Skip auth for login, static files, health check
  const path = c.req.path;
  if (path === '/login' || path === '/health' || path.startsWith('/public/')) {
    return next();
  }

  const sessionId = getCookie(c, 'session_id');
  const user = sessionId ? validateSession(sessionId) : null;

  if (!user) {
    // API requests get 401, page requests get redirected
    if (path.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.redirect('/login');
  }

  // Store user in context for downstream use
  c.set('user' as any, user);
  c.set('userId' as any, user.id);
  return next();
});

// API routes
app.route('/api', api);
app.route('/api', sse);

// Page routes
app.route('/', pages);

// Recover jobs stuck from previous server crash
const recovered = recoverStuckJobs();
if (recovered > 0) console.log(`Recovered ${recovered} stuck job(s) from previous session.`);

// Recover stuck DM campaigns: pause first, then auto-resume after server ready
const recoveredCampaignIds = dmEngine.getActiveCampaignIds();
const recoveredCampaigns = dmEngine.recoverStuckCampaigns();
if (recoveredCampaigns > 0) console.log(`Recovered ${recoveredCampaigns} stuck DM campaign(s) from previous session.`);

// Start server
const port = parseInt(process.env.PORT || '3000');

serve({ fetch: app.fetch, port, serverOptions: { maxHeaderSize: 65536 } }, (info) => {
  console.log(`
  Social Scraper Dashboard
  ========================
  Server running at http://localhost:${info.port}

  Pages:
    /          - Dashboard (Live)
    /data      - Data Management
    /history   - Job History
    /settings  - Settings

  Browser Isolation: DM Chromium + Scraping Chromium (separate processes)
  DM Pool: max 40 concurrent contexts
  Cookie Health: checking every 5 minutes
  `);

  // Start scheduled scraping
  scheduler.start();

  // Start cookie health monitoring
  cookieHealthService.start(300_000); // 5 minutes

  // Auto-resume recovered campaigns after 5s delay
  if (recoveredCampaignIds.length > 0) {
    setTimeout(() => {
      for (const cId of recoveredCampaignIds) {
        console.log(`[AutoResume] Resuming campaign ${cId}`);
        dmEngine.processCampaign(cId).catch(err => {
          console.error(`[AutoResume] Campaign ${cId} error:`, err);
        });
      }
    }, 5000);
  }
});

// ─── Graceful Shutdown ───

async function shutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down...`);

  // Stop cookie health checks
  cookieHealthService.stop();

  // Drain DM browser contexts (saves cookies)
  await pool.drainAll();

  // Close both browser processes
  await dmBrowser.closeAll();
  await scrapingBrowser.closeAll();

  console.log('Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
