import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanType, humanClick, humanMouseMove, idleActivity } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';
import type { DMAccount } from '../../core/types.js';

/** Progress callback for real-time UI updates */
export type DMProgressCallback = (step: string, detail: string) => void;

/**
 * Send a DM on Instagram via Playwright browser automation.
 * Uses HumanBehavior for realistic interaction patterns.
 */
export async function sendInstagramDM(
  pool: BrowserContextPool,
  account: DMAccount,
  recipientUsername: string,
  message: string,
  onProgress?: DMProgressCallback
): Promise<void> {
  const progress = onProgress || (() => {});

  progress('browser_init', `브라우저 컨텍스트 준비 중...`);
  const entry = await pool.acquire('instagram', account.username);
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

    // Check for login redirect / challenge
    const url = page.url();
    if (url.includes('/accounts/login') || url.includes('/challenge')) {
      throw new Error('cookie_expired: Instagram login/challenge required');
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

    // Type message
    progress('msg_type', `메시지 입력 중: "${message.slice(0, 30)}${message.length > 30 ? '...' : ''}"`);
    await humanType(page, msgSelector, message);
    await page.waitForTimeout(500 + Math.random() * 1000);

    // Send message
    progress('msg_send', `메시지 전송 중 (Enter)...`);
    await page.keyboard.press('Enter');

    // Wait for send confirmation
    progress('msg_confirm', `전송 확인 대기 중... (2~4초)`);
    await page.waitForTimeout(2000 + Math.random() * 2000);

    progress('complete', `@${recipientUsername}에게 DM 전송 완료!`);
    logger.info(`Instagram DM sent: @${account.username} → @${recipientUsername}`);
  } catch (err) {
    const errMsg = (err as Error).message;
    progress('error', `실패: ${errMsg.slice(0, 80)}`);
    logger.error(`Instagram DM failed: @${account.username} → @${recipientUsername}: ${errMsg}`);

    if (errMsg.includes('cookie_expired') || errMsg.includes('login') || errMsg.includes('challenge')) {
      throw new Error(`cookie_expired: @${account.username} session invalid`);
    }
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release('instagram', account.username);
  }
}
