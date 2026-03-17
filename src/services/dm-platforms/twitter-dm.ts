import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount, ProxyConfig } from '../../core/types.js';

/**
 * Detect and handle Twitter's encrypted DM PIN entry screen.
 * Returns true if PIN was entered (or screen wasn't present), false if failed.
 */
async function handleDmPinScreen(page: Page, pin: string): Promise<boolean> {
  const url = page.url();

  // Check if redirected to PIN recovery/entry page
  // Twitter may redirect: /messages → /i/chat → /i/chat/pin/recovery
  const isPinPage = url.includes('/i/chat/pin') || url.includes('pin/recovery') || url.includes('pin/entry');

  if (!isPinPage) {
    // Also check page content for PIN prompt (multi-language)
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '').catch(() => '');
    const hasPinPrompt = bodyText.includes('비밀번호 입력') || bodyText.includes('Enter your password')
      || bodyText.includes('password') || bodyText.includes('PIN')
      || bodyText.includes('パスワード') || bodyText.includes('密碼')
      || bodyText.includes('암호화 키를 복구');

    if (!hasPinPrompt) {
      return true; // No PIN screen — proceed normally
    }
  }

  logger.info(`[Twitter DM] PIN entry screen detected at ${url}, entering PIN...`);

  // Wait for PIN input fields to render (Twitter SPA takes ~10s to redirect + render)
  try {
    await page.waitForSelector('input[type="text"]', { timeout: 15000 });
  } catch {
    logger.error('[Twitter DM] PIN input fields did not render');
    throw new Error('twitter_pin_failed: PIN input fields not found');
  }
  await page.waitForTimeout(1000);

  // Twitter uses 4 individual OTP-style input boxes (60x60px each)
  const pinInputs = await page.$$('input[type="text"]');
  const pinDigits = pin.split('');

  if (pinInputs.length < pinDigits.length) {
    logger.error(`[Twitter DM] Expected ${pinDigits.length} PIN inputs, found ${pinInputs.length}`);
    throw new Error('twitter_pin_failed: Not enough PIN input fields');
  }

  // Enter each digit into its own input field
  for (let i = 0; i < pinDigits.length; i++) {
    await pinInputs[i].focus();
    await page.waitForTimeout(100 + Math.random() * 100);
    await page.keyboard.type(pinDigits[i]);
    await page.waitForTimeout(150 + Math.random() * 150);
  }
  logger.info(`[Twitter DM] PIN ${pin.length} digits entered`);
  await page.waitForTimeout(1000);

  // Twitter may auto-submit after last digit, or we need to press Enter
  // Wait for auto-navigation (OTP inputs often auto-submit)
  await page.waitForTimeout(3000);

  // If still on PIN page, try pressing Enter or clicking submit
  let postUrl = page.url();
  if (postUrl.includes('pin')) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000 + Math.random() * 2000);
    postUrl = page.url();
  }

  // Verify PIN was accepted — check if still on PIN page
  if (postUrl.includes('/i/chat/pin') || postUrl.includes('pin/recovery')) {
    const errorText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
    if (errorText.includes('잘못') || errorText.includes('wrong') || errorText.includes('incorrect') || errorText.includes('틀림')) {
      logger.error(`[Twitter DM] PIN rejected (wrong PIN)`);
      throw new Error('twitter_pin_failed: Wrong PIN — account DM access blocked');
    }
    // Maybe PIN was accepted but page didn't navigate yet — check for chat elements
    const hasChatUI = await page.$('[data-testid="AppTabBar_DirectMessage_Link"], a[href="/messages"]').catch(() => null);
    if (hasChatUI) {
      logger.info('[Twitter DM] PIN likely accepted (chat UI visible)');
    } else {
      logger.warn(`[Twitter DM] Still on PIN page after entry. URL: ${postUrl}`);
    }
  }

  logger.info(`[Twitter DM] PIN entry complete, proceeding to messages`);
  return true;
}

/**
 * Send a DM on Twitter/X via Playwright browser automation.
 * Handles encrypted DM PIN entry automatically.
 */
export async function sendTwitterDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string,
  proxy?: ProxyConfig,
  dmPin?: string
): Promise<void> {
  const pin = dmPin || (account as any).dm_pin || '0000';
  const entry = await pool.acquire('twitter', account.username, { proxy });
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry, { blockMedia: true });

    // Step 1: Navigate to DM inbox (Twitter may redirect /messages → /i/chat)
    await page.goto('https://x.com/messages', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Wait for redirects to settle (messages → /i/chat → /i/chat/pin/recovery)
    // PIN page takes ~10s to render in Twitter SPA
    await page.waitForTimeout(12000 + Math.random() * 2000);

    // Check for login redirect
    let url = page.url();
    if (url.includes('/login') || url.includes('/account/access') || url.includes('/i/flow/login')) {
      throw new Error('cookie_expired: Twitter login required');
    }

    // Step 2: Handle encrypted DM PIN screen
    // Twitter redirects: /messages → /i/chat → /i/chat/pin/recovery
    await handleDmPinScreen(page, pin);

    // After PIN, ensure we're on the chat page
    url = page.url();
    if (!url.includes('/i/chat') && !url.includes('/messages')) {
      await page.goto('https://x.com/messages', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(4000 + Math.random() * 1000);
    }
    // Wait for chat UI to fully render
    try {
      await page.waitForSelector('[data-testid="dm-new-chat-button"], [data-testid="dm-inbox-panel"], a[href="/messages/compose"]', { timeout: 10000 });
    } catch {
      logger.warn('[Twitter DM] Chat UI did not render, retrying page load...');
      await page.goto('https://x.com/i/chat', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(5000);
    }

    // Step 3: Click "New Chat" button (new /i/chat UI)
    const composeSelectors = [
      '[data-testid="dm-new-chat-button"]',
      'a[href="/messages/compose"]',
      'div[data-testid="NewDM_Button"]',
      '[aria-label*="New message"]',
      '[aria-label*="새 메시지"]',
      '[aria-label*="새 채팅"]',
    ];
    let composeBtnClicked = false;
    for (const sel of composeSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.evaluate((el: any) => el.click());
        composeBtnClicked = true;
        logger.info(`[Twitter DM] New chat button clicked: ${sel}`);
        break;
      }
    }
    if (!composeBtnClicked) {
      logger.warn('[Twitter DM] New chat button not found, trying direct navigation');
      await page.goto('https://x.com/messages/compose', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Step 4: Wait for people search input (new /i/chat compose dialog)
    const searchSelectors = [
      'input[data-testid="searchPeople"]',
      'div[role="dialog"] input',
      '[data-testid="dm-search-bar"] input',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="검색"]',
      'input[placeholder*="検索"]',
    ];
    const searchSelectorStr = searchSelectors.join(', ');
    await page.waitForSelector(searchSelectorStr, { timeout: 15000 });

    await idleActivity(page, 1000 + Math.random() * 1500);

    // Search for recipient
    const searchEl = await page.$(searchSelectorStr);
    if (searchEl) {
      await searchEl.focus();
      await page.waitForTimeout(300);
      await page.keyboard.type(recipientUsername, { delay: 50 + Math.random() * 50 });
    } else {
      throw new Error('DM compose search input not found');
    }

    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Click on matching user from search results (new /i/chat: "new-dm-user-suggestion-{id}")
    const userSelectors = [
      '[data-testid^="new-dm-user-suggestion"]',
      'div[data-testid="typeaheadResult"]',
      'li[role="listitem"]',
      'div[role="option"]',
    ];
    let userClicked = false;
    for (const sel of userSelectors) {
      const items = await page.$$(sel);
      if (items.length > 0) {
        await items[0].evaluate((el: any) => el.click());
        userClicked = true;
        logger.info(`[Twitter DM] User selected via: ${sel} (${items.length} results)`);
        break;
      }
    }
    if (!userClicked) {
      throw new Error(`Recipient not found: @${recipientUsername}`);
    }
    await page.waitForTimeout(2000 + Math.random() * 1500);

    // Step 5: Wait for message input (conversation opens directly after user selection in /i/chat)
    const msgInputSelectors = [
      'div[role="textbox"]',
      'div[data-testid="dmComposerTextInput"]',
      'div[data-testid="dm-composer-text-input"]',
      'div[contenteditable="true"]',
      'textarea',
    ];
    await page.waitForSelector(msgInputSelectors.join(', '), { timeout: 15000 });

    // === CRITICAL: Message input with verification ===
    const messageInput = 'div[data-testid="dmComposerTextInput"], div[data-testid="dm-composer-text-input"], div[role="textbox"], textarea';
    const msgEl = await page.$(messageInput);
    const isMac = process.platform === 'darwin';

    // Step A: Clear any existing content
    if (msgEl) {
      await msgEl.click();
      await page.waitForTimeout(300);
      await page.keyboard.press(isMac ? 'Meta+a' : 'Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
    }

    // Step B: Shift+Enter line-by-line (most reliable for both Instagram and Twitter)
    const lines = message.split('\n');
    for (let li = 0; li < lines.length; li++) {
      if (lines[li].length > 0) {
        await page.keyboard.type(lines[li], { delay: 15 + Math.random() * 25 });
      }
      if (li < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.waitForTimeout(20 + Math.random() * 50);
      }
    }
    await page.waitForTimeout(500 + Math.random() * 500);

    // Step C: Verify correct message in input
    if (msgEl) {
      const inputContent = await msgEl.evaluate((el: any) => {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
        return el.textContent || el.innerText || '';
      }).catch(() => '');
      const expectedStart = message.replace(/\n/g, '').slice(0, 30);
      const actualStart = inputContent.replace(/\n/g, '').slice(0, 30);
      if (actualStart.length > 0 && !actualStart.includes(expectedStart.slice(0, 15))) {
        logger.error(`[Twitter DM] WRONG MESSAGE in input! Expected: "${expectedStart}" Got: "${actualStart}"`);
        throw new Error('send_failed: Wrong message detected in input — aborting');
      }
      logger.info(`[Twitter DM] Message verified: "${actualStart.slice(0, 20)}..." (${inputContent.length} chars)`);
    }

    await page.waitForTimeout(300 + Math.random() * 500);

    // Step 6: Send message — JS click to bypass mask
    const sendBtn = await page.$('button[data-testid="dmComposerSendButton"], div[role="button"][aria-label*="Send"]');
    if (sendBtn) {
      await sendBtn.evaluate((el: any) => el.click());
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000 + Math.random() * 2000);

    // Log proxy usage
    if (proxy) {
      logger.info(`[Twitter DM] Proxy: ${proxy.host}:${proxy.port} → @${account.username}`);
    }

    logger.info(`Twitter DM sent: @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error(`Twitter DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    if (errMsg.includes('cookie_expired') || errMsg.includes('login') || errMsg.includes('suspended')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    if (errMsg.includes('twitter_pin_failed')) {
      throw new Error(`blocked: @${account.username} — ${errMsg}`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('twitter', account.username);
  }
}
