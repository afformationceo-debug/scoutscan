/**
 * Debug: Instagram hashtag page diagnosis
 * - 쿠키 로드 후 실제 페이지 내용 확인
 * - 네트워크 요청 URL 로그
 * - 리다이렉트 추적
 */
import { StealthBrowser } from './core/anti-detection/stealth-browser.js';
import { CookieManager } from './core/cookie-manager.js';

const browser = new StealthBrowser();
const cm = new CookieManager();

async function diagnose() {
  const tag = '韓国美容';
  const sessionId = 'debug-session';

  console.log('=== Instagram Hashtag Scraping Diagnosis ===\n');

  await browser.launch({ headless: true });
  await browser.createStealthContext(sessionId, {});

  // Load scraping cookies
  if (cm.hasCookies('instagram')) {
    const cookies = cm.loadCookies('instagram');
    console.log(`[1] Loaded ${cookies.length} cookies from cookies/instagram.json`);
    console.log(`    Key cookies: ${cookies.map(c => c.name).join(', ')}`);
    await browser.setCookies(sessionId, cm.toPlaywrightCookies(cookies));
  } else {
    console.log('[1] NO scraping cookies found!');
    process.exit(1);
  }

  // Track ALL network responses
  const interceptedUrls: string[] = [];
  const apiResponses: { url: string; status: number; bodySnippet: string }[] = [];

  const page = await browser.createPage(sessionId, {
    blockMedia: false,  // Don't block anything for diagnosis
    blockFonts: false,
    interceptResponses: (url, body) => {
      interceptedUrls.push(url);
      if (url.includes('graphql') || url.includes('/api/v1/') || url.includes('/web/') || url.includes('tags') || url.includes('search') || url.includes('popular')) {
        apiResponses.push({ url: url.slice(0, 200), status: 200, bodySnippet: body.slice(0, 500) });
      }
    },
  });

  // Step 1: Navigate to Instagram home
  console.log('\n[2] Navigating to instagram.com...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const homeUrl = page.url();
  const homeTitle = await page.title();
  console.log(`    URL: ${homeUrl}`);
  console.log(`    Title: ${homeTitle}`);

  // Check if we're logged in
  const loggedIn = await page.evaluate(() => {
    return !!(document.querySelector('[aria-label="Home"]') || document.querySelector('[aria-label="홈"]') || document.querySelector('nav'));
  });
  console.log(`    Logged in: ${loggedIn}`);

  // Dismiss notifications popup
  try {
    const notNow = await page.$('button:has-text("Not now"), button:has-text("Not Now"), button:has-text("나중에"), [role="button"]:has-text("Not")');
    if (notNow) { await notNow.click(); console.log('    Dismissed notification popup'); }
  } catch {}

  await new Promise(r => setTimeout(r, 2000));

  // Step 2: Navigate to hashtag page
  const hashtagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
  console.log(`\n[3] Navigating to hashtag page: ${hashtagUrl}`);

  const response = await page.goto(hashtagUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`    Response status: ${response?.status()}`);
  await new Promise(r => setTimeout(r, 5000));

  const finalUrl = page.url();
  const finalTitle = await page.title();
  console.log(`    Final URL: ${finalUrl}`);
  console.log(`    Final Title: ${finalTitle}`);
  console.log(`    Redirected: ${finalUrl !== hashtagUrl}`);

  // Step 3: Check page content
  const pageContent = await page.evaluate(() => {
    const body = document.body?.innerText?.slice(0, 1000) || '';
    const hasLogin = !!document.querySelector('input[name="username"]');
    const hasMedia = document.querySelectorAll('article img, article video, [role="img"]').length;
    const hasLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length;

    // Check for JSON data in scripts
    let jsonDataFound = 0;
    const scripts = document.querySelectorAll('script[type="application/json"]');
    scripts.forEach(s => {
      try {
        const d = JSON.parse(s.textContent || '');
        if (JSON.stringify(d).includes('shortcode') || JSON.stringify(d).includes('media')) jsonDataFound++;
      } catch {}
    });

    return { bodySnippet: body.slice(0, 500), hasLogin, hasMedia, hasLinks, jsonDataFound, scriptCount: scripts.length };
  });

  console.log(`\n[4] Page analysis:`);
  console.log(`    Login form present: ${pageContent.hasLogin}`);
  console.log(`    Media elements: ${pageContent.hasMedia}`);
  console.log(`    Post/Reel links: ${pageContent.hasLinks}`);
  console.log(`    JSON script tags: ${pageContent.scriptCount} (with media data: ${pageContent.jsonDataFound})`);
  console.log(`    Body snippet: ${pageContent.bodySnippet.slice(0, 200)}...`);

  // Step 4: Scroll once and check intercepted responses
  console.log('\n[5] Scrolling page...');
  await page.evaluate(() => window.scrollBy(0, 2000));
  await new Promise(r => setTimeout(r, 3000));

  console.log(`\n[6] Intercepted ${interceptedUrls.length} total network requests`);
  console.log(`    API-like responses: ${apiResponses.length}`);

  for (const r of apiResponses.slice(0, 10)) {
    console.log(`\n    URL: ${r.url}`);
    console.log(`    Body: ${r.bodySnippet.slice(0, 300)}`);
  }

  // Also try the /popular/ URL directly
  console.log('\n[7] Trying /popular/ URL directly...');
  const popResponse = await page.goto(`https://www.instagram.com/popular/${encodeURIComponent(tag)}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  if (popResponse) {
    await new Promise(r => setTimeout(r, 5000));
    const popUrl = page.url();
    console.log(`    URL: ${popUrl}`);
    const popContent = await page.evaluate(() => {
      return {
        hasMedia: document.querySelectorAll('article img, article video, [role="img"]').length,
        hasLinks: document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length,
      };
    });
    console.log(`    Media: ${popContent.hasMedia}, Links: ${popContent.hasLinks}`);
  }

  // Also try Instagram search API directly
  console.log('\n[8] Trying search API...');
  try {
    const searchResp = await page.evaluate(async (searchTag: string) => {
      const csrfEl = document.cookie.match(/csrftoken=([^;]+)/);
      const csrf = csrfEl ? csrfEl[1] : '';
      const resp = await fetch(`/api/v1/tags/${encodeURIComponent(searchTag)}/sections/`, {
        headers: {
          'X-CSRFToken': csrf,
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      const text = await resp.text();
      return { status: resp.status, body: text.slice(0, 500) };
    }, tag);
    console.log(`    Status: ${searchResp.status}`);
    console.log(`    Body: ${searchResp.body.slice(0, 300)}`);
  } catch (e) {
    console.log(`    Error: ${(e as Error).message}`);
  }

  await browser.closeContext(sessionId);
  await browser.close();
  console.log('\n=== Diagnosis complete ===');
}

diagnose().catch(console.error);
