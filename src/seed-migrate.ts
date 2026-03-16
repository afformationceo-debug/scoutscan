/**
 * Seed Migration Script (runs on Railway startup)
 * - seed/캠페인데이터.csv → dm_campaigns + dm_accounts
 * - seed/키워드데이터.csv → keyword_targets
 *
 * Skips duplicates, safe to run multiple times.
 * Usage: node --import tsx/esm src/seed-migrate.ts
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

const DB_PATH = join(process.cwd(), 'data', 'scraper.db');
const SEED_DIR = join(process.cwd(), 'seed');
const CAMPAIGN_CSV = join(SEED_DIR, '캠페인데이터.csv');
const KEYWORD_CSV = join(SEED_DIR, '키워드데이터.csv');
const DONE_FLAG = join(process.cwd(), 'data', '.seed-migrated');

// ─── Skip if already migrated ───
if (existsSync(DONE_FLAG)) {
  console.log('[SeedMigrate] Already migrated, skipping.');
  process.exit(0);
}

if (!existsSync(DB_PATH)) {
  console.log('[SeedMigrate] DB not found, skipping (will run next restart).');
  process.exit(0);
}

// ─── CSV Parser ───
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field.trim());
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
        field = '';
        if (ch === '\r') i++;
      } else {
        field += ch;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function normalizePlatform(raw: string): string {
  const map: Record<string, string> = {
    'Instagram': 'instagram', '인스타': 'instagram',
    'Twitter': 'twitter', '트위터': 'twitter',
    'TikTok': 'tiktok', '틱톡': 'tiktok',
  };
  return map[raw] || raw.toLowerCase();
}

function extractSenderFromCookies(cookieJson: string, platform: string): string | null {
  try {
    const cookies = JSON.parse(cookieJson);
    if (!Array.isArray(cookies)) return null;
    if (platform === 'instagram') {
      const dsUser = cookies.find((c: any) => c.name === 'ds_user_id');
      return dsUser?.value || null;
    }
    if (platform === 'twitter') {
      const twid = cookies.find((c: any) => c.name === 'twid');
      if (twid?.value) {
        const match = twid.value.match(/u=(\d+)/);
        return match ? match[1] : twid.value;
      }
      return null;
    }
    return null;
  } catch { return null; }
}

// ─── Main ───
function main() {
  console.log('[SeedMigrate] === CSV → DB 마이그레이션 시작 ===\n');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  let totalMigrated = 0;

  // ─── 1. Campaign Migration ───
  if (existsSync(CAMPAIGN_CSV)) {
    console.log('[SeedMigrate] 캠페인 데이터 마이그레이션...');
    const csvContent = readFileSync(CAMPAIGN_CSV, 'utf-8');
    const rows = parseCSV(csvContent);

    const insertCampaign = db.prepare(`
      INSERT INTO dm_campaigns (
        id, name, brand, platform, target_country, target_tiers,
        min_followers, max_followers, message_template,
        daily_limit, max_retries, delay_min_sec, delay_max_sec,
        status, sender_username, cookie_json, cookie_status,
        linked_keyword_group,
        total_queued, total_sent, total_failed, total_replied,
        created_at, updated_at
      ) VALUES (
        @id, @name, @brand, @platform, @targetCountry, @targetTiers,
        @minFollowers, @maxFollowers, @messageTemplate,
        @dailyLimit, @maxRetries, @delayMinSec, @delayMaxSec,
        @status, @senderUsername, @cookieJson, @cookieStatus,
        @linkedKeywordGroup,
        0, 0, 0, 0, @now, @now
      )
    `);

    const upsertAccount = db.prepare(`
      INSERT INTO dm_accounts (platform, username, cookie_json, cookie_status, cookie_last_checked_at, daily_sent, daily_limit, status, created_at)
      VALUES (@platform, @username, @cookieJson, 'valid', @now, 0, @dailyLimit, 'active', @now)
      ON CONFLICT(platform, username) DO UPDATE SET
        cookie_json = @cookieJson, cookie_status = 'valid',
        cookie_last_checked_at = @now, daily_limit = @dailyLimit
    `);

    const existingNames = new Set(
      (db.prepare('SELECT name FROM dm_campaigns').all() as any[]).map(r => r.name)
    );

    const now = new Date().toISOString();
    let migrated = 0, skipped = 0, errors: string[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < 7) continue;
      const [rawName, brand, rawPlatform, country, rawLimit, message, cookieJson] = r;

      if (!message || message.length === 0) { skipped++; continue; }
      if (existingNames.has(rawName)) { skipped++; continue; }

      const platform = normalizePlatform(rawPlatform);
      const dailyLimit = parseInt(rawLimit) || 40;
      const senderUsername = extractSenderFromCookies(cookieJson, platform);

      if (!senderUsername) { errors.push(`${rawName}: 발송 계정 식별 실패`); continue; }

      try {
        // Auto-map: platform:country → linked_keyword_group
        const linkedKeywordGroup = country ? `${platform}:${country}` : null;

        insertCampaign.run({
          id: crypto.randomUUID(), name: rawName, brand: brand || null,
          platform, targetCountry: country || null, targetTiers: null,
          minFollowers: null, maxFollowers: null, messageTemplate: message,
          dailyLimit, maxRetries: 2, delayMinSec: 45, delayMaxSec: 120,
          status: 'draft', senderUsername, cookieJson, cookieStatus: 'valid',
          linkedKeywordGroup, now,
        });
        upsertAccount.run({ platform, username: senderUsername, cookieJson, dailyLimit, now });
        migrated++;
      } catch (err) {
        errors.push(`${rawName}: ${(err as Error).message}`);
      }
    }

    console.log(`[SeedMigrate] 캠페인: ${migrated}개 추가, ${skipped}개 건너뜀, ${errors.length}개 오류`);
    if (errors.length > 0) errors.forEach(e => console.log(`  ❌ ${e}`));
    totalMigrated += migrated;
  }

  // ─── 2. Keyword Migration ───
  if (existsSync(KEYWORD_CSV)) {
    console.log('[SeedMigrate] 키워드 데이터 마이그레이션...');
    const csvContent = readFileSync(KEYWORD_CSV, 'utf-8');
    const rows = parseCSV(csvContent);

    const existingPairs = new Set(
      (db.prepare('SELECT pair_id FROM keyword_targets').all() as any[]).map(r => r.pair_id)
    );

    const insertKeyword = db.prepare(`
      INSERT INTO keyword_targets (
        pair_id, platform, region, keyword, scraping_cycle_hours,
        max_results_per_run, is_active, next_scrape_at, group_key,
        scrape_until, total_extracted, created_at, updated_at
      ) VALUES (
        @pairId, @platform, @region, @keyword, @cycleHours,
        @maxResults, 1, @now, @groupKey,
        @scrapeUntil, 0, @now, @now
      )
    `);

    const now = new Date().toISOString();
    let migrated = 0, skipped = 0;

    // Header: 플랫폼,국가,#키워드,페어 ID,주기,1회 최대 수량,UNTIL (종료일)
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < 6) continue;

      const [rawPlatform, region, rawKeyword, existingPairId, rawCycle, rawMax, scrapeUntil] = r;
      const platform = normalizePlatform(rawPlatform);
      const keyword = rawKeyword.replace(/^#/, '');
      const pairId = existingPairId || `${platform}:${region}:${keyword}`;

      if (existingPairs.has(pairId)) { skipped++; continue; }

      try {
        insertKeyword.run({
          pairId, platform, region, keyword,
          cycleHours: parseInt(rawCycle) || 72,
          maxResults: parseInt(rawMax) || 150,
          groupKey: `${region}:${keyword}`,
          scrapeUntil: scrapeUntil || null,
          now,
        });
        migrated++;
      } catch (err) {
        console.log(`  ❌ ${keyword}: ${(err as Error).message}`);
      }
    }

    console.log(`[SeedMigrate] 키워드: ${migrated}개 추가, ${skipped}개 건너뜀`);
    totalMigrated += migrated;
  }

  // ─── Summary ───
  const totalCampaigns = (db.prepare('SELECT COUNT(*) as cnt FROM dm_campaigns').get() as any).cnt;
  const totalAccounts = (db.prepare('SELECT COUNT(*) as cnt FROM dm_accounts').get() as any).cnt;
  const totalKeywords = (db.prepare('SELECT COUNT(*) as cnt FROM keyword_targets').get() as any).cnt;

  console.log(`\n[SeedMigrate] === 완료 ===`);
  console.log(`[SeedMigrate] DB 현황: 캠페인 ${totalCampaigns}개, DM계정 ${totalAccounts}개, 키워드 ${totalKeywords}개`);

  // Mark as done
  if (totalMigrated > 0) {
    writeFileSync(DONE_FLAG, new Date().toISOString());
    console.log('[SeedMigrate] .seed-migrated 플래그 생성 (다음 시작 시 건너뜀)');
  }

  db.close();
}

main();
