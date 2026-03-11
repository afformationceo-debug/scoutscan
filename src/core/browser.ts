import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { ProxyConfig } from './types.js';
import { ProxyRouter } from './proxy.js';
import { logger } from '../utils/logger.js';

/**
 * Browser Manager - Manages Playwright browser instances with anti-detection
 * Implements stealth measures, fingerprint injection, and context isolation
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();
  private proxyRouter: ProxyRouter;

  constructor(proxyRouter: ProxyRouter) {
    this.proxyRouter = proxyRouter;
  }

  /** Launch browser with stealth configuration */
  async launch(headless = true): Promise<void> {
    const launchOptions: any = {
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--lang=en-US,en',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    };

    this.browser = await chromium.launch(launchOptions);
    logger.info('Browser launched with stealth configuration');
  }

  /** Create an isolated browser context with anti-detection */
  async createContext(sessionId: string, proxy?: ProxyConfig): Promise<BrowserContext> {
    if (!this.browser) await this.launch();

    const contextOptions: any = {
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      permissions: ['geolocation'],
      colorScheme: 'light' as const,
      deviceScaleFactor: 2,
      hasTouch: false,
      javaScriptEnabled: true,
      bypassCSP: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    if (proxy) {
      contextOptions.proxy = this.proxyRouter.toPlaywrightProxy(proxy);
    }

    const context = await this.browser!.newContext(contextOptions);

    // Inject stealth scripts
    await this.injectStealthScripts(context);

    this.contexts.set(sessionId, context);
    return context;
  }

  /** Inject anti-detection JavaScript into every page */
  private async injectStealthScripts(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // Chrome runtime object
      (window as any).chrome = {
        runtime: {
          onMessage: { addListener: () => {}, removeListener: () => {} },
          sendMessage: () => {},
          connect: () => {},
        },
        loadTimes: () => ({
          requestTime: Date.now() / 1000 - Math.random() * 100,
          startLoadTime: Date.now() / 1000 - Math.random() * 50,
          commitLoadTime: Date.now() / 1000 - Math.random() * 10,
          finishDocumentLoadTime: Date.now() / 1000 - Math.random() * 5,
          finishLoadTime: Date.now() / 1000 - Math.random() * 2,
          firstPaintTime: Date.now() / 1000 - Math.random() * 8,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        }),
        csi: () => ({ pageT: Date.now(), startE: Date.now(), onloadT: Date.now() }),
      };

      // Plugins and mimeTypes
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          const arr: any = plugins;
          arr.length = plugins.length;
          arr.item = (i: number) => plugins[i];
          arr.namedItem = (n: string) => plugins.find(p => p.name === n);
          arr.refresh = () => {};
          return arr;
        },
      });

      // Languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Hardware concurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
      });

      // Device memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });

      // Permissions API
      const originalQuery = Permissions.prototype.query;
      Permissions.prototype.query = function (desc: any) {
        if (desc.name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
        }
        return originalQuery.call(this, desc);
      };

      // WebGL vendor/renderer spoofing
      const getParameterProto = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param: number) {
        if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel Iris Plus Graphics 640'; // UNMASKED_RENDERER_WEBGL
        return getParameterProto.call(this, param);
      };

      // Canvas fingerprint noise
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (type?: string) {
        if (this.width === 0 && this.height === 0) return origToDataURL.call(this, type);
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, Math.min(this.width, 10), Math.min(this.height, 10));
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] = imageData.data[i] ^ 1; // Tiny noise
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return origToDataURL.call(this, type);
      };
    });
  }

  /** Get a page from a context */
  async getPage(sessionId: string): Promise<Page> {
    const context = this.contexts.get(sessionId);
    if (!context) throw new Error(`No context for session ${sessionId}`);

    const page = await context.newPage();

    // Block unnecessary resources for speed
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['media', 'font'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    return page;
  }

  /** Close a context */
  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (context) {
      await context.close();
      this.contexts.delete(sessionId);
    }
  }

  /** Close browser */
  async close(): Promise<void> {
    for (const context of this.contexts.values()) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info('Browser closed');
  }
}
