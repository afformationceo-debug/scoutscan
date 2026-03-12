import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { api } from './routes/api.js';
import { sse } from './routes/sse.js';
import { pages } from './routes/pages.js';
import { recoverStuckJobs } from './services/db.js';
import { scheduler } from '../services/scheduler.js';

// ─── Browser Context Pool + Engine Initialization ───

import { ProxyRouter } from '../core/proxy.js';
import { StealthBrowser } from '../core/anti-detection/stealth-browser.js';
import { CookieManager } from '../core/cookie-manager.js';
import { BrowserContextPool } from '../services/browser-context-pool.js';
import { DMEngine } from '../services/dm-engine.js';
import { EngagementEngine } from '../services/engagement-engine.js';
import { CookieHealthService } from '../services/cookie-health.js';
import { registry } from '../services/registry.js';

// 1. Create shared infrastructure
const proxyRouter = new ProxyRouter();
const stealthBrowser = new StealthBrowser(proxyRouter);
const cookieManager = new CookieManager();

// 2. Create BrowserContextPool (40 concurrent contexts)
const pool = new BrowserContextPool(stealthBrowser, cookieManager, 40);

// 3. Create engines with pool injection
const dmEngine = new DMEngine(pool);
const engagementEngine = new EngagementEngine(pool);
dmEngine.setEngagementEngine(engagementEngine);

// 4. Create and start CookieHealthService
const cookieHealthService = new CookieHealthService(cookieManager);

// 5. Register all services in the shared registry
registry.dmEngine = dmEngine;
registry.engagementEngine = engagementEngine;
registry.pool = pool;
registry.cookieHealthService = cookieHealthService;

const app = new Hono();

// Middleware
app.use('*', cors());

// Static files
app.use('/public/*', serveStatic({ root: 'src/web/' }));

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
    /          - Dashboard
    /search    - Hashtag Search
    /profiles  - Profile Lookup
    /history   - Scraping History
    /settings  - Cookie Settings

  Browser Pool: max 40 concurrent contexts
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

  // Drain all browser contexts (saves cookies)
  await pool.drainAll();

  // Close stealth browser
  await stealthBrowser.closeAll();

  console.log('Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
