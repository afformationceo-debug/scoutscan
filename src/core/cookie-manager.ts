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
 * Cookie Manager - Import/export browser cookies for authenticated scraping
 *
 * Usage:
 * 1. Login to Instagram/Twitter in your browser
 * 2. Export cookies using a browser extension (EditThisCookie, Cookie-Editor)
 * 3. Save as JSON to cookies/ directory
 * 4. Scraper automatically loads and uses them
 *
 * Supported formats:
 * - JSON array (from EditThisCookie extension)
 * - Netscape cookie file format
 * - Key-value pairs
 */
export class CookieManager {
  private cookieDir: string;

  constructor(cookieDir?: string) {
    this.cookieDir = cookieDir || join(process.cwd(), 'cookies');
  }

  /** Load cookies for a platform */
  loadCookies(platform: string): CookieEntry[] {
    const filePath = join(this.cookieDir, `${platform}.json`);

    if (!existsSync(filePath)) {
      logger.debug(`No cookie file found for ${platform} at ${filePath}`);
      return [];
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Handle array format (EditThisCookie export)
      if (Array.isArray(parsed)) {
        return parsed.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || `.${platform}.com`,
          path: c.path || '/',
          expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
          httpOnly: c.httpOnly || false,
          secure: c.secure || true,
          sameSite: this.normalizeSameSite(c.sameSite),
        }));
      }

      // Handle object format { cookieName: cookieValue }
      if (typeof parsed === 'object') {
        const domainMap: Record<string, string> = {
          instagram: '.instagram.com',
          twitter: '.x.com',
          tiktok: '.tiktok.com',
          youtube: '.youtube.com',
          xiaohongshu: '.xiaohongshu.com',
          linkedin: '.linkedin.com',
        };

        return Object.entries(parsed).map(([name, value]) => ({
          name,
          value: String(value),
          domain: domainMap[platform] || `.${platform}.com`,
          path: '/',
          secure: true,
          sameSite: 'None' as const,
        }));
      }

      return [];
    } catch (error) {
      logger.error(`Failed to parse cookies for ${platform}: ${(error as Error).message}`);
      return [];
    }
  }

  /** Normalize sameSite value for Playwright compatibility */
  private normalizeSameSite(value: string | undefined): 'Strict' | 'Lax' | 'None' {
    if (!value) return 'None';
    const lower = value.toLowerCase();
    if (lower === 'strict') return 'Strict';
    if (lower === 'lax') return 'Lax';
    // "unspecified", "no_restriction", etc. → "None"
    return 'None';
  }

  /** Save cookies (after browser session) */
  saveCookies(platform: string, cookies: CookieEntry[]): void {
    const { mkdirSync } = require('fs');
    if (!existsSync(this.cookieDir)) {
      mkdirSync(this.cookieDir, { recursive: true });
    }

    const filePath = join(this.cookieDir, `${platform}.json`);
    writeFileSync(filePath, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.info(`Cookies saved for ${platform}: ${cookies.length} entries`);
  }

  /** Check if cookies exist for a platform */
  hasCookies(platform: string): boolean {
    return existsSync(join(this.cookieDir, `${platform}.json`));
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

  // ─── Per-Account Cookie Methods ───

  /** Get file path for per-account cookies */
  private getAccountCookiePath(platform: string, username: string): string {
    return join(this.cookieDir, platform, `${username}.json`);
  }

  /** Load cookies for a specific account */
  loadAccountCookies(platform: string, username: string): CookieEntry[] {
    const filePath = this.getAccountCookiePath(platform, username);
    if (!existsSync(filePath)) {
      logger.debug(`No cookie file for ${platform}/@${username}`);
      return [];
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return parsed.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || `.${platform}.com`,
          path: c.path || '/',
          expires: c.expirationDate ? Math.floor(c.expirationDate) : c.expires,
          httpOnly: c.httpOnly || false,
          secure: c.secure !== false,
          sameSite: this.normalizeSameSite(c.sameSite),
        }));
      }

      if (typeof parsed === 'object') {
        const domainMap: Record<string, string> = {
          instagram: '.instagram.com',
          twitter: '.x.com',
          tiktok: '.tiktok.com',
          youtube: '.youtube.com',
          xiaohongshu: '.xiaohongshu.com',
          linkedin: '.linkedin.com',
        };
        return Object.entries(parsed).map(([name, value]) => ({
          name,
          value: String(value),
          domain: domainMap[platform] || `.${platform}.com`,
          path: '/',
          secure: true,
          sameSite: 'None' as const,
        }));
      }

      return [];
    } catch (error) {
      logger.error(`Failed to parse account cookies for ${platform}/@${username}: ${(error as Error).message}`);
      return [];
    }
  }

  /** Save cookies for a specific account */
  saveAccountCookies(platform: string, username: string, cookies: CookieEntry[]): void {
    const dir = join(this.cookieDir, platform);
    mkdirSync(dir, { recursive: true });

    const filePath = this.getAccountCookiePath(platform, username);
    writeFileSync(filePath, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.info(`Account cookies saved: ${platform}/@${username} (${cookies.length} entries)`);
  }

  /** Check if cookies exist for a specific account */
  hasAccountCookies(platform: string, username: string): boolean {
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
}
