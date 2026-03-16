import { ProxyConfig } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Proxy Router - Enterprise-grade proxy management
 *
 * Features:
 * - Residential/Mobile/Datacenter proxy support
 * - Bright Data & Apify URL format auto-detection
 * - Geo-targeted proxy selection (country-specific)
 * - Sticky sessions for consistent IP per scraping session
 * - Health monitoring with auto-block/unblock
 * - Smart rotation with failure tracking
 * - Per-platform proxy preference (mobile for TikTok, residential for Instagram)
 */
export class ProxyRouter {
  private proxies: ProxyConfig[] = [];
  private currentIndex = 0;
  private sessionBindings = new Map<string, ProxyConfig>();
  private blockedProxies = new Map<string, { blockedAt: number; reason: string; unblockAt: number }>();
  private failureCounts = new Map<string, number>();
  private successCounts = new Map<string, number>();

  // Platform-specific proxy preferences
  private static readonly PLATFORM_PROXY_PREFERENCE: Record<string, ProxyConfig['type'][]> = {
    tiktok: ['mobile', 'residential', 'isp'],
    instagram: ['residential', 'mobile', 'isp'],
    twitter: ['residential', 'isp', 'datacenter'],
    youtube: ['datacenter', 'residential', 'isp'],
    xiaohongshu: ['residential', 'mobile'],
    linkedin: ['residential', 'isp'],
  };

  constructor(proxyUrls?: string[]) {
    if (proxyUrls?.length) {
      this.proxies = proxyUrls.map(url => this.parseProxyUrl(url));
      const types = this.proxies.map(p => p.type || 'unknown');
      logger.info(`ProxyRouter initialized: ${this.proxies.length} proxies [${[...new Set(types)].join(', ')}]`);
    }
  }

  /** Parse proxy URL with auto-detection of provider and type */
  private parseProxyUrl(url: string): ProxyConfig {
    const parsed = new URL(url);
    const config: ProxyConfig = {
      url,
      protocol: parsed.protocol.replace(':', '') as ProxyConfig['protocol'],
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      username: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };

    // Auto-detect Bright Data proxies
    if (parsed.hostname.includes('brightdata.com') || parsed.hostname.includes('luminati.io') || parsed.hostname.includes('brd.superproxy.io')) {
      config.provider = 'brightdata';
      // Bright Data zone-based type detection from username
      const username = config.username || '';
      if (username.includes('residential') || username.includes('-country-')) {
        config.type = 'residential';
      } else if (username.includes('mobile')) {
        config.type = 'mobile';
      } else if (username.includes('isp')) {
        config.type = 'isp';
      } else {
        config.type = 'datacenter';
      }
      // Extract country from username (e.g., brd-customer-xxx-zone-residential-country-kr)
      const countryMatch = username.match(/-country-([a-z]{2})/i);
      if (countryMatch) config.country = countryMatch[1].toUpperCase();
    }
    // Auto-detect Apify proxies
    else if (parsed.hostname.includes('apify.com') || parsed.hostname.includes('proxy.apify.com')) {
      config.provider = 'apify';
      const username = config.username || '';
      if (username.includes('RESIDENTIAL')) {
        config.type = 'residential';
      } else {
        config.type = 'datacenter';
      }
      // Extract country from Apify format (e.g., groups-RESIDENTIAL,country-KR)
      const countryMatch = username.match(/country-([A-Z]{2})/);
      if (countryMatch) config.country = countryMatch[1];
    }
    // Auto-detect Smartproxy
    else if (parsed.hostname.includes('smartproxy.net') || parsed.hostname.includes('smartproxy.com')) {
      config.provider = 'smartproxy';
      // Smartproxy residential proxies typically use port 3120 or endpoint names
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('residential') || lowerUrl.includes('resi') || parsed.port === '3120') {
        config.type = 'residential';
      } else if (lowerUrl.includes('mobile') || lowerUrl.includes('4g') || lowerUrl.includes('5g')) {
        config.type = 'mobile';
      } else if (lowerUrl.includes('isp')) {
        config.type = 'isp';
      } else {
        config.type = 'datacenter';
      }
      // Extract country from username (e.g., smart-xxx-country-kr)
      const countryMatch = (config.username || '').match(/-country-([a-z]{2})/i);
      if (countryMatch) {
        config.country = countryMatch[1].toUpperCase();
      }
    }
    // Custom proxy — detect from URL hints
    else {
      config.provider = 'custom';
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('residential') || lowerUrl.includes('resi')) {
        config.type = 'residential';
      } else if (lowerUrl.includes('mobile') || lowerUrl.includes('4g') || lowerUrl.includes('5g')) {
        config.type = 'mobile';
      } else if (lowerUrl.includes('isp')) {
        config.type = 'isp';
      } else {
        config.type = 'datacenter';
      }
    }

    return config;
  }

  /** Get a rotating proxy (new IP per request) */
  getRotatingProxy(): ProxyConfig | undefined {
    const available = this.getAvailableProxies();
    if (!available.length) return undefined;

    this.currentIndex = (this.currentIndex + 1) % available.length;
    return available[this.currentIndex];
  }

  /** Get best proxy for a specific platform */
  getProxyForPlatform(platform: string): ProxyConfig | undefined {
    const preferences = ProxyRouter.PLATFORM_PROXY_PREFERENCE[platform];
    if (!preferences) return this.getRotatingProxy();

    const available = this.getAvailableProxies();
    if (!available.length) return undefined;

    // Try each preferred type in order
    for (const preferredType of preferences) {
      const matching = available.filter(p => p.type === preferredType);
      if (matching.length > 0) {
        // Prefer proxies with fewer failures
        matching.sort((a, b) => (this.failureCounts.get(a.url) || 0) - (this.failureCounts.get(b.url) || 0));
        return matching[0];
      }
    }

    // Fallback to any available
    return this.getRotatingProxy();
  }

  /** Get a geo-targeted proxy for a specific country */
  getGeoProxy(country: string, platform?: string): ProxyConfig | undefined {
    const available = this.getAvailableProxies();
    const upper = country.toUpperCase();

    // First try country-specific proxies
    const countryMatch = available.filter(p => p.country === upper);
    if (countryMatch.length > 0) {
      if (platform) {
        const preferences = ProxyRouter.PLATFORM_PROXY_PREFERENCE[platform];
        if (preferences) {
          for (const type of preferences) {
            const typed = countryMatch.filter(p => p.type === type);
            if (typed.length > 0) return typed[0];
          }
        }
      }
      return countryMatch[0];
    }

    // For Bright Data proxies, we can dynamically set country in session
    const brightdata = available.filter(p => p.provider === 'brightdata' && (p.type === 'residential' || p.type === 'mobile'));
    if (brightdata.length > 0) {
      const proxy = { ...brightdata[0] };
      // Modify username to include country targeting
      if (proxy.username && !proxy.username.includes('-country-')) {
        proxy.username = `${proxy.username}-country-${upper.toLowerCase()}`;
        proxy.country = upper;
      }
      return proxy;
    }

    // Fallback
    return platform ? this.getProxyForPlatform(platform) : this.getRotatingProxy();
  }

  /** Get a sticky proxy bound to a session ID */
  getStickyProxy(sessionId: string, platform?: string): ProxyConfig | undefined {
    if (this.sessionBindings.has(sessionId)) {
      const existing = this.sessionBindings.get(sessionId)!;
      // Check if still available (not blocked)
      if (!this.blockedProxies.has(existing.url)) return existing;
      this.sessionBindings.delete(sessionId);
    }

    const proxy = platform ? this.getProxyForPlatform(platform) : this.getRotatingProxy();
    if (proxy) {
      // For Bright Data/Apify, append session ID for sticky IP
      const stickyProxy = this.applyStickySession(proxy, sessionId);
      this.sessionBindings.set(sessionId, stickyProxy);
      return stickyProxy;
    }
    return proxy;
  }

  /** Apply sticky session to proxy (provider-specific) */
  private applyStickySession(proxy: ProxyConfig, sessionId: string): ProxyConfig {
    const sticky = { ...proxy };
    const sid = sessionId.replace(/-/g, '').slice(0, 16);

    if (proxy.provider === 'brightdata' && proxy.username) {
      // Bright Data format: add -session-xxx to username
      if (!proxy.username.includes('-session-')) {
        sticky.username = `${proxy.username}-session-${sid}`;
      }
    } else if (proxy.provider === 'apify' && proxy.username) {
      // Apify format: add session=xxx to username
      if (!proxy.username.includes('session-')) {
        sticky.username = `${proxy.username},session-${sid}`;
      }
    }

    sticky.sessionId = sid;
    return sticky;
  }

  /** Report proxy success — used for smart routing */
  reportSuccess(proxy: ProxyConfig): void {
    const count = (this.successCounts.get(proxy.url) || 0) + 1;
    this.successCounts.set(proxy.url, count);
    // Reset failure count on success
    this.failureCounts.set(proxy.url, 0);
  }

  /** Report proxy failure — auto-block after threshold */
  reportFailure(proxy: ProxyConfig, reason: string): void {
    const count = (this.failureCounts.get(proxy.url) || 0) + 1;
    this.failureCounts.set(proxy.url, count);

    logger.warn(`Proxy failure #${count}: ${proxy.host}:${proxy.port} (${proxy.type || 'unknown'}) — ${reason}`);

    // Auto-block after 3 consecutive failures
    if (count >= 3) {
      this.markBlocked(proxy, reason);
    }
  }

  /** Mark a proxy as blocked (will be excluded from rotation) */
  markBlocked(proxy: ProxyConfig, reason = 'manual'): void {
    const blockDuration = proxy.type === 'datacenter' ? 30 * 60 * 1000 : 10 * 60 * 1000;
    const now = Date.now();

    this.blockedProxies.set(proxy.url, {
      blockedAt: now,
      reason,
      unblockAt: now + blockDuration,
    });

    logger.warn(`Proxy blocked (${Math.round(blockDuration / 60000)}min): ${proxy.host}:${proxy.port} [${proxy.type}] — ${reason}`);

    // Auto-unblock
    setTimeout(() => {
      this.blockedProxies.delete(proxy.url);
      this.failureCounts.delete(proxy.url);
      logger.info(`Proxy unblocked: ${proxy.host}:${proxy.port}`);
    }, blockDuration);
  }

  /** Release a session binding */
  releaseSession(sessionId: string): void {
    this.sessionBindings.delete(sessionId);
  }

  /** Get all available (non-blocked) proxies */
  private getAvailableProxies(): ProxyConfig[] {
    const now = Date.now();
    // Clean up expired blocks
    for (const [url, block] of this.blockedProxies) {
      if (now >= block.unblockAt) {
        this.blockedProxies.delete(url);
        this.failureCounts.delete(url);
      }
    }
    return this.proxies.filter(p => !this.blockedProxies.has(p.url));
  }

  get hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  get availableCount(): number {
    return this.getAvailableProxies().length;
  }

  /** Get proxy statistics */
  getStats(): { total: number; available: number; blocked: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const p of this.proxies) {
      const type = p.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }
    return {
      total: this.proxies.length,
      available: this.getAvailableProxies().length,
      blocked: this.blockedProxies.size,
      byType,
    };
  }

  /** Convert to Playwright proxy format */
  toPlaywrightProxy(proxy: ProxyConfig) {
    let username = proxy.username || '';

    // Smartproxy: apply country targeting via username (area-XX format)
    if (proxy.provider === 'smartproxy' && username && !username.includes('-area-')) {
      // Default to US to avoid blocked regions (India blocks TikTok, etc.)
      const country = proxy.country || 'US';
      username = `user-${username}-area-${country}`;
    }

    return {
      server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username,
      password: proxy.password,
    };
  }
}
