import { ProxyConfig } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Proxy Router - Manages proxy rotation with session binding
 * Supports residential, datacenter, and mobile proxies
 */
export class ProxyRouter {
  private proxies: ProxyConfig[] = [];
  private currentIndex = 0;
  private sessionBindings = new Map<string, ProxyConfig>();
  private blockedProxies = new Set<string>();

  constructor(proxyUrls?: string[]) {
    if (proxyUrls?.length) {
      this.proxies = proxyUrls.map(url => this.parseProxyUrl(url));
      logger.info(`ProxyRouter initialized with ${this.proxies.length} proxies`);
    }
  }

  private parseProxyUrl(url: string): ProxyConfig {
    const parsed = new URL(url);
    return {
      url,
      protocol: parsed.protocol.replace(':', '') as ProxyConfig['protocol'],
      host: parsed.hostname,
      port: parseInt(parsed.port),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  }

  /** Get a rotating proxy (new IP per request) */
  getRotatingProxy(): ProxyConfig | undefined {
    const available = this.proxies.filter(p => !this.blockedProxies.has(p.url));
    if (!available.length) return undefined;

    this.currentIndex = (this.currentIndex + 1) % available.length;
    return available[this.currentIndex];
  }

  /** Get a sticky proxy bound to a session ID */
  getStickyProxy(sessionId: string): ProxyConfig | undefined {
    if (this.sessionBindings.has(sessionId)) {
      return this.sessionBindings.get(sessionId);
    }

    const proxy = this.getRotatingProxy();
    if (proxy) {
      this.sessionBindings.set(sessionId, proxy);
    }
    return proxy;
  }

  /** Mark a proxy as blocked (will be excluded from rotation) */
  markBlocked(proxy: ProxyConfig): void {
    this.blockedProxies.add(proxy.url);
    logger.warn(`Proxy blocked: ${proxy.host}:${proxy.port}`);

    // Auto-unblock after 10 minutes
    setTimeout(() => {
      this.blockedProxies.delete(proxy.url);
      logger.info(`Proxy unblocked: ${proxy.host}:${proxy.port}`);
    }, 10 * 60 * 1000);
  }

  /** Release a session binding */
  releaseSession(sessionId: string): void {
    this.sessionBindings.delete(sessionId);
  }

  get hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  get availableCount(): number {
    return this.proxies.filter(p => !this.blockedProxies.has(p.url)).length;
  }

  /** Convert to Playwright proxy format */
  toPlaywrightProxy(proxy: ProxyConfig) {
    return {
      server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    };
  }
}
