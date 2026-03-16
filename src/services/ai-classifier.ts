import OpenAI from 'openai';
import { db } from '../web/services/db.js';
import pLimit from 'p-limit';

// ─── Types ───

export interface AIClassificationResult {
  username: string;
  isInfluencer: boolean;
  country: string;       // ISO 3166-1 alpha-2 (e.g. "JP", "KR", "US")
  confidence: number;    // 0.0 ~ 1.0
  reason: string;        // Short explanation
}

interface ProfileForAI {
  influencer_key: string;
  platform: string;
  username: string;
  full_name: string | null;
  bio: string | null;
  category: string | null;
  is_business: number;
  followers_count: number;
  external_url: string | null;
  contact_email: string | null;
  captions: string[];    // Recent post captions
}

// ─── AI Classifier Service ───

export class AIClassifier {
  private openai: OpenAI;
  private model = 'gpt-4o-mini';

  constructor(apiKey?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OpenAI API key required');
    this.openai = new OpenAI({ apiKey: key });
  }

  /**
   * Classify all unclassified profiles (or re-classify all).
   * Returns count of profiles classified.
   */
  async classifyAll(opts: { reClassify?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
    const condition = opts.reClassify
      ? '1=1'
      : `(ai_classified_at IS NULL OR ai_classified_at = '')`;

    const profiles = this.loadProfiles(condition);
    if (profiles.length === 0) return 0;

    const BATCH_SIZE = 10;
    const batches: ProfileForAI[][] = [];
    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      batches.push(profiles.slice(i, i + BATCH_SIZE));
    }

    let classified = 0;
    const limit = pLimit(3); // 3 concurrent API calls

    const tasks = batches.map((batch, idx) =>
      limit(async () => {
        try {
          const results = await this.classifyBatch(batch);
          this.saveResults(results, batch);
          classified += results.length;
          opts.onProgress?.(classified, profiles.length);
        } catch (err) {
          console.warn(`[AIClassifier] Batch ${idx} failed:`, (err as Error).message);
        }
      })
    );

    await Promise.allSettled(tasks);
    return classified;
  }

  /**
   * Classify profiles for a specific platform.
   */
  async classifyByPlatform(platform: string, opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
    const profiles = this.loadProfiles(
      `(ai_classified_at IS NULL OR ai_classified_at = '') AND platform = '${platform}'`
    );
    if (profiles.length === 0) return 0;

    const BATCH_SIZE = 10;
    let classified = 0;

    for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
      const batch = profiles.slice(i, i + BATCH_SIZE);
      try {
        const results = await this.classifyBatch(batch);
        this.saveResults(results, batch);
        classified += results.length;
        opts.onProgress?.(classified, profiles.length);
      } catch (err) {
        console.warn(`[AIClassifier] Batch failed:`, (err as Error).message);
      }
    }

    return classified;
  }

  /**
   * Load profiles from DB with their recent captions.
   */
  private loadProfiles(whereCondition: string): ProfileForAI[] {
    const rows = db.prepare(`
      SELECT influencer_key, platform, username, full_name, bio, category, is_business, followers_count, external_url, contact_email
      FROM influencer_master
      WHERE ${whereCondition}
      ORDER BY followers_count DESC
    `).all() as any[];

    return rows.map(row => {
      // Get up to 5 recent captions for this user
      const captionRows = db.prepare(`
        SELECT caption FROM posts
        WHERE owner_username = ? AND platform = ? AND caption IS NOT NULL AND caption != ''
        ORDER BY likes_count DESC
        LIMIT 5
      `).all(row.username, row.platform) as any[];

      return {
        ...row,
        captions: captionRows.map(c => c.caption),
      };
    });
  }

  /**
   * Send a batch of profiles to OpenAI for classification.
   */
  private async classifyBatch(profiles: ProfileForAI[]): Promise<AIClassificationResult[]> {
    const profileDescriptions = profiles.map((p, i) => {
      const captionText = p.captions.length > 0
        ? p.captions.map(c => c.slice(0, 200)).join('\n---\n')
        : '(no captions available)';

      return `[Profile ${i + 1}]
Username: @${p.username}
Name: ${p.full_name || '(none)'}
Bio: ${(p.bio || '(none)').slice(0, 300)}
Bio Link: ${p.external_url || '(none)'}
Email: ${p.contact_email || '(none)'}
Category: ${p.category || '(none)'}
Followers: ${p.followers_count.toLocaleString()}
Recent Captions:
${captionText}`;
    }).join('\n\n========\n\n');

    const systemPrompt = `You are an expert social media analyst. For each Instagram/social media profile, determine:
1. Is this a real INFLUENCER (content creator, blogger, model, etc.) or a BUSINESS (clinic, agency, brand, shop, media company, hospital, etc.)?
2. What country is this person ACTUALLY FROM or BASED IN?

CRITICAL — Country Detection Rules:
- Determine the person's REAL nationality/residence, NOT the topic they post about.
- Someone posting about Korean beauty/travel but writing in Traditional Chinese with locations like 台中, 台北, 高雄 → they are from TAIWAN (TW), not Korea.
- Someone posting about Korea in Japanese → they are from JAPAN (JP), not Korea.
- Bio links to .tw domains, LINE IDs, Taiwan phone numbers → TW
- Bio links to .jp domains, Japanese LINE → JP
- Bio mentions cities: 台中/台北/高雄/新竹 → TW, 東京/大阪/名古屋 → JP, Seoul/서울/강남 → KR, Singapore → SG, KL/Kuala Lumpur → MY, 香港 → HK
- Traditional Chinese (繁體) text → likely TW or HK. Check for Taiwan-specific terms (如：台灣、台中、高雄、捷運) vs HK terms (港、銅鑼灣、MTR)
- Simplified Chinese → likely CN or SG/MY
- English bio with Asian appearance + Singapore/Malaysia mentions → SG or MY
- Korean text + Korean city names → KR
- Japanese text → JP
- The hashtag they were found through (e.g. #韓國醫美) does NOT determine their country — it only means they're interested in that topic.

Influencer vs Business Rules:
- Individual content creators, bloggers, models, lifestyle accounts = INFLUENCER (is_influencer: true)
- Clinics, hospitals, dermatology offices, beauty salons, brand official accounts, agencies, media companies, 代理 (agents), 醫院, 皮膚科 = BUSINESS (is_influencer: false)
- Individual influencers who use business accounts are still INFLUENCERS

- Confidence 0.0-1.0. Use "UNKNOWN" if truly unclear.
- IMPORTANT: "reason" MUST be in Korean (한국어).

Return ONLY a JSON array with exactly one object per profile, in order:
[
  {"username": "...", "is_influencer": true/false, "country": "XX", "confidence": 0.0-1.0, "reason": "한국어로 분류 사유 작성"}
]`;

    const response = await this.openai.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: profileDescriptions },
      ],
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty OpenAI response');

    const parsed = JSON.parse(content);
    // Handle both array and { results: [...] } formats
    const results: any[] = Array.isArray(parsed) ? parsed : (parsed.results || parsed.profiles || Object.values(parsed)[0]);

    if (!Array.isArray(results)) {
      throw new Error('Unexpected response format from OpenAI');
    }

    return results.map((r: any, i: number) => ({
      username: r.username || profiles[i]?.username || '',
      isInfluencer: !!r.is_influencer,
      country: (r.country || 'UNKNOWN').toUpperCase(),
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
      reason: r.reason || '',
    }));
  }

  /**
   * Save classification results back to DB.
   */
  private saveResults(results: AIClassificationResult[], profiles: ProfileForAI[]): void {
    const now = new Date().toISOString();
    const updateStmt = db.prepare(`
      UPDATE influencer_master SET
        ai_is_influencer = ?,
        ai_country = ?,
        ai_confidence = ?,
        ai_reason = ?,
        ai_classified_at = ?,
        detected_country = CASE WHEN ? != 'UNKNOWN' THEN ? ELSE detected_country END,
        geo_confidence = CASE WHEN ? != 'UNKNOWN' AND ? > COALESCE(geo_confidence, 0) THEN ? ELSE geo_confidence END,
        geo_source = CASE WHEN ? != 'UNKNOWN' AND ? > COALESCE(geo_confidence, 0) THEN 'ai_openai' ELSE geo_source END,
        last_updated_at = ?
      WHERE influencer_key = ?
    `);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const profile = profiles.find(p => p.username === r.username) || profiles[i];
      if (!profile) continue;

      updateStmt.run(
        r.isInfluencer ? 1 : 0,
        r.country,
        r.confidence,
        r.reason,
        now,
        // Update detected_country if AI has a result
        r.country, r.country,
        // Update geo_confidence if AI confidence is higher
        r.country, r.confidence, r.confidence,
        // Update geo_source
        r.country, r.confidence,
        now,
        profile.influencer_key
      );
    }
  }

  /**
   * Auto-assign classified influencers to matching campaigns.
   * Returns number of newly assigned profiles.
   */
  autoAssignToCampaigns(): number {
    // Get active/draft campaigns
    const campaigns = db.prepare(
      `SELECT * FROM dm_campaigns WHERE status IN ('draft', 'active', 'paused')`
    ).all() as any[];

    let totalAssigned = 0;

    for (const campaign of campaigns) {
      const conditions: string[] = [
        `ai_is_influencer = 1`,       // AI confirmed influencer
        `dm_status = 'pending'`,       // Not yet contacted
      ];
      const params: any[] = [];

      if (campaign.platform) {
        conditions.push('platform = ?');
        params.push(campaign.platform);
      }
      if (campaign.target_country) {
        conditions.push('UPPER(COALESCE(ai_country, detected_country)) = UPPER(?)');
        params.push(campaign.target_country);
      }
      if (campaign.target_tiers) {
        try {
          const tiers = JSON.parse(campaign.target_tiers);
          if (tiers.length > 0) {
            conditions.push(`scout_tier IN (${tiers.map(() => '?').join(',')})`);
            params.push(...tiers);
          }
        } catch { /* ignore */ }
      }
      if (campaign.min_followers) {
        conditions.push('followers_count >= ?');
        params.push(campaign.min_followers);
      }
      if (campaign.max_followers) {
        conditions.push('followers_count <= ?');
        params.push(campaign.max_followers);
      }

      // Exclude already queued
      conditions.push('influencer_key NOT IN (SELECT influencer_key FROM dm_action_queue WHERE campaign_id = ?)');
      params.push(campaign.id);

      const where = `WHERE ${conditions.join(' AND ')}`;
      const candidates = db.prepare(
        `SELECT * FROM influencer_master ${where} ORDER BY followers_count DESC LIMIT 1000`
      ).all(...params) as any[];

      if (candidates.length === 0) continue;

      const now = new Date().toISOString();
      const insertStmt = db.prepare(`
        INSERT INTO dm_action_queue (influencer_key, campaign_id, platform, message_rendered, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const updateCampaignIdStmt = db.prepare(
        `UPDATE influencer_master SET dm_campaign_id = ? WHERE influencer_key = ? AND (dm_campaign_id IS NULL OR dm_campaign_id = '')`
      );

      for (const inf of candidates) {
        const message = this.renderTemplate(campaign.message_template, inf);
        insertStmt.run(inf.influencer_key, campaign.id, inf.platform, message, now);
        updateCampaignIdStmt.run(campaign.id, inf.influencer_key);
        totalAssigned++;
      }

      db.prepare('UPDATE dm_campaigns SET total_queued = total_queued + ?, updated_at = ? WHERE id = ?')
        .run(candidates.length, now, campaign.id);

      console.log(`[AIClassifier] Assigned ${candidates.length} influencers to campaign "${campaign.name}"`);
    }

    return totalAssigned;
  }

  private renderTemplate(template: string, influencer: any): string {
    return template
      .replace(/\{\{username\}\}/g, influencer.username || '')
      .replace(/\{\{full_name\}\}/g, influencer.full_name || influencer.username || '')
      .replace(/\{\{followers_count\}\}/g, this.formatNumber(influencer.followers_count || 0))
      .replace(/\{\{platform\}\}/g, influencer.platform || '');
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
}
