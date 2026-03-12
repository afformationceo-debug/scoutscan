import cron, { type ScheduledTask } from 'node-cron';
import pLimit from 'p-limit';
import { jobManager } from '../web/services/job-manager.js';
import { getKeywordTarget, listKeywordTargets, updateKeywordTarget } from '../web/services/master-db.js';
import { resetDailyLimits } from '../web/services/master-db.js';
import { registry } from './registry.js';
import type { Platform } from '../core/types.js';

export class SchedulerService {
  private scrapingCron: ScheduledTask | null = null;
  private resetCron: ScheduledTask | null = null;
  private replenishCron: ScheduledTask | null = null;
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

    // Cron 3: Every 30 minutes, auto-replenish DM queues with new profiles
    this.replenishCron = cron.schedule('*/30 * * * *', () => {
      try {
        const added = registry.dmEngine?.autoReplenishQueues() ?? 0;
        if (added > 0) console.log(`[Scheduler] Auto-replenished ${added} DM queue targets`);
      } catch (err) {
        console.error('[Scheduler] Error replenishing DM queues:', err);
      }
    });

    console.log('[Scheduler] Started: hourly scraping + midnight DM reset + 30min DM replenish');
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
    if (this.replenishCron) {
      this.replenishCron.stop();
      this.replenishCron = null;
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

    // Group due targets by group_key for concurrent platform launches
    const groups = new Map<string, typeof due>();
    for (const target of due) {
      const key = target.groupKey || target.pairId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(target);
    }

    const groupLimit = pLimit(3);
    const groupTasks = [...groups.entries()].map(([groupKey, groupTargets]) =>
      groupLimit(async () => {
        // Launch all platform jobs in a group concurrently
        const jobs = groupTargets.map(target => {
          try {
            return this.runScheduledJob(target);
          } catch (err) {
            console.error(`[Scheduler] Failed to start job for ${target.pairId}:`, err);
            return null;
          }
        });
        if (groupTargets.length > 1) {
          console.log(`[Scheduler] Group "${groupKey}": launched ${jobs.filter(Boolean).length} platform jobs concurrently`);
        }
      })
    );

    await Promise.allSettled(groupTasks);
  }

  /** Start a scraping job for a keyword target */
  private runScheduledJob(target: { id: number; pairId: string; platform: string; keyword: string; maxResultsPerRun: number; lastPostTimestamp?: string; scrapingCycleHours: number; totalExtracted: number; scrapeUntil?: string }): string {
    const keyword = target.keyword.replace(/^#/, '');

    // Start hashtag job via JobManager (which handles enrichment + GeoClassifier)
    // Pass since (lastPostTimestamp) for delta scraping and pairId for tracking
    const jobId = jobManager.startHashtagJob(
      target.platform as Platform,
      keyword,
      target.maxResultsPerRun,
      true, // always enrich profiles
      target.pairId,
      target.lastPostTimestamp,
      target.scrapeUntil
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
