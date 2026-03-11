import { chromium } from 'playwright';
import { CookieManager } from './core/cookie-manager.js';

const cookieManager = new CookieManager();

async function debug() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  // Load cookies
  const cookies = cookieManager.loadCookies('instagram');
  const playwrightCookies = cookieManager.toPlaywrightCookies(cookies);
  await context.addCookies(playwrightCookies);
  console.log(`Loaded ${cookies.length} cookies`);

  const page = await context.newPage();

  // Intercept API responses
  const intercepted: string[] = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('graphql') || url.includes('/api/v1/') || url.includes('/web/')) {
      try {
        const body = await res.text();
        intercepted.push(`[${res.status()}] ${url.substring(0, 100)}`);
        if (body.length > 0) {
          const data = JSON.parse(body);
          // Check for hashtag media edges
          const edges = data?.data?.hashtag?.edge_hashtag_to_media?.edges;
          if (edges) {
            console.log(`\nFound ${edges.length} posts in GraphQL response!`);
          }
          // Check for sections (v1 api)
          const sections = data?.sections || data?.data?.recent?.sections;
          if (sections) {
            console.log(`\nFound ${sections.length} sections in API response!`);
          }
        }
      } catch {}
    }
  });

  // Go to instagram homepage first
  console.log('\n1. Visiting instagram.com...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if logged in
  const pageTitle = await page.title();
  const pageUrl = page.url();
  console.log(`   Title: ${pageTitle}`);
  console.log(`   URL: ${pageUrl}`);

  // Take screenshot
  await page.screenshot({ path: 'output/debug-1-homepage.png' });
  console.log('   Screenshot: output/debug-1-homepage.png');

  // Dismiss login modal if present
  try {
    const notNow = await page.$('button:has-text("Not now"), button:has-text("Not Now")');
    if (notNow) {
      await notNow.click();
      console.log('   Dismissed "Not Now" dialog');
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Navigate to hashtag page
  console.log('\n2. Navigating to #travel...');
  await page.goto('https://www.instagram.com/explore/tags/travel/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  const hashtagUrl = page.url();
  const hashtagTitle = await page.title();
  console.log(`   URL: ${hashtagUrl}`);
  console.log(`   Title: ${hashtagTitle}`);

  await page.screenshot({ path: 'output/debug-2-hashtag.png' });
  console.log('   Screenshot: output/debug-2-hashtag.png');

  // Check for redirect to login
  if (hashtagUrl.includes('accounts/login')) {
    console.log('\n   *** REDIRECTED TO LOGIN - Cookies may be expired ***');
  }

  // Try scrolling
  console.log('\n3. Scrolling for more content...');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: 'output/debug-3-after-scroll.png' });
  console.log('   Screenshot: output/debug-3-after-scroll.png');

  // Count visible images/articles on the page
  const postCount = await page.evaluate(() => {
    const articles = document.querySelectorAll('article');
    const links = document.querySelectorAll('a[href*="/p/"]');
    const imgs = document.querySelectorAll('img');
    return { articles: articles.length, postLinks: links.length, images: imgs.length };
  });
  console.log(`\n4. Page content: ${postCount.articles} articles, ${postCount.postLinks} post links, ${postCount.images} images`);

  console.log(`\n5. Intercepted ${intercepted.length} API responses:`);
  for (const r of intercepted) {
    console.log(`   ${r}`);
  }

  await browser.close();
  console.log('\nDone!');
}

debug().catch(console.error);
