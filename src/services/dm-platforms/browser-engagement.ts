import { Page } from 'playwright';
import { BrowserContextPool } from '../browser-context-pool.js';
import { humanClick, humanType, humanScroll, idleActivity, simulateReading } from '../../core/anti-detection/human-behavior.js';
import { logger } from '../../utils/logger.js';

/**
 * Like a post via browser automation.
 * Supports Instagram, Twitter, TikTok.
 */
export async function browserLike(
  pool: BrowserContextPool,
  platform: string,
  accountUsername: string,
  postUrl: string
): Promise<void> {
  const entry = await pool.acquire(platform, accountUsername);
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry);

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);

    // Check for login wall
    const url = page.url();
    if (url.includes('/login') || url.includes('/accounts/login') || url.includes('/challenge')) {
      throw new Error('cookie_expired: login required');
    }

    // Simulate reading the post
    await simulateReading(page, 2000 + Math.random() * 3000);

    if (platform === 'instagram') {
      // Instagram: find the like button (heart icon, svg within button)
      const likeBtn = await page.$(
        'span[class*="Like"] button, ' +
        'section button svg[aria-label="Like"], ' +
        'button svg[aria-label="Like"], ' +
        'span svg[aria-label="Like"]'
      );
      if (likeBtn) {
        const parent = await likeBtn.$('xpath=ancestor::button') || likeBtn;
        await parent.click();
      } else {
        // Try double-click on image to like
        const media = await page.$('article img, article video');
        if (media) {
          const box = await media.boundingBox();
          if (box) {
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
          }
        }
      }
    } else if (platform === 'twitter') {
      // Twitter: like button
      const likeBtn = await page.$('div[data-testid="like"], button[data-testid="like"]');
      if (likeBtn) {
        await likeBtn.click();
      }
    } else if (platform === 'tiktok') {
      // TikTok: heart button
      await page.waitForTimeout(3000); // SPA load
      const likeBtn = await page.$('span[data-e2e="like-icon"], button[data-e2e="like-icon"]');
      if (likeBtn) {
        await likeBtn.click();
      }
    }

    await page.waitForTimeout(1000 + Math.random() * 2000);
    logger.info(`Browser like: ${platform}/@${accountUsername} liked ${postUrl}`);
  } catch (err) {
    logger.error(`Browser like failed: ${platform}/@${accountUsername} on ${postUrl}: ${(err as Error).message}`);
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release(platform, accountUsername);
  }
}

/**
 * Comment on a post via browser automation.
 * Supports Instagram, Twitter, TikTok.
 */
export async function browserComment(
  pool: BrowserContextPool,
  platform: string,
  accountUsername: string,
  postUrl: string,
  text: string
): Promise<void> {
  const entry = await pool.acquire(platform, accountUsername);
  let page: Page | null = null;

  try {
    page = await pool.createPage(entry);

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);

    // Check for login wall
    const url = page.url();
    if (url.includes('/login') || url.includes('/accounts/login') || url.includes('/challenge')) {
      throw new Error('cookie_expired: login required');
    }

    // Simulate browsing the post
    await simulateReading(page, 3000 + Math.random() * 3000);

    if (platform === 'instagram') {
      // Instagram: click comment icon, then type in textarea
      const commentIcon = await page.$('svg[aria-label="Comment"], span[class*="Comment"] svg');
      if (commentIcon) {
        const parent = await commentIcon.$('xpath=ancestor::button') || commentIcon;
        await parent.click();
        await page.waitForTimeout(1000);
      }

      const commentInput = 'textarea[placeholder*="Add a comment"], form textarea, textarea[aria-label*="Add a comment"]';
      await page.waitForSelector(commentInput, { timeout: 10000 });
      await humanType(page, commentInput, text);
      await page.waitForTimeout(500 + Math.random() * 500);

      // Submit
      const postBtn = await page.$('button:has-text("Post"), button[type="submit"]');
      if (postBtn) {
        await postBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
    } else if (platform === 'twitter') {
      // Twitter: click reply button, type in textbox
      const replyBtn = await page.$('div[data-testid="reply"], button[data-testid="reply"]');
      if (replyBtn) {
        await replyBtn.click();
        await page.waitForTimeout(1500);
      }

      const replyInput = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      await page.waitForSelector(replyInput, { timeout: 10000 });
      await humanType(page, replyInput, text);
      await page.waitForTimeout(500 + Math.random() * 500);

      const tweetBtn = await page.$('div[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]');
      if (tweetBtn) {
        await tweetBtn.click();
      }
    } else if (platform === 'tiktok') {
      // TikTok: click comment area, type, submit
      await page.waitForTimeout(3000); // SPA load

      const commentInput = 'div[data-e2e="comment-input"], div[contenteditable="true"], textarea[placeholder*="Add comment"]';
      await page.waitForSelector(commentInput, { timeout: 10000 });
      await humanType(page, commentInput, text);
      await page.waitForTimeout(500 + Math.random() * 500);

      const postBtn = await page.$('div[data-e2e="comment-post"], button:has-text("Post")');
      if (postBtn) {
        await postBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
    }

    await page.waitForTimeout(2000 + Math.random() * 2000);
    logger.info(`Browser comment: ${platform}/@${accountUsername} commented on ${postUrl}`);
  } catch (err) {
    logger.error(`Browser comment failed: ${platform}/@${accountUsername} on ${postUrl}: ${(err as Error).message}`);
    throw err;
  } finally {
    if (page) await page.close().catch(() => {});
    await pool.release(platform, accountUsername);
  }
}
