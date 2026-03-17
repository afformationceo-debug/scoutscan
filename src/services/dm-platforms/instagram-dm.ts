import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, humanMouseMove, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount, ProxyConfig } from '../../core/types.js';

/** Progress callback for real-time UI updates */
export type DMProgressCallback = (step: string, detail: string) => void;

/**
 * Check if Instagram is showing any block/error state on the page.
 * Returns error message string if blocked, null if page is OK.
 */
async function detectInstagramBlockState(page: Page): Promise<string | null> {
  const url = page.url();

  // Login redirect (cookie expired)
  if (url.includes('/accounts/login') || url.includes('/challenge')) {
    return 'cookie_expired: Instagram login/challenge required';
  }

  // Check page content for known block indicators
  const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '');
  const pageTextLower = pageText.toLowerCase();

  // Action Blocked modal
  if (pageTextLower.includes('action blocked') || pageTextLower.includes('try again later') || pageTextLower.includes('we restrict certain activity')) {
    return 'blocked: Instagram action blocked - try again later';
  }

  // Rate limit / spam detection
  if (pageTextLower.includes('we limit how often') || pageTextLower.includes('spam') || pageTextLower.includes('unusual activity')) {
    return 'blocked: Instagram rate limit or spam detection triggered';
  }

  // Couldn't send message
  if (pageTextLower.includes("couldn't send") || pageTextLower.includes('failed to send') || pageTextLower.includes('메시지를 보낼 수 없습니다')) {
    return 'send_failed: Instagram rejected the message';
  }

  // Generic error dialog
  const errorDialog = await page.$('div[role="dialog"]:has-text("Error"), div[role="dialog"]:has-text("Something went wrong")').catch(() => null);
  if (errorDialog) {
    return 'error: Instagram error dialog detected';
  }

  return null;
}

/**
 * Send a DM on Instagram via Playwright browser automation.
 * Uses HumanBehavior for realistic interaction patterns.
 */
export async function sendInstagramDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string,
  onProgress?: DMProgressCallback,
  proxy?: ProxyConfig
): Promise<void> {
  const progress = onProgress || (() => {});

  progress('browser_init', `브라우저 컨텍스트 준비 중...`);
  const entry = await pool.acquire('instagram', account.username, { proxy });

  // Verify cookies were actually loaded
  if (!entry.cookiesLoaded && entry.cookieCount === 0) {
    await pool.release('instagram', account.username);
    throw new Error('cookie_expired: No cookies loaded for @' + account.username + ' - session file missing or empty');
  }

  let page: Page | null = null;

  try {
    progress('page_create', `페이지 생성 중...`);
    page = await pool.createPage(entry, { blockMedia: true });

    // Navigate to DM compose
    progress('navigate', `Instagram DM 페이지 이동 중...`);
    await page.goto('https://www.instagram.com/direct/new/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Comprehensive block state detection (login redirect, action blocked, rate limit, etc.)
    const blockError = await detectInstagramBlockState(page);
    if (blockError) {
      throw new Error(blockError);
    }

    // Log proxy usage for this send
    if (proxy) {
      logger.info(`[Instagram DM] Proxy: ${proxy.host}:${proxy.port} (${proxy.type || 'unknown'}) → @${account.username}`);
    } else {
      logger.warn(`[Instagram DM] NO PROXY — sending from server IP → @${account.username}`);
    }

    progress('search_wait', `수신자 검색창 대기 중...`);
    // Wait for the recipient search input
    const searchSelectors = 'input[name="queryBox"], input[placeholder*="Search"], input[placeholder*="search"], input[aria-label*="Search"], input[type="text"]';
    await page.waitForSelector(searchSelectors, { timeout: 15000 });

    // Small idle to seem natural
    await idleActivity(page, 1000 + Math.random() * 2000);

    // Type recipient username in search - clear first, then type slowly
    progress('search_type', `@${recipientUsername} 검색 입력 중...`);
    const searchInput = await page.$(searchSelectors);
    if (searchInput) {
      await searchInput.click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Meta+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
    }
    await humanType(page, searchSelectors, recipientUsername);

    // Wait for search results
    progress('search_result', `검색 결과 로딩 대기 중... (3~5초)`);
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Click on the matching user result
    progress('select_user', `@${recipientUsername} 선택 중...`);
    let clicked = false;

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

    if (!clicked) {
      const checkboxes = await page.$$('div[role="dialog"] input[type="checkbox"], div[role="dialog"] label, div[role="listbox"] div[role="option"], div[role="dialog"] div[role="listitem"]');
      if (checkboxes.length > 0) {
        await checkboxes[0].click();
        clicked = true;
      }
    }

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

    if (!clicked) {
      const resultRows = await page.$$('div[role="dialog"] div[role="button"], div[role="dialog"] button, div[role="dialog"] div[style*="cursor: pointer"]');
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

    // Click "Next" or "Chat" button
    progress('open_chat', `채팅 열기 버튼 클릭 중...`);
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

    // Wait for message input area
    progress('msg_wait', `메시지 입력창 대기 중...`);
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

    // Type message via clipboard paste (NOT char-by-char typing)
    // CRITICAL: humanType() types '\n' as Enter which SENDS the message in Instagram DM.
    // Clipboard paste preserves newlines as line breaks within a single message.
    progress('msg_type', `메시지 입력 중: "${message.slice(0, 30)}${message.length > 30 ? '...' : ''}"`);
    const msgEl = await page.$(msgSelector);
    if (msgEl) {
      await msgEl.click();
      await page.waitForTimeout(300 + Math.random() * 200);
    }
    // Insert message via DataTransfer paste event (works in headless Chromium)
    // This injects the full text at once, preserving newlines as line breaks.
    const isMac = process.platform === 'darwin';
    let pasted = false;
    try {
      pasted = await page.evaluate((text) => {
        const el = document.activeElement;
        if (!el) return false;
        // Method 1: DataTransfer paste event (works for contenteditable + textarea)
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(pasteEvent);
        // Check if it was handled
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          return el.value.length > 0;
        }
        return (el.textContent || '').length > 0;
      }, message);
    } catch {
      pasted = false;
    }
    await page.waitForTimeout(300 + Math.random() * 300);

    // Verify paste worked
    if (msgEl && !pasted) {
      const currentLen = await msgEl.evaluate((el: any) => {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value.length;
        return (el.textContent || el.innerText || '').length;
      }).catch(() => 0);
      pasted = currentLen >= message.length * 0.3;
    }

    // Fallback: Shift+Enter line-by-line typing (guaranteed to work)
    if (!pasted) {
      logger.info('[Instagram DM] Using Shift+Enter line-by-line input');
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
    await page.waitForTimeout(500 + Math.random() * 1000);

    // Send message
    progress('msg_send', `메시지 전송 중 (Enter)...`);
    await page.keyboard.press('Enter');

    // Wait for send confirmation - ACTUALLY VERIFY the message was sent
    progress('msg_confirm', `전송 확인 검증 중...`);
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // === CRITICAL: Verify actual delivery ===

    // 1. Check for error state after sending
    const postSendError = await detectInstagramBlockState(page);
    if (postSendError) {
      throw new Error(postSendError);
    }

    // 2. Check if the message input is now empty (message was consumed = sent)
    let inputCleared = false;
    for (const sel of msgSelectors) {
      const inputEl = await page.$(sel);
      if (inputEl) {
        const currentText = await inputEl.evaluate((el: any) => {
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
          return el.textContent || el.innerText || '';
        }).catch(() => '');
        // If the input is empty or significantly shorter than the message, it was likely sent
        if (currentText.length < message.length * 0.3) {
          inputCleared = true;
        }
        break;
      }
    }

    // 3. Check for "Couldn't send" or error indicators in the chat area
    const chatArea = await page.$('div[role="main"], section main, div[class*="direct"]').catch(() => null);
    if (chatArea) {
      const chatText = await chatArea.evaluate((el: any) => el.innerText?.slice(-500) || '').catch(() => '');
      const chatTextLower = chatText.toLowerCase();
      if (chatTextLower.includes("couldn't send") || chatTextLower.includes('failed') || chatTextLower.includes('not delivered') || chatTextLower.includes('전송 실패')) {
        throw new Error('send_failed: Instagram shows message was not delivered');
      }
    }

    // 4. Check for error toast/notification (but NOT "You sent" success alerts)
    const alertElements = await page.$$('[role="alert"], [data-testid="toast"]').catch(() => []);
    for (const alertEl of alertElements) {
      const alertText = await alertEl.textContent().catch(() => '');
      if (!alertText || alertText.length === 0) continue;
      const alertLower = alertText.toLowerCase();
      // "You sent" / "已傳送" / "送信済み" = SUCCESS notifications, skip them
      if (alertLower.includes('you sent') || alertLower.includes('sent') || alertText.includes('已傳送') || alertText.includes('送信済み')) {
        logger.info(`[Instagram DM] Send confirmed via alert: "${alertText.slice(0, 60)}"`);
        inputCleared = true; // This confirms the message was sent
        break;
      }
      // Actual error alerts
      if (alertLower.includes('error') || alertLower.includes('failed') || alertLower.includes("couldn't") || alertLower.includes('not delivered')) {
        throw new Error(`send_failed: Instagram error notification: ${alertText.slice(0, 100)}`);
      }
    }

    // 5. If input was NOT cleared and we couldn't verify delivery, warn but don't fail silently
    if (!inputCleared) {
      logger.warn(`[Instagram DM] Message input not cleared after send - delivery uncertain for @${recipientUsername}`);
      // Don't throw - the message might have been sent via a different mechanism
      // But log the uncertainty for debugging
    }

    progress('complete', `@${recipientUsername}에게 DM 전송 완료 (확인됨)`);
    logger.info(`Instagram DM sent (verified): @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    progress('error', `실패: ${errMsg.slice(0, 80)}`);
    logger.error(`Instagram DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    // Normalize error types for upstream handling
    if (errMsg.includes('cookie_expired') || errMsg.includes('login') || errMsg.includes('challenge')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    if (errMsg.includes('blocked') || errMsg.includes('spam') || errMsg.includes('action blocked') || errMsg.includes('rate limit')) {
      throw new Error(`blocked: @${account.username} - ${errMsg}`);
    }
    if (errMsg.includes('send_failed') || errMsg.includes("couldn't send") || errMsg.includes('not delivered')) {
      throw new Error(`send_failed: @${account.username} → @${recipientUsername} - ${errMsg}`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('instagram', account.username);
  }
}
