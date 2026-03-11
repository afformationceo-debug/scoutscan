/**
 * Advanced Browser Fingerprint Generator
 * Generates realistic, consistent-per-session fingerprints
 * Covers: Canvas, WebGL, AudioContext, Navigator, Screen, Fonts
 *
 * Inspired by Apify's fingerprint-suite and Camoufox
 */

interface ScreenProfile {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  devicePixelRatio: number;
}

interface GPUProfile {
  vendor: string;
  renderer: string;
}

interface NavigatorProfile {
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  languages: string[];
  vendor: string;
}

export interface BrowserFingerprint {
  userAgent: string;
  screen: ScreenProfile;
  gpu: GPUProfile;
  navigator: NavigatorProfile;
  timezone: string;
  locale: string;
  fonts: string[];
  seed: number;
}

const SCREEN_PROFILES: ScreenProfile[] = [
  { width: 1920, height: 1080, availWidth: 1920, availHeight: 1055, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  { width: 2560, height: 1440, availWidth: 2560, availHeight: 1415, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  { width: 1440, height: 900, availWidth: 1440, availHeight: 875, colorDepth: 30, pixelDepth: 30, devicePixelRatio: 2 },
  { width: 1680, height: 1050, availWidth: 1680, availHeight: 1025, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 2 },
  { width: 2560, height: 1600, availWidth: 2560, availHeight: 1575, colorDepth: 30, pixelDepth: 30, devicePixelRatio: 2 },
  { width: 1536, height: 864, availWidth: 1536, availHeight: 834, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1.25 },
  { width: 3840, height: 2160, availWidth: 3840, availHeight: 2117, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1.5 },
];

const GPU_PROFILES: GPUProfile[] = [
  { vendor: 'Intel Inc.', renderer: 'Intel Iris Plus Graphics 640' },
  { vendor: 'Intel Inc.', renderer: 'Intel UHD Graphics 630' },
  { vendor: 'Intel Inc.', renderer: 'Intel Iris Pro Graphics 6200' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M3, OpenGL 4.1)' },
];

const CHROME_VERSIONS = [
  { full: '120.0.6099.109', major: '120' },
  { full: '121.0.6167.85', major: '121' },
  { full: '122.0.6261.94', major: '122' },
  { full: '123.0.6312.86', major: '123' },
  { full: '124.0.6367.91', major: '124' },
  { full: '125.0.6422.76', major: '125' },
];

const OS_PROFILES = [
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel' },
  { ua: 'Macintosh; Intel Mac OS X 14_0', platform: 'MacIntel' },
  { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32' },
  { ua: 'X11; Linux x86_64', platform: 'Linux x86_64' },
];

const TIMEZONE_LOCALE_MAP: Record<string, { timezone: string; locale: string; languages: string[] }> = {
  US: { timezone: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'] },
  'US-W': { timezone: 'America/Los_Angeles', locale: 'en-US', languages: ['en-US', 'en'] },
  GB: { timezone: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'] },
  DE: { timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en-US', 'en'] },
  KR: { timezone: 'Asia/Seoul', locale: 'ko-KR', languages: ['ko-KR', 'ko', 'en-US', 'en'] },
  BR: { timezone: 'America/Sao_Paulo', locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en-US', 'en'] },
};

const COMMON_FONTS = [
  'Arial', 'Arial Black', 'Courier New', 'Georgia', 'Helvetica',
  'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Lucida Console',
  'Palatino Linotype', 'Comic Sans MS', 'Tahoma', 'Segoe UI',
];

/** Seeded random for consistent fingerprints within a session */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Generate a complete browser fingerprint
 * Same seed = same fingerprint (consistency within session)
 */
export function generateFingerprint(region = 'US', seed?: number): BrowserFingerprint {
  const s = seed || Math.floor(Math.random() * 2147483647);
  const rand = seededRandom(s);

  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const chrome = pick(CHROME_VERSIONS);
  const os = pick(OS_PROFILES);
  const screen = pick(SCREEN_PROFILES);
  const gpu = pick(GPU_PROFILES);
  const localeInfo = TIMEZONE_LOCALE_MAP[region] || TIMEZONE_LOCALE_MAP.US;

  const userAgent = `Mozilla/5.0 (${os.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`;

  // Random font subset
  const fontCount = 8 + Math.floor(rand() * 6);
  const shuffledFonts = [...COMMON_FONTS].sort(() => rand() - 0.5);
  const fonts = shuffledFonts.slice(0, fontCount);

  return {
    userAgent,
    screen,
    gpu,
    navigator: {
      platform: os.platform,
      hardwareConcurrency: pick([4, 8, 12, 16]),
      deviceMemory: pick([4, 8, 16]),
      maxTouchPoints: os.platform === 'MacIntel' ? 0 : 0,
      languages: localeInfo.languages,
      vendor: 'Google Inc.',
    },
    timezone: localeInfo.timezone,
    locale: localeInfo.locale,
    fonts,
    seed: s,
  };
}

/**
 * Generate the JavaScript to inject fingerprint into a browser context
 */
export function generateFingerprintInjectionScript(fp: BrowserFingerprint): string {
  return `
    // === Anti-Detection Fingerprint Injection ===
    // Seed: ${fp.seed}

    // 1. Navigator properties
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => '${fp.navigator.platform}' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.navigator.hardwareConcurrency} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fp.navigator.deviceMemory} });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${fp.navigator.maxTouchPoints} });
    Object.defineProperty(navigator, 'vendor', { get: () => '${fp.navigator.vendor}' });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(fp.navigator.languages)} });

    // 2. Chrome runtime object
    if (!window.chrome) {
      window.chrome = {};
    }
    window.chrome.runtime = {
      onMessage: { addListener: function(){}, removeListener: function(){} },
      sendMessage: function(){},
      connect: function(){ return { onMessage: { addListener: function(){} }, postMessage: function(){}, disconnect: function(){} }; },
      getManifest: function(){ return {}; },
      id: undefined,
    };
    window.chrome.loadTimes = function() {
      return {
        requestTime: Date.now() / 1000 - ${Math.floor(Math.random() * 100)},
        startLoadTime: Date.now() / 1000 - ${Math.floor(Math.random() * 50)},
        commitLoadTime: Date.now() / 1000 - ${Math.floor(Math.random() * 10)},
        finishDocumentLoadTime: Date.now() / 1000 - ${Math.floor(Math.random() * 5)},
        finishLoadTime: Date.now() / 1000 - ${Math.floor(Math.random() * 2)},
        firstPaintTime: Date.now() / 1000 - ${Math.floor(Math.random() * 8)},
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
    };
    window.chrome.csi = function() {
      return { pageT: Date.now(), startE: Date.now(), onloadT: Date.now() };
    };

    // 3. Plugins
    Object.defineProperty(navigator, 'plugins', {
      get: function() {
        var plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
        ];
        plugins.item = function(i) { return this[i] || null; };
        plugins.namedItem = function(n) { return this.find(function(p){ return p.name === n; }) || null; };
        plugins.refresh = function() {};
        return plugins;
      }
    });

    // 4. Screen properties
    Object.defineProperty(screen, 'width', { get: () => ${fp.screen.width} });
    Object.defineProperty(screen, 'height', { get: () => ${fp.screen.height} });
    Object.defineProperty(screen, 'availWidth', { get: () => ${fp.screen.availWidth} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${fp.screen.availHeight} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${fp.screen.colorDepth} });
    Object.defineProperty(screen, 'pixelDepth', { get: () => ${fp.screen.pixelDepth} });
    Object.defineProperty(window, 'devicePixelRatio', { get: () => ${fp.screen.devicePixelRatio} });
    Object.defineProperty(window, 'outerWidth', { get: () => ${fp.screen.width} });
    Object.defineProperty(window, 'outerHeight', { get: () => ${fp.screen.height} });

    // 5. WebGL fingerprint
    var getParameterOrig = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return '${fp.gpu.vendor}';
      if (param === 37446) return '${fp.gpu.renderer}';
      return getParameterOrig.call(this, param);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var getParameter2Orig = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return '${fp.gpu.vendor}';
        if (param === 37446) return '${fp.gpu.renderer}';
        return getParameter2Orig.call(this, param);
      };
    }

    // 6. Canvas fingerprint noise (deterministic per seed)
    var seed = ${fp.seed};
    function seededNoise(s) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s % 3) - 1; // returns -1, 0, or 1
    }
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (this.width > 0 && this.height > 0) {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            var pixels = Math.min(this.width * this.height, 100);
            var imageData = ctx.getImageData(0, 0, Math.min(this.width, 10), Math.min(this.height, 10));
            for (var i = 0; i < imageData.data.length && i < pixels * 4; i += 4) {
              imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + seededNoise(seed + i)));
            }
            ctx.putImageData(imageData, 0, 0);
          }
        } catch(e) {}
      }
      return origToDataURL.apply(this, arguments);
    };

    // 7. Permissions API
    var origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(desc) {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null });
      }
      return origQuery.call(this, desc);
    };

    // 8. Timezone
    var origDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function() {
      var args = Array.from(arguments);
      if (!args[1]) args[1] = {};
      if (!args[1].timeZone) args[1].timeZone = '${fp.timezone}';
      return new origDateTimeFormat(args[0], args[1]);
    };
    Intl.DateTimeFormat.prototype = origDateTimeFormat.prototype;
    Object.defineProperty(Intl.DateTimeFormat, 'supportedLocalesOf', {
      value: origDateTimeFormat.supportedLocalesOf
    });

    // 9. Connection API
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'rtt', { get: () => ${50 + Math.floor(Math.random() * 100)} });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => ${5 + Math.floor(Math.random() * 15)} });
    }
  `;
}
