import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount, ProxyConfig } from '../../core/types.js';

/**
 * Send a DM on Twitter/X via Playwright browser automation.
 * ct0 CSRF token is critical for authenticated requests.
 */
export async function sendTwitterDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string,
  proxy?: ProxyConfig
): Promise<void> {
  const entry = await pool.acquire('twitter', account.username, { proxy });
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry, { blockMedia: true });

    // Step 1: Navigate to DM inbox first
    await page.goto('https://x.com/messages', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000 + Math.random() * 2000);

    // Check for login redirect
    const url = page.url();
    if (url.includes('/login') || url.includes('/account/access') || url.includes('/i/flow/login')) {
      throw new Error('cookie_expired: Twitter login required');
    }

    // Step 2: Click the compose/new message button
    const composeSelectors = [
      'a[href="/messages/compose"]',
      'div[data-testid="NewDM_Button"]',
      'a[data-testid="NewDM_Button"]',
      '[aria-label*="New message"]',
      '[aria-label*="새 메시지"]',
      '[aria-label*="新しいメッセージ"]',
    ];
    let composeBtnClicked = false;
    for (const sel of composeSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        // Use JS click to bypass Twitter's mask overlay that blocks Playwright clicks
        await btn.evaluate((el: any) => el.click());
        composeBtnClicked = true;
        logger.info(`[Twitter DM] Compose button clicked: ${sel}`);
        break;
      }
    }
    if (!composeBtnClicked) {
      // Fallback: navigate directly
      await page.goto('https://x.com/messages/compose', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Step 3: Wait for people search input in compose dialog
    const searchSelectors = [
      'input[data-testid="searchPeople"]',
      'div[role="dialog"] input',
      'input[aria-label*="Search"]',
      'input[aria-label*="search"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="search"]',
      'input[placeholder*="검색"]',
      'input[placeholder*="検索"]',
      'input[placeholder*="搜"]',
      'aside input[type="text"]',
    ];
    const searchSelectorStr = searchSelectors.join(', ');
    await page.waitForSelector(searchSelectorStr, { timeout: 15000 });

    await idleActivity(page, 1000 + Math.random() * 1500);

    // Search for recipient — use focus+type instead of click (mask overlay blocks clicks)
    const searchEl = await page.$(searchSelectorStr);
    if (searchEl) {
      await searchEl.focus();
      await page.waitForTimeout(300);
      await page.keyboard.type(recipientUsername, { delay: 50 + Math.random() * 50 });
    } else {
      throw new Error('DM compose search input not found');
    }

    // Wait for results to load
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Click on the matching user (JS click to bypass mask)
    const userItem = await page.$(`div[data-testid="typeaheadResult"], li[role="listitem"], div[role="option"]`);
    if (!userItem) {
      throw new Error(`Recipient not found: @${recipientUsername}`);
    }
    await userItem.evaluate((el: any) => el.click());
    await page.waitForTimeout(1000 + Math.random() * 1000);

    // Click "Next" button (JS click to bypass mask)
    const nextBtn = await page.$('div[data-testid="nextButton"], button[data-testid="nextButton"]');
    if (nextBtn) {
      await nextBtn.evaluate((el: any) => el.click());
      await page.waitForTimeout(2000 + Math.random() * 1500);
    }

    // Wait for message input
    await page.waitForSelector('div[data-testid="dmComposerTextInput"], div[role="textbox"]', {
      timeout: 15000,
    });

    // Type message via paste (NOT char-by-char to avoid \n = Enter = send)
    const messageInput = 'div[data-testid="dmComposerTextInput"], div[role="textbox"]';
    const msgEl = await page.$(messageInput);
    if (msgEl) {
      await msgEl.click();
      await page.waitForTimeout(300 + Math.random() * 200);
    }

    // Paste via DataTransfer event (preserves newlines)
    let pasted = false;
    try {
      pasted = await page.evaluate((text) => {
        const el = document.activeElement;
        if (!el) return false;
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return (el.textContent || '').length > 0;
      }, message);
    } catch { pasted = false; }
    await page.waitForTimeout(300 + Math.random() * 300);

    // Fallback: Shift+Enter for newlines
    if (!pasted) {
      logger.info('[Twitter DM] Using Shift+Enter fallback');
      const isMac = process.platform === 'darwin';
      await page.keyboard.press(isMac ? 'Meta+a' : 'Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
      const lines = message.split('\n');
      for (let li = 0; li < lines.length; li++) {
        if (lines[li].length > 0) {
          await page.keyboard.type(lines[li], { delay: 20 + Math.random() * 30 });
        }
        if (li < lines.length - 1) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
          await page.waitForTimeout(30 + Math.random() * 70);
        }
      }
    }

    await page.waitForTimeout(500 + Math.random() * 800);

    // Send message (Twitter uses send button, not Enter) — JS click to bypass mask
    const sendBtn = await page.$('button[data-testid="dmComposerSendButton"], div[role="button"][aria-label*="Send"]');
    if (sendBtn) {
      await sendBtn.evaluate((el: any) => el.click());
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000 + Math.random() * 2000);

    logger.info(`Twitter DM sent: @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`Twitter DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    if (errMsg.includes('cookie_expired') || errMsg.includes('login') || errMsg.includes('suspended')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('twitter', account.username);
  }
}
