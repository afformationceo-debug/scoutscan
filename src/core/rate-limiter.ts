import { humanDelay, backoffDelay } from '../utils/delay.js';
import { logger } from '../utils/logger.js';

interface PlatformLimits {
  requestsPerMinute: number;
  requestsPerHour: number;
  meanDelayMs: number;
  stdDevMs: number;
}

const PLATFORM_LIMITS: Record<string, PlatformLimits> = {
  instagram: {
    requestsPerMinute: 10,
    requestsPerHour: 150,
    meanDelayMs: 4000,
    stdDevMs: 1500,
  },
  twitter: {
    requestsPerMinute: 15,
    requestsPerHour: 300,
    meanDelayMs: 3000,
    stdDevMs: 1000,
  },
  tiktok: {
    requestsPerMinute: 8,
    requestsPerHour: 120,
    meanDelayMs: 5000,
    stdDevMs: 2000,
  },
  youtube: {
    requestsPerMinute: 20,
    requestsPerHour: 500,
    meanDelayMs: 2500,
    stdDevMs: 800,
  },
};

/**
 * Rate Limiter with human-like timing patterns
 * Uses sliding window + normal distribution delays
 */
export class RateLimiter {
  private requestTimestamps: number[] = [];
  private limits: PlatformLimits;
  private retryCount = 0;

  constructor(platform: string) {
    this.limits = PLATFORM_LIMITS[platform] || PLATFORM_LIMITS.instagram;
  }

  /** Wait before making the next request (human-like pacing) */
  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(
      ts => now - ts < 60 * 60 * 1000
    );

    // Check hourly limit
    if (this.requestTimestamps.length >= this.limits.requestsPerHour) {
      const oldestInHour = this.requestTimestamps[0];
      const waitTime = 60 * 60 * 1000 - (now - oldestInHour) + 5000;
      logger.warn(`Hourly rate limit reached. Waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Check per-minute limit
    const recentRequests = this.requestTimestamps.filter(ts => now - ts < 60 * 1000);
    if (recentRequests.length >= this.limits.requestsPerMinute) {
      const oldestInMinute = recentRequests[0];
      const waitTime = 60 * 1000 - (now - oldestInMinute) + 1000;
      logger.debug(`Minute rate limit reached. Waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Human-like delay between requests
    await humanDelay(this.limits.meanDelayMs, this.limits.stdDevMs);

    this.requestTimestamps.push(Date.now());
    this.retryCount = 0;
  }

  /** Handle rate limit response (429 / blocked) */
  async handleRateLimit(): Promise<void> {
    this.retryCount++;
    logger.warn(`Rate limited. Retry #${this.retryCount}, backing off...`);
    await backoffDelay(this.retryCount, 5000, 120000);
  }

  /** Reset retry counter (on successful request) */
  resetRetries(): void {
    this.retryCount = 0;
  }
}
