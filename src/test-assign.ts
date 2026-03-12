import Database from 'better-sqlite3';
import { join } from 'path';
const db = new Database(join('data', 'scraper.db'));

// Check unclassified profiles from 韓国美容 source
const unclassified = db.prepare(`
  SELECT COUNT(*) as cnt FROM influencer_master
  WHERE (detected_country IS NULL OR detected_country = '')
  AND source_pair_ids LIKE '%韓国美容%'
`).get() as any;
console.log('Unclassified from 韓国美容:', unclassified.cnt);

// Classify unclassified profiles from JP keyword as JP (source-based geo)
const updated = db.prepare(`
  UPDATE influencer_master
  SET detected_country = 'JP',
      geo_source = 'source_keyword_hint',
      geo_confidence = 0.5,
      last_updated_at = ?
  WHERE (detected_country IS NULL OR detected_country = '')
  AND source_pair_ids LIKE '%instagram:JP:%'
`).run(new Date().toISOString());
console.log('Updated to JP (source-based):', updated.changes);

// Now check totals
const jpTotal = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE detected_country = 'JP'").get() as any).cnt;
const bizJp = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE detected_country = 'JP' AND is_business = 1").get() as any).cnt;
const nonBizJp = jpTotal - bizJp;
console.log('\nJP total:', jpTotal, '| business:', bizJp, '| non-business (assignable):', nonBizJp);

// Check campaign-ready JP non-business profiles
const ready = db.prepare(`
  SELECT username, followers_count, scout_tier, is_business
  FROM influencer_master
  WHERE detected_country = 'JP' AND is_business = 0 AND dm_status = 'pending'
  ORDER BY followers_count DESC LIMIT 10
`).all() as any[];
console.log('\nTop 10 JP non-business profiles:');
for (const r of ready) {
  console.log(`  @${r.username} | ${r.followers_count.toLocaleString()} followers | tier:${r.scout_tier}`);
}

db.close();
