import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount, ProxyConfig } from '../../core/types.js';

/**
 * Send a DM on TikTok via Playwright browser automation.
 * TikTok is a SPA with heavy dynamic loading — waitForSelector is critical.
 */
export async function sendTikTokDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string,
  proxy?: ProxyConfig
): Promise<void> {
  const entry = await pool.acquire('tiktok', account.username, { proxy });
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry, { blockMedia: true });

    // Navigate to TikTok messages
    await page.goto('https://www.tiktok.com/messages', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for SPA to load
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Check for login redirect
    const url = page.url();
    if (url.includes('/login') || url.includes('loginType')) {
      throw new Error('cookie_expired: TikTok login required');
    }

    // Look for "New message" or compose button
    const newMsgBtn = await page.$('button:has-text("New message"), div[data-e2e="new-message-btn"], button[aria-label*="New message"]');
    if (newMsgBtn) {
      await newMsgBtn.click();
      await page.waitForTimeout(2000 + Math.random() * 1500);
    }

    await idleActivity(page, 1000 + Math.random() * 1500);

    // Search for recipient
    await page.waitForSelector('input[placeholder*="Search"], input[data-e2e="search-user-input"]', {
      timeout: 15000,
    });

    const searchInput = 'input[placeholder*="Search"], input[data-e2e="search-user-input"]';
    await humanType(page, searchInput, recipientUsername);

    // Wait for search results
    await page.waitForTimeout(2500 + Math.random() * 2000);

    // Click on matching user
    const userResult = await page.$('div[data-e2e="search-user-item"], div[class*="UserItem"], li[class*="user"]');
    if (!userResult) {
      throw new Error(`Recipient not found: @${recipientUsername}`);
    }
    await userResult.click();
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Wait for message input to appear
    await page.waitForSelector('div[data-e2e="message-input"], div[contenteditable="true"], textarea[placeholder*="Send a message"]', {
      timeout: 15000,
    });

    // Type message
    const messageInput = 'div[data-e2e="message-input"], div[contenteditable="true"], textarea[placeholder*="Send a message"]';
    await humanType(page, messageInput, message);

    await page.waitForTimeout(500 + Math.random() * 800);

    // Send message
    const sendBtn = await page.$('button[data-e2e="send-message-btn"], button:has-text("Send")');
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000 + Math.random() * 2000);

    logger.info(`TikTok DM sent: @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`TikTok DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    if (errMsg.includes('cookie_expired') || errMsg.includes('login')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('tiktok', account.username);
  }
}
