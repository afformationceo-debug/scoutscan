import Database from 'better-sqlite3';
import { join } from 'path';
const db = new Database(join('data', 'scraper.db'));

// Check what kind of "business" profiles we have
const bizProfiles = db.prepare(`
  SELECT username, followers_count, bio, category, is_business
  FROM influencer_master
  WHERE detected_country = 'JP'
  ORDER BY followers_count DESC LIMIT 30
`).all() as any[];

console.log('JP profiles - checking for real businesses vs influencers:\n');
for (const r of bizProfiles) {
  const bio = (r.bio || '').replace(/\n/g, ' ').slice(0, 80);
  console.log(`@${r.username} | ${r.followers_count} | biz:${r.is_business} | cat:${r.category || '-'} | ${bio}`);
}

db.close();
