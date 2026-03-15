import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * DB adapter interface — allows CookieManager to store/load cookies from DB
 * When set, DB is the primary source of truth; filesystem is best-effort cache.
 */
export interface CookieDbAdapter {
  getPlatformCookieJson(platform: string): string | null;
  savePlatformCookieJson(platform: string, json: string, count: number): void;
  getAccountCookieJson(platform: string, username: string): string | null;
  saveAccountCookieJson(platform: string, username: string, json: string, count: number): void;
  hasAccountCookie(platform: string, username: string): boolean;
}

/**
 * Cookie Manager - DB-first cookie storage with filesystem cache
 *
 * Architecture:
 * - DB is the primary source of truth (survives deploys/restarts)
 * - Filesystem is a best-effort cache (may be wiped on ephemeral hosts)
 * - On load: try DB first, fallback to filesystem
 * - On save: always save to DB, also try filesystem
 */
export class CookieManager {
  private cookieDir: string;
  private static _dbAdapter: CookieDbAdapter | null = null;

  constructor(cookieDir?: string) {
    this.cookieDir = cookieDir || join(process.cwd(), 'cookies');
  }

  /** Set the global DB adapter — call once during server initialization */
  static setDbAdapter(adapter: CookieDbAdapter): void {
    CookieManager._dbAdapter = adapter;
  }

  private get db(): CookieDbAdapter | null {
    return CookieManager._dbAdapter;
  }

  // ─── Platform-Level Cookies (for scraping) ───

  /** Load cookies for a platform — DB first, filesystem fallback */
  loadCookies(platform: string): CookieEntry[] {
    // 1. Try DB first
    if (this.db) {
      const json = this.db.getPlatformCookieJson(platform);
      if (json) {
        const cookies = this.parseCookieJson(platform, json);
        if (cookies.length > 0) return cookies;
      }
    }

    // 2. Fallback to filesystem
    return this.loadCookiesFromFile(platform);
  }

  /** Save cookies for a platform — DB + filesystem */
  saveCookies(platform: string, cookies: CookieEntry[]): void {
    const json = JSON.stringify(cookies, null, 2);

    // Always save to DB
    if (this.db) {
      this.db.savePlatformCookieJson(platform, json, cookies.length);
    }

    // Also save to filesystem (best effort)
    try {
      if (!existsSync(this.cookieDir)) {
        mkdirSync(this.cookieDir, { recursive: true });
      }
      const filePath = join(this.cookieDir, `${platform}.json`);
      writeFileSync(filePath, json, 'utf-8');
    } catch {
      // Filesystem may be read-only or ephemeral — OK, DB is the source of truth
    }

    logger.info(`Cookies saved for ${platform}: ${cookies.length} entries`);
  }

  /** Check if cookies exist for a platform */
  hasCookies(platform: string): boolean {
    if (this.db) {
      const json = this.db.getPlatformCookieJson(platform);
      if (json) return true;
    }
    return existsSync(join(this.cookieDir, `${platform}.json`));
  }

  /** Get cookie status for all platforms */
  getCookieStatus(): Array<{ platform: string; hasCookies: boolean; cookieCount: number }> {
    const platforms = ['instagram', 'twitter', 'tiktok', 'youtube', 'xiaohongshu', 'linkedin'];
    return platforms.map(platform => {
      const cookies = this.loadCookies(platform);
      return {
        platform,
        hasCookies: cookies.length > 0,
        cookieCount: cookies.length,
      };
    });
  }

  // ─── Per-Account Cookies (for DM sending) ───

  /** Load cookies for a specific account — DB first, filesystem fallback */
  loadAccountCookies(platform: string, username: string): CookieEntry[] {
    // 1. Try DB first
    if (this.db) {
      const json = this.db.getAccountCookieJson(platform, username);
      if (json) {
        const cookies = this.parseCookieJson(platform, json);
        if (cookies.length > 0) return cookies;
      }
    }

    // 2. Fallback to filesystem
    return this.loadAccountCookiesFromFile(platform, username);
  }

  /** Save cookies for a specific account — DB + filesystem */
  saveAccountCookies(platform: string, username: string, cookies: CookieEntry[]): void {
    const json = JSON.stringify(cookies, null, 2);

    // Always save to DB
    if (this.db) {
      this.db.saveAccountCookieJson(platform, username, json, cookies.length);
    }

    // Also save to filesystem (best effort)
    try {
      const dir = join(this.cookieDir, platform);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${username}.json`);
      writeFileSync(filePath, json, 'utf-8');
    } catch {
      // Filesystem may be read-only or ephemeral — OK, DB is the source of truth
    }

    logger.info(`Account cookies saved: ${platform}/@${username} (${cookies.length} entries)`);
  }

  /** Check if cookies exist for a specific account */
  hasAccountCookies(platform: string, username: string): boolean {
    if (this.db) {
      return this.db.hasAccountCookie(platform, username);
    }
    return existsSync(this.getAccountCookiePath(platform, username));
  }

  /** Validate cookies for a specific account — check critical cookies exist and aren't expired */
  validateCookies(platform: string, username: string): {
    valid: boolean;
    missingCookies: string[];
    expiresAt?: string;
  } {
    const cookies = this.loadAccountCookies(platform, username);
    const critical = this.getCriticalCookieNames(platform);
    const cookieNames = new Set(cookies.map(c => c.name));

    const missingCookies = critical.filter(name => !cookieNames.has(name));

    if (cookies.length === 0) {
      return { valid: false, missingCookies: critical };
    }

    // Check expiration of critical cookies
    let earliestExpiry: number | undefined;
    const now = Math.floor(Date.now() / 1000);

    for (const cookie of cookies) {
      if (critical.includes(cookie.name) && cookie.expires) {
        if (cookie.expires < now) {
          missingCookies.push(`${cookie.name}(expired)`);
        } else {
          if (!earliestExpiry || cookie.expires < earliestExpiry) {
            earliestExpiry = cookie.expires;
          }
        }
      }
    }

    const valid = missingCookies.length === 0;
    const expiresAt = earliestExpiry ? new Date(earliestExpiry * 1000).toISOString() : undefined;

    return { valid, missingCookies, expiresAt };
  }

  // ─── Conversion / Utility ───

  /** Normalize sameSite value for Playwright compatibility */
  private normalizeSameSite(value: string | undefined): 'Strict' | 'Lax' | 'None' {
    if (!value) return 'None';
    const lower = value.toLowerCase();
    if (lower === 'strict') return 'Strict';
    if (lower === 'lax') return 'Lax';
    return 'None';
  }

  /** Convert to Playwright cookie format */
  toPlaywrightCookies(cookies: CookieEntry[]): Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }> {
    return cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires || Math.floor(Date.now() / 1000) + 86400 * 30,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  /** Extract essential session cookies for a platform */
  getSessionCookies(platform: string): Record<string, string> {
    const cookies = this.loadCookies(platform);
    const result: Record<string, string> = {};

    const importantCookies: Record<string, string[]> = {
      instagram: ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'],
      twitter: ['auth_token', 'ct0', 'twid', 'guest_id'],
      tiktok: ['sessionid', 'tt_csrf_token', 'msToken', 'ttwid'],
      youtube: ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO'],
      xiaohongshu: ['web_session', 'xsecappid'],
      linkedin: ['li_at', 'JSESSIONID', 'bcookie'],
    };

    const important = importantCookies[platform] || [];
    for (const cookie of cookies) {
      if (important.length === 0 || important.includes(cookie.name)) {
        result[cookie.name] = cookie.value;
      }
    }

    return result;
  }

  /** Get the list of critical cookies for a platform */
  getCriticalCookieNames(platform: string): string[] {
    const critical: Record<string, string[]> = {
      instagram: ['sessionid', 'csrftoken', 'ds_user_id'],
      twitter: ['auth_token', 'ct0', 'twid'],
      tiktok: ['sessionid', 'tt_csrf_token', 'msToken', 'ttwid'],
      youtube: ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO'],
      xiaohongshu: ['web_session', 'xsecappid'],
      linkedin: ['li_at', 'JSESSIONID', 'bcookie'],
    };
    return critical[platform] || [];
  }

  /** Normalize domain for platform (e.g., twitter.com → x.com) */
  private normalizeDomain(platform: string, domain: string): string {
    // Twitter rebranded to x.com — cookies from .twitter.com must be mapped to .x.com
    if (platform === 'twitter') {
      if (domain.includes('twitter.com')) {
        return domain.replace('twitter.com', 'x.com');
      }
      if (!domain.includes('x.com')) {
        return '.x.com';
      }
    }
    return domain;
  }

  /** Parse cookie JSON string into CookieEntry array */
  parseCookieJson(platform: string, cookieJson: string): CookieEntry[] {
    try {
      const parsed = JSON.parse(cookieJson);

      const domainMap: Record<string, string> = {
        instagram: '.instagram.com',
        twitter: '.x.com',
        tiktok: '.tiktok.com',
        youtube: '.youtube.com',
        xiaohongshu: '.xiaohongshu.com',
        linkedin: '.linkedin.com',
      };
      const defaultDomain = domainMap[platform] || `.${platform}.com`;

      if (Array.isArray(parsed)) {
        return parsed.map(c => ({
          name: c.name,
          value: c.value,
          domain: this.normalizeDomain(platform, c.domain || defaultDomain),
          path: c.path || '/',
          expires: c.expirationDate ? Math.floor(c.expirationDate) : c.expires,
          httpOnly: c.httpOnly || false,
          secure: c.secure !== false,
          sameSite: this.normalizeSameSite(c.sameSite),
        }));
      }

      if (typeof parsed === 'object') {
        return Object.entries(parsed).map(([name, value]) => ({
          name,
          value: String(value),
          domain: defaultDomain,
          path: '/',
          secure: true,
          sameSite: 'None' as const,
        }));
      }

      return [];
    } catch {
      return [];
    }
  }

  // ─── Private filesystem methods ───

  private loadCookiesFromFile(platform: string): CookieEntry[] {
    const filePath = join(this.cookieDir, `${platform}.json`);
    if (!existsSync(filePath)) return [];

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return this.parseCookieJson(platform, raw);
    } catch (error) {
      logger.error(`Failed to parse cookies for ${platform}: ${(error as Error).message}`);
      return [];
    }
  }

  private getAccountCookiePath(platform: string, username: string): string {
    return join(this.cookieDir, platform, `${username}.json`);
  }

  private loadAccountCookiesFromFile(platform: string, username: string): CookieEntry[] {
    const filePath = this.getAccountCookiePath(platform, username);
    if (!existsSync(filePath)) return [];

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return this.parseCookieJson(platform, raw);
    } catch (error) {
      logger.error(`Failed to parse account cookies for ${platform}/@${username}: ${(error as Error).message}`);
      return [];
    }
  }

  /** @deprecated Use parseCookieJson instead */
  loadCookiesFromJson(platform: string, cookieJson: string): CookieEntry[] {
    return this.parseCookieJson(platform, cookieJson);
  }
}
