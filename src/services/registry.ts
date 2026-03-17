import type { DMEngine } from './dm-engine.js';
import type { EngagementEngine } from './engagement-engine.js';
import type { BrowserContextPool } from './browser-context-pool.js';
import type { CookieHealthService } from './cookie-health.js';
import type { StealthBrowser } from '../core/anti-detection/stealth-browser.js';

/**
 * Service registry — holds shared instances initialized in server.ts.
 * Avoids circular dependencies and allows api.ts to access engines.
 *
 * Browser isolation:
 * - pool (BrowserContextPool) → DM 전용 Chromium process
 * - scrapingBrowser → 스크래핑 전용 Chromium process (별도)
 */
class ServiceRegistry {
  dmEngine!: DMEngine;
  engagementEngine!: EngagementEngine;
  pool!: BrowserContextPool;
  cookieHealthService!: CookieHealthService;
  scrapingBrowser!: StealthBrowser;
}

export const registry = new ServiceRegistry();
