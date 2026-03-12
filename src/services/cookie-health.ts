import { db } from '../web/services/db.js';
import { CookieManager } from '../core/cookie-manager.js';
import { sseManager } from '../web/services/sse-manager.js';
import type { CookieHealthStatus } from '../core/types.js';
import { logger } from '../utils/logger.js';

/**
 * CookieHealthService — Periodically validates cookies for all active DM accounts.
 * Broadcasts status changes via SSE for real-time UI updates.
 */
export class CookieHealthService {
  private cookieManager: CookieManager;
  private intervalId: NodeJS.Timeout | null = null;
  private statusCache = new Map<string, CookieHealthStatus>();

  constructor(cookieManager: CookieManager) {
    this.cookieManager = cookieManager;
  }

  /** Start periodic cookie health checks */
  start(intervalMs = 300_000): void {
    if (this.intervalId) return;

    // Run immediately on start
    this.checkAll().catch(err => logger.error(`Cookie health check failed: ${err.message}`));

    // Then every intervalMs
    this.intervalId = setInterval(() => {
      this.checkAll().catch(err => logger.error(`Cookie health check failed: ${err.message}`));
    }, intervalMs);

    logger.info(`CookieHealthService started (interval: ${intervalMs / 1000}s)`);
  }

  /** Stop periodic checks */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Check all active DM accounts */
  async checkAll(): Promise<void> {
    const accounts = db.prepare(
      `SELECT * FROM dm_accounts WHERE status IN ('active', 'cookie_expired') ORDER BY platform, username`
    ).all() as any[];

    for (const account of accounts) {
      await this.checkAccount(account.platform, account.username);
    }
  }

  /** Check a single account's cookie health */
  async checkAccount(platform: string, username: string): Promise<CookieHealthStatus> {
    const key = `${platform}:${username}`;
    const now = new Date().toISOString();
    const previousStatus = this.statusCache.get(key);

    // Mark as checking
    db.prepare(`UPDATE dm_accounts SET cookie_status = 'checking', cookie_last_checked_at = ? WHERE platform = ? AND username = ?`)
      .run(now, platform, username);

    // Validate cookies — check both per-account AND platform-level cookie files
    let validation = this.cookieManager.validateCookies(platform, username);

    // Fallback: if per-account cookies are missing but platform-level cookies exist, check those
    if (!validation.valid && !this.cookieManager.hasAccountCookies(platform, username) && this.cookieManager.hasCookies(platform)) {
      const platformCookies = this.cookieManager.loadCookies(platform);
      const criticalNames = this.cookieManager.getCriticalCookieNames(platform);
      const cookieNames = new Set(platformCookies.map(c => c.name));
      const missing = criticalNames.filter(name => !cookieNames.has(name));
      validation = { valid: missing.length === 0, missingCookies: missing, expiresAt: validation.expiresAt };
    }

    const status: CookieHealthStatus = {
      platform,
      username,
      status: validation.valid ? 'valid' : (this.cookieManager.hasAccountCookies(platform, username) || this.cookieManager.hasCookies(platform) ? 'expired' : 'unknown'),
      missingCookies: validation.missingCookies,
      expiresAt: validation.expiresAt,
      lastCheckedAt: now,
    };

    // Update cookie_status in DB (NOT the main 'status' field — that's managed by DM engine)
    db.prepare(`UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ?, cookie_expires_at = ? WHERE platform = ? AND username = ?`)
      .run(status.status, now, status.expiresAt || null, platform, username);

    // If valid, auto-reactivate accounts that were marked cookie_expired
    if (status.status === 'valid') {
      db.prepare(`UPDATE dm_accounts SET status = 'active' WHERE platform = ? AND username = ? AND status = 'cookie_expired'`)
        .run(platform, username);
    }

    // Detect status change → broadcast
    if (!previousStatus || previousStatus.status !== status.status) {
      sseManager.broadcast('cookie-health', 'status_change', status);
      logger.info(`Cookie health: ${platform}/@${username} → ${status.status}${validation.missingCookies.length > 0 ? ` (missing: ${validation.missingCookies.join(', ')})` : ''}`);
    }

    this.statusCache.set(key, status);
    return status;
  }

  /** Get all cached statuses */
  getAll(): CookieHealthStatus[] {
    return [...this.statusCache.values()];
  }

  /** Get status for a specific account */
  getStatus(platform: string, username: string): CookieHealthStatus | undefined {
    return this.statusCache.get(`${platform}:${username}`);
  }
}
