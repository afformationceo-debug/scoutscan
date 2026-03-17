import cron, { type ScheduledTask } from 'node-cron';
import pLimit from 'p-limit';
import { jobManager } from '../web/services/job-manager.js';
import { getKeywordTarget, listKeywordTargets, updateKeywordTarget } from '../web/services/master-db.js';
import { resetDailyLimits } from '../web/services/master-db.js';
import { registry } from './registry.js';
import { sseManager } from '../web/services/sse-manager.js';
import { CookieManager } from '../core/cookie-manager.js';
import { db } from '../web/services/db.js';
import type { Platform } from '../core/types.js';

export class SchedulerService {
  private scrapingCron: ScheduledTask | null = null;
  private resetCron: ScheduledTask | null = null;
  private replenishCron: ScheduledTask | null = null;
  private cookieHealthCron: ScheduledTask | null = null;
  private cookieManager = new CookieManager();
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

    // Cron 4: Every 5 minutes, check cookie health for DM accounts and scraping cookies
    this.cookieHealthCron = cron.schedule('*/5 * * * *', () => {
      this.checkCookieHealth().catch(err => {
        console.error('[Scheduler] Error checking cookie health:', err);
      });
    });

    // Run cookie health check once on startup (after a short delay for DB init)
    setTimeout(() => {
      this.checkCookieHealth().catch(err => {
        console.error('[Scheduler] Initial cookie health check failed:', err);
      });
    }, 5000);

    console.log('[Scheduler] Started: hourly scraping + midnight DM reset + 30min DM replenish + 5min cookie health');
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
    if (this.cookieHealthCron) {
      this.cookieHealthCron.stop();
      this.cookieHealthCron = null;
    }
    this.running = false;
    console.log('[Scheduler] Stopped');
  }

  /** Run a specific keyword target immediately */
  runNow(pairId: string): string {
    const target = getKeywordTarget(pairId);
    if (!target) throw new Error(`Keyword target not found: ${pairId}`);
    if (!target.isActive) throw new Error(`Keyword target is inactive: ${pairId}`);

    // Prevent duplicate jobs
    if (target.lastJobStatus === 'running') {
      throw new Error(`Job already running for ${pairId}`);
    }

    return this.runScheduledJob(target);
  }

  /** Check for targets that need scraping */
  private async checkSchedule(): Promise<void> {
    const now = new Date().toISOString();
    const targets = listKeywordTargets();

    const due = targets.filter(t =>
      t.isActive && t.nextScrapeAt && t.nextScrapeAt <= now && t.lastJobStatus !== 'running'
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

    // Broadcast scheduled scraping start on global channel
    sseManager.broadcast('global', 'scraping_started', {
      pairId: target.pairId,
      keyword: target.keyword,
      platform: target.platform,
      jobId,
      scheduled: true,
    });

    console.log(`[Scheduler] Started job ${jobId.slice(0, 8)} for ${target.pairId} (${target.keyword}), next: ${nextScrapeAt}`);
    return jobId;
  }

  /** Check cookie health for all DM accounts and scraping cookies */
  private async checkCookieHealth(): Promise<void> {
    const warnings: Array<{ type: string; username: string; platform: string; detail: string }> = [];

    // 1. Check DM account cookies
    try {
      const accounts = db.prepare(
        'SELECT id, platform, username, cookie_status, cookie_expires_at FROM dm_accounts WHERE is_active = 1'
      ).all() as Array<{ id: number; platform: string; username: string; cookie_status: string; cookie_expires_at: string | null }>;

      for (const account of accounts) {
        try {
          const result = this.cookieManager.validateCookies(account.platform, account.username);

          if (!result.valid) {
            const detail = result.missingCookies.length > 0
              ? `Missing: ${result.missingCookies.join(', ')}`
              : 'Cookie validation failed';

            warnings.push({
              type: 'cookie_expired',
              username: account.username,
              platform: account.platform,
              detail,
            });

            // Update DB status
            db.prepare('UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?')
              .run('expired', new Date().toISOString(), account.id);
          } else {
            // Check if cookies are about to expire (within 24 hours)
            if (result.expiresAt) {
              const expiresAt = new Date(result.expiresAt).getTime();
              const now = Date.now();
              const hoursLeft = (expiresAt - now) / (1000 * 60 * 60);

              if (hoursLeft <= 24 && hoursLeft > 0) {
                warnings.push({
                  type: 'cookie_warning',
                  username: account.username,
                  platform: account.platform,
                  detail: `Expires in ${Math.round(hoursLeft)}h`,
                });

                db.prepare('UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ?, cookie_expires_at = ? WHERE id = ?')
                  .run('expiring_soon', new Date().toISOString(), result.expiresAt, account.id);
              } else if (hoursLeft > 24) {
                db.prepare('UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ?, cookie_expires_at = ? WHERE id = ?')
                  .run('valid', new Date().toISOString(), result.expiresAt, account.id);
              }
            } else {
              db.prepare('UPDATE dm_accounts SET cookie_status = ?, cookie_last_checked_at = ? WHERE id = ?')
                .run('valid', new Date().toISOString(), account.id);
            }
          }
        } catch {
          // Skip individual account errors
        }
      }
    } catch {
      // dm_accounts table might not have is_active column in all setups
    }

    // 2. Check scraping cookies (platform-level)
    const scrapingPlatforms = ['instagram', 'twitter', 'tiktok', 'youtube', 'xiaohongshu'];
    for (const platform of scrapingPlatforms) {
      try {
        const cookies = this.cookieManager.loadCookies(platform);
        if (cookies.length === 0) continue;

        const critical = this.cookieManager.getCriticalCookieNames(platform);
        const cookieNames = new Set(cookies.map(c => c.name));
        const missing = critical.filter(name => !cookieNames.has(name));
        const now = Math.floor(Date.now() / 1000);

        // Check for expired critical cookies
        const expired: string[] = [];
        let earliestExpiry: number | undefined;
        for (const cookie of cookies) {
          if (critical.includes(cookie.name) && cookie.expires) {
            if (cookie.expires < now) {
              expired.push(cookie.name);
            } else {
              if (!earliestExpiry || cookie.expires < earliestExpiry) {
                earliestExpiry = cookie.expires;
              }
            }
          }
        }

        if (missing.length > 0 || expired.length > 0) {
          const detail = [...missing.map(n => `missing: ${n}`), ...expired.map(n => `expired: ${n}`)].join(', ');
          warnings.push({
            type: 'cookie_expired',
            username: 'scraping',
            platform,
            detail,
          });
        } else if (earliestExpiry) {
          const hoursLeft = (earliestExpiry - now) / 3600;
          if (hoursLeft <= 24 && hoursLeft > 0) {
            warnings.push({
              type: 'cookie_warning',
              username: 'scraping',
              platform,
              detail: `Expires in ${Math.round(hoursLeft)}h`,
            });
          }
        }
      } catch {
        // Skip platform cookie errors
      }
    }

    // Broadcast all warnings on global channel — include campaign names for UI
    for (const warning of warnings) {
      // Look up which campaigns use this account
      let campaignNames: string[] = [];
      if (warning.username !== 'scraping') {
        try {
          const camps = db.prepare(
            'SELECT name FROM dm_campaigns WHERE sender_username = ? AND platform = ?'
          ).all(warning.username, warning.platform) as any[];
          campaignNames = camps.map((c: any) => c.name);
        } catch {}
      }

      sseManager.broadcast('global', warning.type, {
        username: warning.username,
        platform: warning.platform,
        detail: warning.detail,
        campaignNames, // ['포엔의원_TW_인스타', ...] or [] for scraping
        isScraping: warning.username === 'scraping',
      });
    }

    if (warnings.length > 0) {
      console.log(`[Scheduler] Cookie health: ${warnings.length} warning(s) found`);
    }
  }
}

export const scheduler = new SchedulerService();
