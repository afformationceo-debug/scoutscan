import Database from 'better-sqlite3';
import { join } from 'path';
const db = new Database(join('data', 'scraper.db'));

const withGeo = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE detected_country IS NOT NULL AND detected_country != ''").get() as any).cnt;
const jpCount = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE detected_country = 'JP'").get() as any).cnt;
const bizCount = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE is_business = 1").get() as any).cnt;
const withTier = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE scout_tier IS NOT NULL AND scout_tier != ''").get() as any).cnt;
console.log({ total: 475, withGeo, jpCount, bizCount, withTier });

// Sample profiles with geo
const geoProfiles = db.prepare("SELECT username, followers_count, detected_country, scout_tier, is_business, bio FROM influencer_master WHERE detected_country IS NOT NULL AND detected_country != '' ORDER BY followers_count DESC LIMIT 10").all() as any[];
for (const r of geoProfiles) {
  console.log(`${r.username} | ${r.followers_count} | country:${r.detected_country} | tier:${r.scout_tier} | biz:${r.is_business} | ${(r.bio||'').slice(0,50)}`);
}

// Profiles without geo
const noGeo = (db.prepare("SELECT COUNT(*) as cnt FROM influencer_master WHERE detected_country IS NULL OR detected_country = ''").get() as any).cnt;
console.log('\nNo geo:', noGeo);

db.close();
