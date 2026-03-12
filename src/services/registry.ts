import type { DMEngine } from './dm-engine.js';
import type { EngagementEngine } from './engagement-engine.js';
import type { BrowserContextPool } from './browser-context-pool.js';
import type { CookieHealthService } from './cookie-health.js';

/**
 * Service registry — holds shared instances initialized in server.ts.
 * Avoids circular dependencies and allows api.ts to access engines.
 */
class ServiceRegistry {
  dmEngine!: DMEngine;
  engagementEngine!: EngagementEngine;
  pool!: BrowserContextPool;
  cookieHealthService!: CookieHealthService;
}

export const registry = new ServiceRegistry();
