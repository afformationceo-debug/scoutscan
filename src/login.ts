import 'dotenv/config';
import { chromium } from 'playwright';
import { CookieManager } from './core/cookie-manager.js';
import { logger } from './utils/logger.js';

/**
 * Interactive Login Tool
 *
 * Opens a real browser window where you can login to a platform.
 * After login, cookies are saved automatically for use by the scraper.
 *
 * Usage:
 *   npx tsx src/login.ts instagram
 *   npx tsx src/login.ts twitter
 *   npx tsx src/login.ts tiktok
 */

const PLATFORM_URLS: Record<string, string> = {
  instagram: 'https://www.instagram.com/accounts/login/',
  twitter: 'https://x.com/i/flow/login',
  tiktok: 'https://www.tiktok.com/login',
  youtube: 'https://accounts.google.com/signin/v2/identifier?service=youtube',
  xiaohongshu: 'https://www.xiaohongshu.com/login',
  linkedin: 'https://www.linkedin.com/login',
};

async function main() {
  const platform = process.argv[2];

  if (!platform || !PLATFORM_URLS[platform]) {
    console.log(`
Login Tool - Save browser cookies for authenticated scraping

Usage: npx tsx src/login.ts <platform>

Platforms:
  instagram    Login to Instagram
  twitter      Login to Twitter/X
  tiktok       Login to TikTok
  youtube      Login to YouTube/Google
  xiaohongshu  Login to Xiaohongshu
  linkedin     Login to LinkedIn

After login:
  1. A real browser window will open
  2. Login manually with your credentials
  3. Navigate to a few pages to establish session
  4. Press Enter in terminal when done
  5. Cookies are saved to cookies/${platform}.json
  6. Scraper will automatically use them
`);
    process.exit(0);
  }

  const loginUrl = PLATFORM_URLS[platform];
  const cookieManager = new CookieManager();

  console.log(`\nOpening ${platform} login page...`);
  console.log(`Please login manually in the browser window.\n`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-size=1280,800',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  // Inject stealth patches
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  console.log('─'.repeat(50));
  console.log('  Login in the browser window above.');
  console.log('  When done, come back here and press ENTER.');
  console.log('─'.repeat(50));

  // Wait for user input
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  // Save cookies
  const cookies = await context.cookies();
  console.log(`\nCaptured ${cookies.length} cookies.`);

  cookieManager.saveCookies(platform, cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite as any,
  })));

  // Show important cookies
  const importantNames: Record<string, string[]> = {
    instagram: ['sessionid', 'csrftoken', 'ds_user_id'],
    twitter: ['auth_token', 'ct0'],
    tiktok: ['sessionid', 'msToken'],
    youtube: ['SID', 'LOGIN_INFO'],
    xiaohongshu: ['web_session'],
    linkedin: ['li_at'],
  };

  const important = importantNames[platform] || [];
  const found = cookies.filter(c => important.includes(c.name));

  if (found.length > 0) {
    console.log(`\nKey cookies found:`);
    for (const c of found) {
      console.log(`  ${c.name}: ${c.value.slice(0, 20)}...`);
    }
    console.log(`\nLogin successful! Cookies saved to cookies/${platform}.json`);
    console.log(`The scraper will now use these cookies automatically.`);
  } else {
    console.log(`\nWarning: Key session cookies not found. Login may not have completed.`);
    console.log(`Expected cookies: ${important.join(', ')}`);
  }

  await browser.close();
  process.exit(0);
}

main().catch(console.error);
