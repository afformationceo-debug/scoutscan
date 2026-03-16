/**
 * CSV → DB 마이그레이션 스크립트
 * 캠페인데이터.csv → dm_campaigns + dm_accounts
 *
 * Usage: npx tsx src/migrate-campaigns.ts
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

const DB_PATH = join(process.cwd(), 'data', 'scraper.db');
const CSV_PATH = join(process.cwd(), '..', '캠페인데이터.csv');

// ─── CSV Parser (handles quoted fields with commas and newlines) ───
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

// ─── Platform mapping ───
function normalizePlatform(raw: string): string {
  const map: Record<string, string> = {
    'Instagram': 'instagram',
    '인스타': 'instagram',
    'Twitter': 'twitter',
    '트위터': 'twitter',
    'TikTok': 'tiktok',
    '틱톡': 'tiktok',
  };
  return map[raw] || raw.toLowerCase();
}

// ─── Extract sender identifier from cookies ───
function extractSenderFromCookies(cookieJson: string, platform: string): string | null {
  try {
    const cookies = JSON.parse(cookieJson);
    if (!Array.isArray(cookies)) return null;

    if (platform === 'instagram') {
      const dsUser = cookies.find((c: any) => c.name === 'ds_user_id');
      return dsUser?.value || null;
    }
    if (platform === 'twitter') {
      // Use twid or ct0 as identifier
      const twid = cookies.find((c: any) => c.name === 'twid');
      if (twid?.value) {
        // twid format: "u=123456789"
        const match = twid.value.match(/u=(\d+)/);
        return match ? match[1] : twid.value;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main ───
function main() {
  console.log('=== 캠페인 데이터 마이그레이션 시작 ===\n');

  // Read CSV
  const csvContent = readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCSV(csvContent);
  console.log(`CSV 파싱 완료: ${rows.length - 1}개 캠페인 발견\n`);

  // Open DB
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Prepare statements
  const insertCampaign = db.prepare(`
    INSERT INTO dm_campaigns (
      id, name, brand, platform, target_country, target_tiers,
      min_followers, max_followers, message_template,
      daily_limit, max_retries, delay_min_sec, delay_max_sec,
      status, sender_username, cookie_json, cookie_status,
      total_queued, total_sent, total_failed, total_replied,
      created_at, updated_at
    ) VALUES (
      @id, @name, @brand, @platform, @targetCountry, @targetTiers,
      @minFollowers, @maxFollowers, @messageTemplate,
      @dailyLimit, @maxRetries, @delayMinSec, @delayMaxSec,
      @status, @senderUsername, @cookieJson, @cookieStatus,
      0, 0, 0, 0, @now, @now
    )
  `);

  const upsertAccount = db.prepare(`
    INSERT INTO dm_accounts (platform, username, cookie_json, cookie_status, cookie_last_checked_at, daily_sent, daily_limit, status, created_at)
    VALUES (@platform, @username, @cookieJson, 'valid', @now, 0, @dailyLimit, 'active', @now)
    ON CONFLICT(platform, username) DO UPDATE SET
      cookie_json = @cookieJson,
      cookie_status = 'valid',
      cookie_last_checked_at = @now,
      daily_limit = @dailyLimit
  `);

  // Check existing campaigns to avoid duplicates
  const existingNames = new Set(
    (db.prepare('SELECT name FROM dm_campaigns').all() as any[]).map(r => r.name)
  );

  const now = new Date().toISOString();
  let migrated = 0;
  let skipped = 0;
  let errors: string[] = [];

  // Process each row (skip header)
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 7) continue;

    const [rawName, brand, rawPlatform, country, rawLimit, message, cookieJson] = r;

    // Skip empty message template (스마일뷰치과_JP_트위터)
    if (!message || message.length === 0) {
      console.log(`⏭️  건너뜀 (빈 메시지): ${rawName}`);
      skipped++;
      continue;
    }

    // Skip duplicates
    if (existingNames.has(rawName)) {
      console.log(`⏭️  건너뜀 (중복): ${rawName}`);
      skipped++;
      continue;
    }

    const platform = normalizePlatform(rawPlatform);
    const dailyLimit = parseInt(rawLimit) || 40;
    const senderUsername = extractSenderFromCookies(cookieJson, platform);

    if (!senderUsername) {
      errors.push(`${rawName}: 발송 계정 식별 실패`);
      continue;
    }

    try {
      const id = crypto.randomUUID();

      // Insert campaign
      insertCampaign.run({
        id,
        name: rawName,
        brand: brand || null,
        platform,
        targetCountry: country || null,
        targetTiers: null,
        minFollowers: null,
        maxFollowers: null,
        messageTemplate: message,
        dailyLimit,
        maxRetries: 2,
        delayMinSec: 45,
        delayMaxSec: 120,
        status: 'draft',
        senderUsername,
        cookieJson,
        cookieStatus: 'valid',
        now,
      });

      // Upsert DM account
      upsertAccount.run({
        platform,
        username: senderUsername,
        cookieJson,
        dailyLimit,
        now,
      });

      migrated++;
      console.log(`✅ ${rawName} → ${platform}/${senderUsername} (한도: ${dailyLimit}/일)`);
    } catch (err) {
      errors.push(`${rawName}: ${(err as Error).message}`);
    }
  }

  // Summary
  console.log('\n=== 마이그레이션 완료 ===');
  console.log(`✅ 성공: ${migrated}개`);
  console.log(`⏭️  건너뜀: ${skipped}개`);
  if (errors.length > 0) {
    console.log(`❌ 오류: ${errors.length}개`);
    errors.forEach(e => console.log(`   ${e}`));
  }

  // Verify
  const totalCampaigns = (db.prepare('SELECT COUNT(*) as cnt FROM dm_campaigns').get() as any).cnt;
  const totalAccounts = (db.prepare('SELECT COUNT(*) as cnt FROM dm_accounts').get() as any).cnt;
  console.log(`\n📊 DB 현황: 캠페인 ${totalCampaigns}개, DM계정 ${totalAccounts}개`);

  db.close();
}

main();
