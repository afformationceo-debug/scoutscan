import { BrowserContext, Page } from 'playwright';
import { StealthBrowser } from '../core/anti-detection/stealth-browser.js';
import { CookieManager } from '../core/cookie-manager.js';
import { ProxyConfig } from '../core/types.js';
import { logger } from '../utils/logger.js';

interface PoolEntry {
  key: string;
  platform: string;
  username: string;
  sessionId: string;
  context: BrowserContext;
  inUse: boolean;
  lastUsedAt: number;
  pageCount: number;
  cookiesLoaded: boolean;
  cookieCount: number;
}

interface AcquireOptions {
  proxy?: ProxyConfig;
  region?: string;
  blockMedia?: boolean;
}

/**
 * BrowserContextPool — Manages up to 40 concurrent browser contexts
 * wrapping StealthBrowser with per-account cookie persistence.
 *
 * Single Chromium process, multiple BrowserContexts (each with independent cookies/fingerprint).
 */
export class BrowserContextPool {
  private pool = new Map<string, PoolEntry>();
  private stealthBrowser: StealthBrowser;
  private cookieManager: CookieManager;
  private maxConcurrent: number;

  constructor(stealthBrowser: StealthBrowser, cookieManager: CookieManager, maxConcurrent = 40) {
    this.stealthBrowser = stealthBrowser;
    this.cookieManager = cookieManager;
    this.maxConcurrent = maxConcurrent;
  }

  /** Generate pool key from platform and username */
  private key(platform: string, username: string): string {
    return `${platform}:${username}`;
  }

  /**
   * Acquire a browser context for an account.
   * If one already exists and is idle, reuse it. Otherwise create a new one with cookies loaded.
   */
  async acquire(platform: string, username: string, options: AcquireOptions = {}): Promise<PoolEntry> {
    const k = this.key(platform, username);

    // Reuse existing idle entry
    const existing = this.pool.get(k);
    if (existing && !existing.inUse) {
      existing.inUse = true;
      existing.lastUsedAt = Date.now();
      logger.debug(`Pool: reusing context ${k}`);
      return existing;
    }

    // Check capacity
    const activeCount = [...this.pool.values()].filter(e => e.inUse).length;
    if (activeCount >= this.maxConcurrent) {
      // Try to evict an idle entry
      await this.evictIdle();
      const newActive = [...this.pool.values()].filter(e => e.inUse).length;
      if (newActive >= this.maxConcurrent) {
        throw new Error(`Pool full: ${this.maxConcurrent} concurrent contexts in use`);
      }
    }

    // Create new context
    const sessionId = `pool_${platform}_${username}_${Date.now()}`;

    await this.stealthBrowser.launch({
      headless: true,
      proxy: options.proxy,
    });

    const { context } = await this.stealthBrowser.createStealthContext(sessionId, {
      proxy: options.proxy,
      region: options.region || 'US',
    });

    // Load per-account cookies
    const cookies = this.cookieManager.loadAccountCookies(platform, username);
    let cookiesLoaded = false;
    if (cookies.length > 0) {
      const pwCookies = this.cookieManager.toPlaywrightCookies(cookies);
      await this.stealthBrowser.setCookies(sessionId, pwCookies);
      cookiesLoaded = true;
      logger.debug(`Pool: loaded ${cookies.length} cookies for ${k}`);
    } else {
      logger.warn(`Pool: NO cookies found for ${k} — context is unauthenticated`);
    }

    const entry: PoolEntry = {
      key: k,
      platform,
      username,
      sessionId,
      context,
      inUse: true,
      lastUsedAt: Date.now(),
      pageCount: 0,
      cookiesLoaded,
      cookieCount: cookies.length,
    };

    this.pool.set(k, entry);
    logger.info(`Pool: created context ${k} (total: ${this.pool.size})`);
    return entry;
  }

  /** Create a page from a pool entry */
  async createPage(entry: PoolEntry, options: { blockMedia?: boolean } = {}): Promise<Page> {
    const page = await this.stealthBrowser.createPage(entry.sessionId, {
      blockMedia: options.blockMedia ?? true,
      blockImages: options.blockMedia ?? true,
    });
    entry.pageCount++;
    return page;
  }

  /**
   * Release a context back to the pool.
   * Saves updated cookies and marks as idle.
   */
  async release(platform: string, username: string): Promise<void> {
    const k = this.key(platform, username);
    const entry = this.pool.get(k);
    if (!entry) return;

    // Save updated cookies
    try {
      const cookies = await this.stealthBrowser.getCookies(entry.sessionId);
      if (cookies.length > 0) {
        this.cookieManager.saveAccountCookies(platform, username, cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: '/',
        })));
      }
    } catch (err) {
      logger.warn(`Pool: failed to save cookies for ${k}: ${(err as Error).message}`);
    }

    // Close all pages but keep context
    try {
      const pages = entry.context.pages();
      for (const page of pages) {
        await page.close().catch(() => {});
      }
    } catch { /* context may be closed */ }

    entry.inUse = false;
    entry.pageCount = 0;
    entry.lastUsedAt = Date.now();
    // Update cookie count on release (cookies may have been refreshed)
    try {
      const freshCookies = await this.stealthBrowser.getCookies(entry.sessionId);
      entry.cookieCount = freshCookies.length;
      entry.cookiesLoaded = freshCookies.length > 0;
    } catch { /* context may be closed */ }
    logger.debug(`Pool: released ${k}`);
  }

  /** Destroy a context entirely (on error) */
  async destroy(platform: string, username: string): Promise<void> {
    const k = this.key(platform, username);
    const entry = this.pool.get(k);
    if (!entry) return;

    try {
      await this.stealthBrowser.closeContext(entry.sessionId);
    } catch { /* ignore */ }

    this.pool.delete(k);
    logger.info(`Pool: destroyed ${k} (remaining: ${this.pool.size})`);
  }

  /** Evict the oldest idle entry to make room */
  private async evictIdle(): Promise<void> {
    let oldest: PoolEntry | null = null;
    for (const entry of this.pool.values()) {
      if (!entry.inUse) {
        if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
          oldest = entry;
        }
      }
    }
    if (oldest) {
      await this.destroy(oldest.platform, oldest.username);
    }
  }

  /** Drain all contexts (graceful shutdown) */
  async drainAll(): Promise<void> {
    logger.info(`Pool: draining ${this.pool.size} contexts...`);

    for (const entry of this.pool.values()) {
      // Save cookies before closing
      try {
        const cookies = await this.stealthBrowser.getCookies(entry.sessionId);
        if (cookies.length > 0) {
          this.cookieManager.saveAccountCookies(entry.platform, entry.username, cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: '/',
          })));
        }
      } catch { /* ignore */ }

      try {
        await this.stealthBrowser.closeContext(entry.sessionId);
      } catch { /* ignore */ }
    }

    this.pool.clear();
    logger.info('Pool: all contexts drained');
  }

  /** Get pool stats */
  getStats(): { active: number; idle: number; total: number } {
    let active = 0;
    let idle = 0;
    for (const entry of this.pool.values()) {
      if (entry.inUse) active++;
      else idle++;
    }
    return { active, idle, total: this.pool.size };
  }

  /** Check if a context exists for an account */
  has(platform: string, username: string): boolean {
    return this.pool.has(this.key(platform, username));
  }
}
