import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { CookieManager } from './core/cookie-manager.js';

const cookieManager = new CookieManager();

async function debug() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const cookies = cookieManager.loadCookies('instagram');
  await context.addCookies(cookieManager.toPlaywrightCookies(cookies));

  const page = await context.newPage();

  // Capture ALL API response bodies
  const responses: Array<{ url: string; body: string }> = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') || url.includes('graphql') || url.includes('/api/')) {
      try {
        const body = await res.text();
        responses.push({ url: url.substring(0, 200), body });
      } catch {}
    }
  });

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Navigate to hashtag search result page (new redirect URL)
  await page.goto('https://www.instagram.com/explore/tags/travel/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  // Scroll a bit
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(3000);

  // Extract post links from page
  const postLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    return Array.from(links).map(a => (a as HTMLAnchorElement).href);
  });
  console.log(`Found ${postLinks.length} post links on page`);
  console.log('Sample links:', postLinks.slice(0, 5));

  // Save all API responses for analysis
  console.log(`\nCaptured ${responses.length} API responses`);

  // Look for media data in responses
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    try {
      const data = JSON.parse(r.body);
      const keys = Object.keys(data);

      // Look for any media/post data
      const jsonStr = r.body;
      const hasShortcode = jsonStr.includes('shortcode');
      const hasMediaId = jsonStr.includes('media_id') || jsonStr.includes('"pk"');
      const hasCaption = jsonStr.includes('caption');
      const hasLikeCount = jsonStr.includes('like_count') || jsonStr.includes('edge_media_preview_like');

      if (hasShortcode || hasMediaId || hasCaption || hasLikeCount) {
        console.log(`\n--- Response #${i} (has media data) ---`);
        console.log(`URL: ${r.url}`);
        console.log(`Top keys: ${keys.join(', ')}`);
        // Save this response for detailed analysis
        writeFileSync(`output/api-response-${i}.json`, JSON.stringify(data, null, 2));
        console.log(`Saved to output/api-response-${i}.json`);
      }
    } catch {}
  }

  await browser.close();
  console.log('\nDone!');
}

debug().catch(console.error);
