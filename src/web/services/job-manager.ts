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

interface SSEClient {
  id: string;
  jobId: string;
  controller: ReadableStreamDefaultController;
}

class JobManager extends EventEmitter {
  private jobLimit = pLimit(3);
  private sseClients: SSEClient[] = [];
  private geoClassifier = new GeoClassifier();

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

  private async runHashtagJob(jobId: string, platform: Platform, hashtag: string, maxResults: number, enrichProfiles = true, since?: string, pairId?: string, until?: string): Promise<void> {
    updateJobStatus(jobId, 'running');
    this.sendSSE(jobId, 'status', { status: 'running' });

    // Broadcast global scraping_started notification
    sseManager.broadcast('global', 'scraping_started', { jobId, platform, keyword: hashtag, pairId });

    const engine = new ScrapingEngine({ platforms: [platform] });
    let count = 0;
    const collectedPosts: Post[] = [];

    try {
      const scraper = (engine as any).scrapers.get(platform);
      if (!scraper) throw new Error(`Platform not available: ${platform}`);

      // Phase 1: Collect posts
      for await (const post of scraper.searchByHashtag(hashtag, { maxResults, since, until })) {
        count++;
        collectedPosts.push(post);
        insertPost(jobId, post);
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
        const allUsernames = [...new Set(
          collectedPosts
            .map(p => p.owner?.username)
            .filter((u): u is string => Boolean(u))
        )];
        const newUsernames = allUsernames.filter(u => !existingProfiles.has(u));
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
        let failedUsernames: string[] = [];

        const enrichTasks = newUsernames.map(username =>
          limit(async () => {
            try {
              const profile = await engine.getProfile(platform, username);
              insertProfile(jobId, profile);
              upsertInfluencer(profile);
              this.geoClassify(profile);
              profilesCount++;
              consecutiveFailures = 0;
              this.sendSSE(jobId, 'profile', profile);
              this.sendSSE(jobId, 'progress', { phase: 'profiles', count: profilesCount, total: newUsernames.length });
              // Broadcast every profile to global feed
              sseManager.broadcast('global', 'profile_enriched', {
                jobId, platform, keyword: hashtag, pairId,
                username: profile.username,
                fullName: profile.fullName,
                followers: profile.followersCount,
                count: profilesCount, total: newUsernames.length,
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
                insertProfile(jobId, profile);
                upsertInfluencer(profile);
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

      updateJobStatus(jobId, 'completed', { resultCount: count });
      this.sendSSE(jobId, 'complete', { postsCount: count, profilesCount });

      // Broadcast global scraping_completed notification
      sseManager.broadcast('global', 'scraping_completed', { jobId, postsCount: count, profilesCount, pairId });

      // Update keyword target totalExtracted and job status
      if (pairId) {
        const target = getKeywordTarget(pairId);
        if (target) {
          updateKeywordTarget(target.id, { totalExtracted: (target.totalExtracted || 0) + count });
        }
        const resultJson = JSON.stringify({ posts: count, profiles: profilesCount, completedAt: new Date().toISOString() });
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

    const engine = new ScrapingEngine({ platforms: [platform] });

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

    const engine = new ScrapingEngine({ platforms: [platform] });
    let profilesCount = 0;

    try {
      this.sendSSE(jobId, 'profile_start', { total: usernames.length, skipped: 0 });

      const limit = pLimit(3);
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 5;
      let failedUsernames: string[] = [];

      const enrichTasks = usernames.map(username =>
        limit(async () => {
          try {
            const profile = await engine.getProfile(platform, username);
            insertProfile(jobId, profile);
            upsertInfluencer(profile);
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

      updateJobStatus(jobId, 'completed', { resultCount: profilesCount });
      this.sendSSE(jobId, 'complete', { postsCount: 0, profilesCount });
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
