import { Page } from 'playwright';

/**
 * Human Behavior Simulator
 * Simulates realistic mouse movements, scrolling, typing, and browsing patterns
 * to evade behavioral analysis bot detection
 */

/** Generate a Bezier curve point for natural mouse movement */
function bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Generate human-like mouse path using cubic Bezier curves */
function generateMousePath(
  startX: number, startY: number,
  endX: number, endY: number,
  steps = 25
): Array<{ x: number; y: number }> {
  // Random control points for natural curve
  const cp1x = startX + (endX - startX) * (0.2 + Math.random() * 0.3);
  const cp1y = startY + (Math.random() - 0.5) * 200;
  const cp2x = startX + (endX - startX) * (0.5 + Math.random() * 0.3);
  const cp2y = endY + (Math.random() - 0.5) * 200;

  const path: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Add slight noise for micro-movements
    const noise = i > 0 && i < steps ? (Math.random() - 0.5) * 3 : 0;
    path.push({
      x: Math.round(bezierPoint(t, startX, cp1x, cp2x, endX) + noise),
      y: Math.round(bezierPoint(t, startY, cp1y, cp2y, endY) + noise),
    });
  }
  return path;
}

/** Move mouse along a natural path */
export async function humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
  const currentPos = await page.evaluate(() => {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  });

  const path = generateMousePath(currentPos.x, currentPos.y, targetX, targetY);

  for (const point of path) {
    await page.mouse.move(point.x, point.y);
    // Variable speed: slower at start and end, faster in middle
    const progress = path.indexOf(point) / path.length;
    const speed = 2 + Math.sin(progress * Math.PI) * 8;
    await new Promise(r => setTimeout(r, speed + Math.random() * 5));
  }
}

/** Click with human-like behavior: move, hover, then click */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const element = await page.$(selector);
  if (!element) return;

  const box = await element.boundingBox();
  if (!box) return;

  // Click at a random point within the element (not dead center)
  const clickX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const clickY = box.y + box.height * (0.3 + Math.random() * 0.4);

  await humanMouseMove(page, clickX, clickY);

  // Brief hover before clicking (50-200ms)
  await new Promise(r => setTimeout(r, 50 + Math.random() * 150));

  await page.mouse.click(clickX, clickY);
}

/** Type text with human-like keystroke timing */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await humanClick(page, selector);
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

  for (const char of text) {
    await page.keyboard.type(char);
    // Variable typing speed: 30-80 WPM equivalent
    const baseDelay = 50 + Math.random() * 120;
    // Longer pause after spaces and punctuation
    const extraDelay = [' ', '.', ',', '!', '?'].includes(char) ? Math.random() * 200 : 0;
    await new Promise(r => setTimeout(r, baseDelay + extraDelay));
  }
}

/** Scroll page like a human (variable speed, occasional pauses) */
export async function humanScroll(page: Page, scrollAmount = 800, direction: 'down' | 'up' = 'down'): Promise<void> {
  const totalSteps = 8 + Math.floor(Math.random() * 8);
  const stepSize = scrollAmount / totalSteps;
  const multiplier = direction === 'down' ? 1 : -1;

  for (let i = 0; i < totalSteps; i++) {
    const variation = stepSize * (0.7 + Math.random() * 0.6);
    await page.mouse.wheel(0, variation * multiplier);

    // Natural scroll speed with deceleration
    const progress = i / totalSteps;
    const delay = 30 + Math.sin(progress * Math.PI) * 50 + Math.random() * 30;
    await new Promise(r => setTimeout(r, delay));

    // Occasional pause mid-scroll (simulating reading)
    if (Math.random() < 0.15) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 2000));
    }
  }
}

/** Simulate reading a page: scroll down gradually with pauses */
export async function simulateReading(page: Page, duration = 5000): Promise<void> {
  const startTime = Date.now();
  let scrolled = 0;

  while (Date.now() - startTime < duration) {
    // Scroll a bit
    const scrollChunk = 200 + Math.random() * 400;
    await humanScroll(page, scrollChunk);
    scrolled += scrollChunk;

    // Pause to "read" (1-4 seconds)
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));

    // Occasionally scroll back up slightly (re-reading)
    if (Math.random() < 0.1) {
      await humanScroll(page, 100 + Math.random() * 200, 'up');
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }
  }
}

/** Random idle activity: small mouse movements, focus/blur events */
export async function idleActivity(page: Page, duration = 3000): Promise<void> {
  const endTime = Date.now() + duration;

  while (Date.now() < endTime) {
    const action = Math.random();

    if (action < 0.4) {
      // Small mouse movement
      const x = 200 + Math.random() * 1500;
      const y = 200 + Math.random() * 700;
      await page.mouse.move(x, y, { steps: 5 });
    } else if (action < 0.6) {
      // Brief scroll
      await page.mouse.wheel(0, (Math.random() - 0.5) * 100);
    }
    // else: just wait

    await new Promise(r => setTimeout(r, 300 + Math.random() * 1500));
  }
}
