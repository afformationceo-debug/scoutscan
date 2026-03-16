import { chromium, firefox, Browser, BrowserContext, Page } from 'playwright';
import { ProxyConfig } from '../types.js';
import { ProxyRouter } from '../proxy.js';
import { generateFingerprint, generateFingerprintInjectionScript, BrowserFingerprint } from './fingerprint.js';
import { logger } from '../../utils/logger.js';

type BrowserType = 'chromium' | 'firefox';

interface StealthBrowserOptions {
  headless?: boolean;
  browserType?: BrowserType;
  region?: string;
  proxy?: ProxyConfig;
}

/**
 * Stealth Browser Manager - Enterprise-grade anti-detection
 *
 * Features:
 * - Multi-browser support (Chromium + Firefox for different TLS fingerprints)
 * - Per-context fingerprint injection (consistent within session)
 * - Automatic proxy binding with geo-matching
 * - Resource blocking for performance
 * - Response interception for data capture
 */
export class StealthBrowser {
  private browsers = new Map<BrowserType, Browser>();
  private contexts = new Map<string, { context: BrowserContext; fingerprint: BrowserFingerprint }>();
  private proxyRouter: ProxyRouter;

  constructor(proxyRouter: ProxyRouter) {
    this.proxyRouter = proxyRouter;
  }

  /** Launch a browser engine */
  async launch(options: StealthBrowserOptions = {}): Promise<void> {
    const type = options.browserType || 'chromium';
    if (this.browsers.has(type)) return;

    const launcher = type === 'firefox' ? firefox : chromium;

    const launchArgs = type === 'chromium' ? [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--window-size=1920,1080',
    ] : [
      // Firefox-specific args (fewer needed, less detectable by default)
    ];

    const browser = await launcher.launch({
      headless: options.headless ?? true,
      args: launchArgs,
    });

    this.browsers.set(type, browser);
    logger.info(`${type} browser launched (headless: ${options.headless ?? true})`);
  }

  /** Create a stealth context with unique fingerprint */
  async createStealthContext(
    sessionId: string,
    options: StealthBrowserOptions = {}
  ): Promise<{ context: BrowserContext; fingerprint: BrowserFingerprint }> {
    const type = options.browserType || 'chromium';
    if (!this.browsers.has(type)) {
      await this.launch(options);
    }

    const browser = this.browsers.get(type)!;
    const fingerprint = generateFingerprint(options.region || 'US');

    const contextOptions: any = {
      userAgent: fingerprint.userAgent,
      viewport: {
        width: fingerprint.screen.width > 2000 ? 1920 : fingerprint.screen.width,
        height: fingerprint.screen.height > 1200 ? 1080 : fingerprint.screen.height,
      },
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezone,
      colorScheme: 'light' as const,
      deviceScaleFactor: fingerprint.screen.devicePixelRatio,
      hasTouch: false,
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        'Accept-Language': fingerprint.navigator.languages.join(','),
      },
    };

    if (options.proxy) {
      contextOptions.proxy = this.proxyRouter.toPlaywrightProxy(options.proxy);
    }

    const context = await browser.newContext(contextOptions);

    // Inject fingerprint scripts into every page
    await context.addInitScript(generateFingerprintInjectionScript(fingerprint));

    const entry = { context, fingerprint };
    this.contexts.set(sessionId, entry);

    logger.debug(`Stealth context created: ${sessionId.slice(0, 8)} (${type})`);
    return entry;
  }

  /** Create a page with resource blocking and interception */
  async createPage(
    sessionId: string,
    options: {
      blockMedia?: boolean;
      blockFonts?: boolean;
      blockImages?: boolean;
      interceptResponses?: (url: string, body: string) => void;
    } = {}
  ): Promise<Page> {
    const entry = this.contexts.get(sessionId);
    if (!entry) throw new Error(`No context for session: ${sessionId}`);

    const page = await entry.context.newPage();

    // Resource blocking for performance
    const blockedTypes = new Set<string>();
    if (options.blockMedia) blockedTypes.add('media');
    if (options.blockFonts) blockedTypes.add('font');
    if (options.blockImages) blockedTypes.add('image');

    if (blockedTypes.size > 0) {
      await page.route('**/*', (route) => {
        if (blockedTypes.has(route.request().resourceType())) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    // Block known bot-detection tracking scripts (reduce fingerprint exposure)
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const blockedDomains = [
        'datadome.co', 'perimeterx.net', 'kasada.io',
        'hcaptcha.com/1/api.js', 'challenges.cloudflare.com',
        'px-cdn.net', 'px-cloud.net',
      ];
      if (blockedDomains.some(d => url.includes(d))) {
        route.abort();
      } else {
        route.fallback();
      }
    });

    // Response interception for data capture
    if (options.interceptResponses) {
      page.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json') || url.includes('/graphql/') || url.includes('/api/')) {
          try {
            const body = await response.text();
            options.interceptResponses!(url, body);
          } catch { /* response body unavailable */ }
        }
      });
    }

    return page;
  }

  /** Detect if a page shows a CAPTCHA or bot challenge */
  async detectChallenge(page: Page): Promise<{ detected: boolean; type: string }> {
    try {
      const result = await page.evaluate(() => {
        const html = document.documentElement.innerHTML.toLowerCase();
        const title = document.title.toLowerCase();
        const url = window.location.href.toLowerCase();

        // Cloudflare challenge
        if (html.includes('cf-challenge') || html.includes('cloudflare') && html.includes('ray id')) {
          return { detected: true, type: 'cloudflare' };
        }
        // hCaptcha
        if (html.includes('hcaptcha') || html.includes('h-captcha')) {
          return { detected: true, type: 'hcaptcha' };
        }
        // reCAPTCHA
        if (html.includes('recaptcha') || html.includes('g-recaptcha')) {
          return { detected: true, type: 'recaptcha' };
        }
        // DataDome
        if (html.includes('datadome') || html.includes('dd.js')) {
          return { detected: true, type: 'datadome' };
        }
        // PerimeterX
        if (html.includes('perimeterx') || html.includes('_pxhd')) {
          return { detected: true, type: 'perimeterx' };
        }
        // Instagram challenge
        if (url.includes('/challenge/') || html.includes('challenge_required') || html.includes('confirm it')) {
          return { detected: true, type: 'instagram_challenge' };
        }
        // TikTok CAPTCHA (slide puzzle)
        if (html.includes('captcha') && html.includes('tiktok') || html.includes('verify-bar')) {
          return { detected: true, type: 'tiktok_captcha' };
        }
        // Twitter/X age gate or login wall
        if (url.includes('/i/flow/login') || (html.includes('log in') && html.includes('x.com'))) {
          return { detected: true, type: 'twitter_login_wall' };
        }
        // Generic bot detection
        if (title.includes('access denied') || title.includes('blocked') || title.includes('robot') ||
            html.includes('automated') && html.includes('blocked')) {
          return { detected: true, type: 'generic_block' };
        }

        return { detected: false, type: 'none' };
      });
      return result;
    } catch {
      return { detected: false, type: 'error' };
    }
  }

  /** Get cookies from a context */
  async getCookies(sessionId: string): Promise<Array<{ name: string; value: string; domain: string }>> {
    const entry = this.contexts.get(sessionId);
    if (!entry) return [];
    return entry.context.cookies();
  }

  /** Set cookies on a context */
  async setCookies(sessionId: string, cookies: Array<{ name: string; value: string; domain: string; path?: string }>): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (!entry) return;
    await entry.context.addCookies(cookies.map(c => ({ ...c, path: c.path || '/' })));
  }

  /** Close a specific context */
  async closeContext(sessionId: string): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (entry) {
      await entry.context.close().catch(() => {});
      this.contexts.delete(sessionId);
    }
  }

  /** Close all browsers and contexts */
  async closeAll(): Promise<void> {
    for (const [id] of this.contexts) {
      await this.closeContext(id);
    }
    for (const [type, browser] of this.browsers) {
      await browser.close().catch(() => {});
      this.browsers.delete(type);
    }
    logger.info('All browsers closed');
  }
}
