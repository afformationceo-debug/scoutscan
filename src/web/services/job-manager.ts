import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import pLimit from 'p-limit';
import { ScrapingEngine } from '../../core/engine.js';
import type { Platform, Post, InfluencerProfile } from '../../core/types.js';
import {
  createJob, updateJobStatus, getJob, insertPost, insertProfile, getExistingProfileUsernames, getMissingProfileUsernames, db,
} from './db.js';
import { upsertInfluencer, updateInfluencerGeo, getKeywordTarget, updateKeywordTarget } from './master-db.js';
import { registry } from '../../services/registry.js';
import { GeoClassifier } from '../../core/geo-classifier.js';
import { AIClassifier } from '../../services/ai-classifier.js';
import { sseManager } from './sse-manager.js';
import { logger } from '../../utils/logger.js';

interface SSEClient {
  id: string;
  jobId: string;
  controller: ReadableStreamDefaultController;
}

class JobManager extends EventEmitter {
  private jobLimit = pLimit(3);
  private sseClients: SSEClient[] = [];
  private geoClassifier = new GeoClassifier();

  /** Load active proxy URLs from DB */
  private getProxyUrls(): string[] {
    try {
      const rows = db.prepare('SELECT url FROM proxy_settings WHERE is_active = 1').all() as any[];
      return rows.map((r: any) => r.url).filter(Boolean);
    } catch { return []; }
  }

  /** Get minimum follower count for scraping filter (platform-specific, default 2000) */
  private getMinFollowersScrape(platform: string): number {
    try {
      const row = db.prepare('SELECT min_followers_scrape FROM platform_dm_defaults WHERE platform = ?').get(platform) as any;
      if (row?.min_followers_scrape) return row.min_followers_scrape;
    } catch { /* column may not exist yet */ }
    return 2000; // hardcoded fallback
  }

  /** Run GeoClassifier on a profile and persist result */
  private geoClassify(profile: InfluencerProfile): void {
    try {
      const geo = this.geoClassifier.classify(profile);
      if (geo.confidence >= 0.4) {
        updateInfluencerGeo(profile.platform, profile.username, geo);
      }
    } catch {
      // GeoClassifier errors should not break enrichment
    }
  }

  /** Start a hashtag search job */
  startHashtagJob(platform: Platform, hashtag: string, maxResults = 50, enrichProfiles = true, pairId?: string, since?: string, until?: string): string {
    const jobId = randomUUID();
    createJob({
      id: jobId,
      type: 'hashtag',
      platform,
      query: hashtag,
      status: 'pending',
      maxResults,
      createdAt: new Date().toISOString(),
    });

    this.jobLimit(() => this.runHashtagJob(jobId, platform, hashtag, maxResults, enrichProfiles, since, pairId, until)).catch(error => {
      updateJobStatus(jobId, 'failed', {
        error: (error as Error).message,
      });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
    });

    return jobId;
  }

  /** Start a profile scraping job */
  startProfileJob(platform: Platform, username: string): string {
    const jobId = randomUUID();
    createJob({
      id: jobId,
      type: 'profile',
      platform,
      query: username,
      status: 'pending',
      maxResults: 1,
      createdAt: new Date().toISOString(),
    });

    this.jobLimit(() => this.runProfileJob(jobId, platform, username)).catch(error => {
      updateJobStatus(jobId, 'failed', {
        error: (error as Error).message,
      });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
    });

    return jobId;
  }

  /** Start a re-enrichment job for missing profiles */
  startReEnrichJob(platform: Platform): string {
    const missing = getMissingProfileUsernames(platform);
    if (missing.length === 0) {
      throw new Error('No missing profiles to enrich');
    }

    const jobId = randomUUID();
    createJob({
      id: jobId,
      type: 'profile' as any,
      platform,
      query: `re-enrich (${missing.length} profiles)`,
      status: 'pending',
      maxResults: missing.length,
      createdAt: new Date().toISOString(),
    });

    this.jobLimit(() => this.runReEnrichJob(jobId, platform, missing)).catch(error => {
      updateJobStatus(jobId, 'failed', {
        error: (error as Error).message,
      });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
    });

    return jobId;
  }

  /** Register an SSE client for a job */
  addSSEClient(jobId: string, controller: ReadableStreamDefaultController): string {
    const clientId = randomUUID();
    this.sseClients.push({ id: clientId, jobId, controller });

    // Send current job state
    const job = getJob(jobId);
    if (job) {
      this.sendSSE(jobId, 'status', job);
    }

    return clientId;
  }

  /** Remove an SSE client */
  removeSSEClient(clientId: string): void {
    this.sseClients = this.sseClients.filter(c => c.id !== clientId);
  }

  /** Check if a job is already running for this pairId */
  isJobRunningForPairId(pairId: string): boolean {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM keyword_targets WHERE pair_id = ? AND last_job_status = 'running'`
    ).get(pairId) as any;
    return (row?.count || 0) > 0;
  }

  private async runHashtagJob(jobId: string, platform: Platform, hashtag: string, maxResults: number, enrichProfiles = true, since?: string, pairId?: string, until?: string): Promise<void> {
    updateJobStatus(jobId, 'running');
    this.sendSSE(jobId, 'status', { status: 'running' });

    // Broadcast global scraping_started notification
    sseManager.broadcast('global', 'scraping_started', { jobId, platform, keyword: hashtag, pairId });

    const proxyUrls = this.getProxyUrls();
    logger.info(`[JobManager] Starting hashtag job: ${platform}/#${hashtag} (max: ${maxResults}, proxies: ${proxyUrls.length})`);
    const engine = new ScrapingEngine({ platforms: [platform], proxyUrls, sharedBrowser: registry.scrapingBrowser });
    let count = 0;
    let latestPostTimestamp = '';
    const collectedPosts: Post[] = [];
    let allUsernames: string[] = [];
    let newUsernames: string[] = [];
    let filteredCount = 0;
    let failedUsernames: string[] = [];

    try {
      const scraper = (engine as any).scrapers.get(platform);
      if (!scraper) throw new Error(`Platform not available: ${platform}`);
      logger.info(`[JobManager] Scraper obtained for ${platform}, starting searchByHashtag...`);

      // Phase 1: Collect posts
      for await (const post of scraper.searchByHashtag(hashtag, { maxResults, since, until })) {
        count++;
        collectedPosts.push(post);
        insertPost(jobId, post);
        // Track latest post timestamp for delta scraping
        if (post.timestamp && post.timestamp > latestPostTimestamp) {
          latestPostTimestamp = post.timestamp;
        }
        updateJobStatus(jobId, 'running', { resultCount: count });
        this.sendSSE(jobId, 'post', post);
        this.sendSSE(jobId, 'progress', { phase: 'posts', count, total: maxResults });

        // Broadcast every 10th post globally (avoid flooding)
        if (count % 10 === 0 || count === 1) {
          sseManager.broadcast('global', 'scraping_progress', {
            jobId, platform, keyword: hashtag, pairId,
            phase: 'posts', count, total: maxResults,
            lastPost: { username: post.owner?.username, likes: post.likesCount },
          });
        }

        if (count >= maxResults) break;
      }

      // Phase 2: Profile enrichment (skip already-scraped profiles across all jobs)
      let profilesCount = 0;
      if (enrichProfiles && collectedPosts.length > 0) {
        const existingProfiles = getExistingProfileUsernames(platform);
        allUsernames = [...new Set(
          collectedPosts
            .map(p => p.owner?.username)
            .filter((u): u is string => Boolean(u))
        )];
        newUsernames = allUsernames.filter(u => !existingProfiles.has(u));
        const skipped = allUsernames.length - newUsernames.length;

        if (skipped > 0) {
          console.log(`[enrichment] Skipping ${skipped} already-scraped profiles, ${newUsernames.length} new to fetch`);
        }

        this.sendSSE(jobId, 'profile_start', { total: newUsernames.length, skipped });
        sseManager.broadcast('global', 'scraping_progress', {
          jobId, platform, keyword: hashtag, pairId,
          phase: 'profiles_start', total: newUsernames.length, skipped,
        });

        const limit = pLimit(3);
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 5;
        failedUsernames = [];

        // Load min follower threshold from platform settings
        const minFollowers = this.getMinFollowersScrape(platform);
        filteredCount = 0;

        const enrichTasks = newUsernames.map(username =>
          limit(async () => {
            try {
              const profile = await engine.getProfile(platform, username);

              // Filter: skip profiles below minimum follower threshold
              if (profile.followersCount < minFollowers) {
                filteredCount++;
                console.log(`[enrichment] Skipped @${username}: ${profile.followersCount} followers < ${minFollowers} minimum`);
                this.sendSSE(jobId, 'profile_filtered', {
                  username, followers: profile.followersCount, minFollowers, filteredCount,
                });
                return; // Skip DB save entirely
              }

              insertProfile(jobId, profile);
              upsertInfluencer(profile, pairId);
              this.geoClassify(profile);
              profilesCount++;
              consecutiveFailures = 0;
              this.sendSSE(jobId, 'profile', profile);
              this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: newUsernames.length, filtered: filteredCount });
              // Broadcast every profile to global feed
              sseManager.broadcast('global', 'profile_enriched', {
                jobId, platform, keyword: hashtag, pairId,
                username: profile.username,
                fullName: profile.fullName,
                followers: profile.followersCount,
                count: profilesCount, total: newUsernames.length, filtered: filteredCount,
              });
            } catch (err) {
              consecutiveFailures++;
              failedUsernames.push(username);
              console.warn(`[enrichment] Failed @${username} (${consecutiveFailures} consecutive): ${(err as Error).message}`);
              this.sendSSE(jobId, 'profile_error', { username, error: (err as Error).message, consecutiveFailures });
              sseManager.broadcast('global', 'profile_error', {
                jobId, platform, keyword: hashtag, pairId,
                username, error: (err as Error).message,
              });

              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.warn(`[enrichment] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, pausing 30s to recover...`);
                this.sendSSE(jobId, 'profile_pause', { reason: 'consecutive_failures', pauseSeconds: 30 });
                await new Promise(r => setTimeout(r, 30000));
                consecutiveFailures = 0;
              }
            }

            // Anti-bot delay (slightly shorter since we're parallel)
            const delay = 800 + Math.random() * 1200;
            await new Promise(r => setTimeout(r, delay));
          })
        );

        await Promise.allSettled(enrichTasks);

        if (failedUsernames.length > 0) {
          console.log(`[enrichment] Retrying ${failedUsernames.length} failed profiles...`);
          this.sendSSE(jobId, 'profile_retry', { count: failedUsernames.length });

          const retryLimit = pLimit(2);
          const retryTasks = failedUsernames.map(username =>
            retryLimit(async () => {
              try {
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                const profile = await engine.getProfile(platform, username);
                // Same follower filter on retry
                if (profile.followersCount < minFollowers) {
                  filteredCount++;
                  console.log(`[enrichment] Retry skipped @${username}: ${profile.followersCount} < ${minFollowers}`);
                  return;
                }
                insertProfile(jobId, profile);
                upsertInfluencer(profile, pairId);
                this.geoClassify(profile);
                profilesCount++;
                this.sendSSE(jobId, 'profile', profile);
                this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: newUsernames.length });
              } catch {
                console.warn(`[enrichment] Retry also failed for @${username}, skipping`);
              }
            })
          );
          await Promise.allSettled(retryTasks);
        }

        // Log filtering stats
        if (filteredCount > 0) {
          console.log(`[enrichment] Filter stats: ${profilesCount} saved, ${filteredCount} filtered (< ${minFollowers} followers), ${failedUsernames.length} failed`);
          this.sendSSE(jobId, 'filter_stats', { saved: profilesCount, filtered: filteredCount, minFollowers, failed: failedUsernames.length });
        }
      }

      // Phase 3: AI Classification (if OpenAI key available)
      if (profilesCount > 0) {
        const aiKey = process.env.OPENAI_API_KEY;
        if (aiKey) {
          try {
            this.sendSSE(jobId, 'progress', { phase: 'ai_classify', count: 0, total: profilesCount });
            sseManager.broadcast('global', 'ai_classify_start', {
              jobId, platform, keyword: hashtag, pairId, total: profilesCount,
            });
            const classifier = new AIClassifier(aiKey);
            const aiCount = await classifier.classifyAll({
              onProgress: (done, total) => {
                this.sendSSE(jobId, 'progress', { phase: 'ai_classify', count: done, total });
                // Broadcast AI progress every 10 profiles
                if (done % 10 === 0 || done === total) {
                  sseManager.broadcast('global', 'ai_classify_progress', {
                    jobId, platform, keyword: hashtag, pairId, count: done, total,
                  });
                }
              },
            });
            const assigned = classifier.autoAssignToCampaigns();
            console.log(`[JobManager] AI classified ${aiCount} profiles, assigned ${assigned} to campaigns`);
            this.sendSSE(jobId, 'ai_complete', { classified: aiCount, assigned });
            sseManager.broadcast('global', 'ai_classify_complete', {
              jobId, platform, keyword: hashtag, pairId, classified: aiCount, assigned,
            });
            if (assigned > 0) {
              sseManager.broadcast('global', 'auto_assign', { assigned, message: `${assigned} profiles auto-assigned to campaigns` });
            }
          } catch (err) {
            console.warn(`[JobManager] AI classification failed:`, (err as Error).message);
          }
        }
      }

      // Detect 0-result scraping (likely cookie/proxy issue)
      let cookieWarning = '';
      if (count === 0) {
        const needsCookies = ['instagram', 'tiktok', 'twitter'];
        if (needsCookies.includes(platform)) {
          const { CookieManager } = await import('../../core/cookie-manager.js');
          const cm = new CookieManager();
          const hasCookies = cm.hasCookies(platform);
          if (!hasCookies) {
            cookieWarning = `${platform} 쿠키 없음 — 설정에서 쿠키를 등록해주세요`;
          } else {
            cookieWarning = `${platform} 쿠키가 만료되었거나 IP가 차단되었을 수 있습니다 — 쿠키 재등록 또는 프록시 설정을 확인하세요`;
          }
          sseManager.broadcast('global', 'cookie_warning', {
            platform, pairId,
            message: cookieWarning,
          });
        }
      }

      // Save with enrichment stats so history shows actual useful numbers
      const skipped = allUsernames ? (allUsernames.length - newUsernames.length) : 0;
      updateJobStatus(jobId, 'completed', {
        resultCount: count,
        profilesSaved: profilesCount,
        profilesFiltered: filteredCount || 0,
        profilesSkipped: skipped,
        profilesFailed: failedUsernames ? failedUsernames.length : 0,
        error: cookieWarning || undefined,
      });
      this.sendSSE(jobId, 'complete', { postsCount: count, profilesCount, filteredCount: filteredCount || 0, skippedCount: skipped, cookieWarning });

      // Broadcast global scraping_completed notification
      sseManager.broadcast('global', 'scraping_completed', { jobId, postsCount: count, profilesCount, pairId, cookieWarning });

      // Update keyword target totalExtracted, job status, and last post timestamp for delta scraping
      if (pairId) {
        const target = getKeywordTarget(pairId);
        if (target) {
          const updateFields: any = { totalExtracted: (target.totalExtracted || 0) + count };

          // Save the latest post timestamp for delta scraping on next run
          if (latestPostTimestamp) {
            updateFields.lastPostTimestamp = latestPostTimestamp;
          }

          updateKeywordTarget(target.id, updateFields);
        }
        const resultObj: any = { posts: count, profiles: profilesCount, completedAt: new Date().toISOString() };
        if (cookieWarning) resultObj.cookieWarning = cookieWarning;
        const resultJson = JSON.stringify(resultObj);
        db.prepare(`UPDATE keyword_targets SET last_job_status = 'completed', last_job_result = ? WHERE pair_id = ?`).run(resultJson, pairId);
      }

      // Post-completion: auto-replenish DM queues with newly scraped profiles
      try {
        const added = registry.dmEngine?.autoReplenishQueues() ?? 0;
        if (added > 0) console.log(`[JobManager] Auto-replenished ${added} DM queue targets after job ${jobId.slice(0, 8)}`);
      } catch (err) {
        console.warn(`[JobManager] DM replenish failed:`, (err as Error).message);
      }
    } catch (error) {
      updateJobStatus(jobId, 'failed', { error: (error as Error).message, resultCount: count });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
      if (pairId) {
        const failJson = JSON.stringify({ error: (error as Error).message, failedAt: new Date().toISOString() });
        db.prepare(`UPDATE keyword_targets SET last_job_status = 'failed', last_job_result = ? WHERE pair_id = ?`).run(failJson, pairId);
      }
    } finally {
      await engine.close();
    }
  }

  private async runProfileJob(jobId: string, platform: Platform, username: string): Promise<void> {
    updateJobStatus(jobId, 'running');
    this.sendSSE(jobId, 'status', { status: 'running' });

    const engine = new ScrapingEngine({ platforms: [platform], proxyUrls: this.getProxyUrls(), sharedBrowser: registry.scrapingBrowser });

    try {
      const profile = await engine.getProfile(platform, username);
      insertProfile(jobId, profile);
      upsertInfluencer(profile);
      this.geoClassify(profile);
      updateJobStatus(jobId, 'completed', { resultCount: 1 });
      this.sendSSE(jobId, 'profile', profile);
      this.sendSSE(jobId, 'complete', { resultCount: 1 });
    } catch (error) {
      updateJobStatus(jobId, 'failed', { error: (error as Error).message });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
    } finally {
      await engine.close();
    }
  }

  private async runReEnrichJob(jobId: string, platform: Platform, usernames: string[]): Promise<void> {
    updateJobStatus(jobId, 'running');
    this.sendSSE(jobId, 'status', { status: 'running' });

    const engine = new ScrapingEngine({ platforms: [platform], proxyUrls: this.getProxyUrls(), sharedBrowser: registry.scrapingBrowser });
    let profilesCount = 0;

    try {
      this.sendSSE(jobId, 'profile_start', { total: usernames.length, skipped: 0 });

      const limit = pLimit(3);
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 5;
      let failedUsernames: string[] = [];

      const minFollowers = this.getMinFollowersScrape(platform);
      let filteredCount = 0;

      const enrichTasks = usernames.map(username =>
        limit(async () => {
          try {
            const profile = await engine.getProfile(platform, username);
            if (profile.followersCount < minFollowers) {
              filteredCount++;
              console.log(`[re-enrich] Skipped @${username}: ${profile.followersCount} < ${minFollowers}`);
              return;
            }
            insertProfile(jobId, profile);
            upsertInfluencer(profile);
            this.geoClassify(profile);
            profilesCount++;
            consecutiveFailures = 0;
            this.sendSSE(jobId, 'profile', profile);
            this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: usernames.length });
          } catch (err) {
            consecutiveFailures++;
            failedUsernames.push(username);
            console.warn(`[re-enrich] Failed @${username} (${consecutiveFailures}): ${(err as Error).message}`);
            this.sendSSE(jobId, 'profile_error', { username, error: (err as Error).message, consecutiveFailures });

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              this.sendSSE(jobId, 'profile_pause', { reason: 'consecutive_failures', pauseSeconds: 30 });
              await new Promise(r => setTimeout(r, 30000));
              consecutiveFailures = 0;
            }
          }

          // Anti-bot delay (slightly shorter since we're parallel)
          const delay = 800 + Math.random() * 1200;
          await new Promise(r => setTimeout(r, delay));
        })
      );

      await Promise.allSettled(enrichTasks);

      // Retry failed profiles once
      if (failedUsernames.length > 0) {
        this.sendSSE(jobId, 'profile_retry', { count: failedUsernames.length });

        const retryLimit = pLimit(2);
        const retryTasks = failedUsernames.map(username =>
          retryLimit(async () => {
            try {
              await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
              const profile = await engine.getProfile(platform, username);
              insertProfile(jobId, profile);
              upsertInfluencer(profile);
              this.geoClassify(profile);
              profilesCount++;
              this.sendSSE(jobId, 'profile', profile);
              this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: usernames.length });
            } catch {
              console.warn(`[re-enrich] Retry also failed for @${username}`);
            }
          })
        );
        await Promise.allSettled(retryTasks);
      }

      // Detect 0-result re-enrichment (likely cookie/proxy issue)
      let reEnrichWarning = '';
      if (profilesCount === 0) {
        const needsCookies = ['instagram', 'tiktok', 'twitter'];
        if (needsCookies.includes(platform)) {
          reEnrichWarning = `${platform} 쿠키가 만료되었거나 없습니다. 설정에서 확인하세요.`;
        }
      }

      updateJobStatus(jobId, 'completed', {
        resultCount: profilesCount,
        error: reEnrichWarning || undefined,
      });
      this.sendSSE(jobId, 'complete', { postsCount: 0, profilesCount, cookieWarning: reEnrichWarning });
    } catch (error) {
      updateJobStatus(jobId, 'failed', { error: (error as Error).message, resultCount: profilesCount });
      this.sendSSE(jobId, 'error', { message: (error as Error).message });
    } finally {
      await engine.close();
    }
  }

  private sendSSE(jobId: string, event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const clients = this.sseClients.filter(c => c.jobId === jobId);

    for (const client of clients) {
      try {
        client.controller.enqueue(new TextEncoder().encode(payload));
      } catch {
        // Client disconnected
        this.removeSSEClient(client.id);
      }
    }
  }
}

export const jobManager = new JobManager();
