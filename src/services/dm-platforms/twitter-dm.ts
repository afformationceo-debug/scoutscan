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

    // Navigate to DM compose
    await page.goto('https://x.com/messages/compose', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Check for login redirect
    const url = page.url();
    if (url.includes('/login') || url.includes('/account/access')) {
      throw new Error('cookie_expired: Twitter login required');
    }

    // Wait for people search input
    await page.waitForSelector('input[data-testid="searchPeople"], input[aria-label*="Search"], input[placeholder*="Search"]', {
      timeout: 15000,
    });

    await idleActivity(page, 1000 + Math.random() * 1500);

    // Search for recipient
    const searchInput = 'input[data-testid="searchPeople"], input[aria-label*="Search"], input[placeholder*="Search"]';
    await humanType(page, searchInput, recipientUsername);

    // Wait for results to load
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Click on the matching user
    const userItem = await page.$(`div[data-testid="typeaheadResult"], li[role="listitem"], div[role="option"]`);
    if (!userItem) {
      throw new Error(`Recipient not found: @${recipientUsername}`);
    }
    await userItem.click();
    await page.waitForTimeout(1000 + Math.random() * 1000);

    // Click "Next" button
    const nextBtn = await page.$('div[data-testid="nextButton"], button[data-testid="nextButton"]');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(2000 + Math.random() * 1500);
    }

    // Wait for message input
    await page.waitForSelector('div[data-testid="dmComposerTextInput"], div[role="textbox"]', {
      timeout: 15000,
    });

    // Type message
    const messageInput = 'div[data-testid="dmComposerTextInput"], div[role="textbox"]';
    await humanType(page, messageInput, message);

    await page.waitForTimeout(500 + Math.random() * 800);

    // Send message
    const sendBtn = await page.$('button[data-testid="dmComposerSendButton"], div[role="button"][aria-label*="Send"]');
    if (sendBtn) {
      await sendBtn.click();
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
