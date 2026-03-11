import cron, { type ScheduledTask } from 'node-cron';
import { jobManager } from '../web/services/job-manager.js';
import { getKeywordTarget, listKeywordTargets, updateKeywordTarget } from '../web/services/master-db.js';
import { resetDailyLimits } from '../web/services/master-db.js';
import type { Platform } from '../core/types.js';

export class SchedulerService {
  private scrapingCron: ScheduledTask | null = null;
  private resetCron: ScheduledTask | null = null;
  private running = false;

  /** Start all cron jobs */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Cron 1: Every hour at minute 0, check for scheduled scraping jobs
    this.scrapingCron = cron.schedule('0 * * * *', () => {
      this.checkSchedule().catch(err => {
        console.error('[Scheduler] Error checking schedule:', err);
      });
    });

    // Cron 2: Every day at midnight, reset DM daily limits
    this.resetCron = cron.schedule('0 0 * * *', () => {
      try {
        const count = resetDailyLimits();
        if (count > 0) console.log(`[Scheduler] Reset daily limits for ${count} DM accounts`);
      } catch (err) {
        console.error('[Scheduler] Error resetting daily limits:', err);
      }
    });

    console.log('[Scheduler] Started: hourly scraping check + midnight DM reset');
  }

  /** Stop all cron jobs */
  stop(): void {
    if (this.scrapingCron) {
      this.scrapingCron.stop();
      this.scrapingCron = null;
    }
    if (this.resetCron) {
      this.resetCron.stop();
      this.resetCron = null;
    }
    this.running = false;
    console.log('[Scheduler] Stopped');
  }

  /** Run a specific keyword target immediately */
  runNow(pairId: string): string {
    const target = getKeywordTarget(pairId);
    if (!target) throw new Error(`Keyword target not found: ${pairId}`);
    if (!target.isActive) throw new Error(`Keyword target is inactive: ${pairId}`);

    return this.runScheduledJob(target);
  }

  /** Check for targets that need scraping */
  private async checkSchedule(): Promise<void> {
    const now = new Date().toISOString();
    const targets = listKeywordTargets();

    const due = targets.filter(t =>
      t.isActive && t.nextScrapeAt && t.nextScrapeAt <= now
    );

    if (due.length === 0) return;
    console.log(`[Scheduler] ${due.length} keyword target(s) due for scraping`);

    for (const target of due) {
      try {
        this.runScheduledJob(target);
      } catch (err) {
        console.error(`[Scheduler] Failed to start job for ${target.pairId}:`, err);
      }
    }
  }

  /** Start a scraping job for a keyword target */
  private runScheduledJob(target: { id: number; pairId: string; platform: string; keyword: string; maxResultsPerRun: number; lastPostTimestamp?: string; scrapingCycleHours: number; totalExtracted: number }): string {
    const keyword = target.keyword.replace(/^#/, '');

    // Start hashtag job via JobManager (which handles enrichment + GeoClassifier)
    const jobId = jobManager.startHashtagJob(
      target.platform as Platform,
      keyword,
      target.maxResultsPerRun,
      true // always enrich profiles
    );

    // Update keyword target timestamps
    const now = new Date();
    const nextScrapeAt = new Date(now.getTime() + target.scrapingCycleHours * 60 * 60 * 1000).toISOString();

    updateKeywordTarget(target.id, {
      lastScrapedAt: now.toISOString(),
      nextScrapeAt,
    });

    console.log(`[Scheduler] Started job ${jobId.slice(0, 8)} for ${target.pairId} (${target.keyword}), next: ${nextScrapeAt}`);
    return jobId;
  }
}

export const scheduler = new SchedulerService();
