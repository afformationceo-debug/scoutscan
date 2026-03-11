/**
 * Human-like delay utilities
 * Implements realistic timing patterns to avoid bot detection
 */

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Generates a delay with normal distribution (bell curve)
 * More realistic than uniform random - most delays cluster around the mean
 */
export function humanDelay(meanMs: number, stdDevMs: number): Promise<void> {
  // Box-Muller transform for normal distribution
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const delay = Math.max(500, meanMs + z * stdDevMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Exponential backoff with jitter for retries
 */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30000): Promise<void> {
  const exponential = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.random() * exponential * 0.5;
  const delay = exponential + jitter;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Simulate page reading time based on content length
 */
export function readingDelay(contentLength: number): Promise<void> {
  // Average reading speed: ~250 words per minute
  const estimatedWords = contentLength / 5;
  const readingTimeMs = (estimatedWords / 250) * 60 * 1000;
  const delay = Math.min(Math.max(1000, readingTimeMs * (0.3 + Math.random() * 0.4)), 8000);
  return new Promise(resolve => setTimeout(resolve, delay));
}
