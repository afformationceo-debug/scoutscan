import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, humanMouseMove, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount } from '../../core/types.js';

/**
 * Send a DM on Instagram via Playwright browser automation.
 * Uses HumanBehavior for realistic interaction patterns.
 */
export async function sendInstagramDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string
): Promise<void> {
  const entry = await pool.acquire('instagram', account.username);
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry, { blockMedia: true });

    // Navigate to DM compose
    await page.goto('https://www.instagram.com/direct/new/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Check for login redirect / challenge
    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('/challenge')) {
      throw new Error('cookie_expired: Instagram login/challenge required');
    }

    // Wait for the recipient search input
    const searchSelectors = 'input[name="queryBox"], input[placeholder*="Search"], input[placeholder*="search"], input[aria-label*="Search"], input[type="text"]';
    await page.waitForSelector(searchSelectors, { timeout: 15000 });

    // Small idle to seem natural
    await idleActivity(page, 1000 + Math.random() * 2000);

    // Type recipient username in search - clear first, then type slowly
    const searchInput = await page.$(searchSelectors);
    if (searchInput) {
      await searchInput.click();
      await page.waitForTimeout(300);
      // Clear any existing text
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }
    await humanType(page, searchSelectors, recipientUsername);

    // Wait longer for search results to load (Instagram search can be slow)
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Click on the matching user result - try multiple strategies
    let clicked = false;

    // Strategy 1: find exact username match in any span/div
    for (const sel of [
      `span:text-is("${recipientUsername}")`,
      `span:has-text("${recipientUsername}")`,
      `div:text-is("${recipientUsername}")`,
    ]) {
      const match = await page.$(sel);
      if (match) {
        await match.click();
        clicked = true;
        break;
      }
    }

    // Strategy 2: find checkbox/radio/label/option in dialog or listbox
    if (!clicked) {
      const checkboxes = await page.$$('div[role="dialog"] input[type="checkbox"], div[role="dialog"] label, div[role="listbox"] div[role="option"], div[role="dialog"] div[role="listitem"]');
      if (checkboxes.length > 0) {
        await checkboxes[0].click();
        clicked = true;
      }
    }

    // Strategy 3: any clickable element containing the username text
    if (!clicked) {
      const allElements = await page.$$('div[role="dialog"] div, div[role="dialog"] span, div[role="dialog"] button');
      for (const el of allElements) {
        const text = await el.textContent().catch(() => '');
        if (text && text.includes(recipientUsername)) {
          await el.click();
          clicked = true;
          break;
        }
      }
    }

    // Strategy 4: just click the first search result row
    if (!clicked) {
      const resultRows = await page.$$('div[role="dialog"] div[role="button"], div[role="dialog"] button, div[role="dialog"] div[style*="cursor: pointer"]');
      // Skip first few (they might be UI buttons), find one that looks like a search result
      for (const r of resultRows) {
        const box = await r.boundingBox();
        if (box && box.height > 30 && box.height < 80) {
          await r.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      // Try one more time: wait longer and retry search
      await page.waitForTimeout(2000);
      const lastTry = await page.$('div[role="dialog"] div[role="button"]');
      if (lastTry) {
        await lastTry.click();
        clicked = true;
      }
    }

    if (!clicked) {
      throw new Error(`Recipient not found: @${recipientUsername}`);
    }

    await page.waitForTimeout(1000 + Math.random() * 1000);

    // Click "Next" or "Chat" button to open conversation
    const nextBtnSelectors = [
      'div[role="dialog"] button:has-text("Next")',
      'div[role="dialog"] button:has-text("Chat")',
      'div[role="dialog"] button:has-text("次へ")',
      'div[role="dialog"] div[role="button"]:has-text("Next")',
    ];
    for (const sel of nextBtnSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(2000 + Math.random() * 1500);
        break;
      }
    }

    // Wait for message input area - try multiple selectors
    const msgSelectors = [
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="message"]',
      'div[role="textbox"][aria-label*="Message"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[aria-label*="Message"]',
      'p[data-lexical-text]',
    ];
    const msgSelector = msgSelectors.join(', ');

    await page.waitForSelector(msgSelector, { timeout: 20000 });

    // Type message with human-like behavior
    await humanType(page, msgSelector, message);

    await page.waitForTimeout(500 + Math.random() * 1000);

    // Send message (press Enter)
    await page.keyboard.press('Enter');

    // Wait for message to be sent
    await page.waitForTimeout(2000 + Math.random() * 2000);

    logger.info(`Instagram DM sent: @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`Instagram DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    // Detect cookie expiration
    if (errMsg.includes('cookie_expired') || errMsg.includes('login') || errMsg.includes('challenge')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('instagram', account.username);
  }
}
