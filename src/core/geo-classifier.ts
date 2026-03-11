import { franc } from 'franc';
import { ISO639_TO_BCP47, LANG_COUNTRY_MAP } from '../data/lang-country-map.js';
import { CITY_COUNTRY } from '../data/city-country-map.js';
import { COUNTRY_HASHTAGS } from '../data/country-hashtags.js';
import type { InfluencerProfile } from './types.js';

// ─── Types ───

export interface GeoResult {
  country: string;       // ISO 3166-1 alpha-2
  language: string;      // BCP 47
  confidence: number;    // 0.0 ~ 1.0
  source: string;        // most decisive signal
  signals: {
    bioLang?: { lang: string; country: string; score: number };
    captionLang?: { lang: string; country: string; score: number };
    location?: { city: string; country: string; score: number };
    hashtags?: { country: string; score: number };
    namePattern?: { script: string; country: string; score: number };
  };
}

// ─── Traditional Chinese character set (≥100 common chars that differ from simplified) ───

const TRADITIONAL_ONLY_CHARS = new Set([
  // Government / Society
  '國', '際', '經', '濟', '學', '習', '環', '境', '電', '話',
  '車', '輛', '觀', '點', '認', '識', '問', '題', '關', '係',
  '發', '展', '機', '會', '實', '際', '現', '場', '體', '驗',
  '開', '動', '態', '應', '該', '準', '備', '運', '種', '類',
  '區', '域', '組', '織', '設', '計', '處', '理', '報', '導',
  // Daily life / Common
  '買', '賣', '錢', '銀', '飛', '醫', '藥', '飯', '麵', '雞',
  '魚', '鳥', '龍', '風', '雲', '葉', '華', '園', '場', '橋',
  '鐵', '門', '樓', '層', '間', '廳', '廚', '衛', '燈', '窗',
  // Abstract / Emotional
  '愛', '戀', '歡', '樂', '優', '勝', '獎', '勵', '響', '聲',
  '義', '禮', '節', '慶', '歲', '歷', '紀', '錄', '績', '豐',
  // Action / State
  '寫', '讀', '說', '聯', '繫', '選', '擇', '決', '議', '論',
  '辦', '達', '進', '過', '還', '邊', '遠', '後', '覺', '總',
  '滿', '豐', '盡', '盤', '讓', '從', '將', '傳', '統', '帶',
  // Education / Culture
  '書', '圖', '館', '號', '單', '雙', '條', '陽', '陰', '隊',
  '術', '營', '勞', '質', '轉', '變', '換', '獨', '屬', '稱',
  // Nature / Science
  '雜', '亂', '殘', '餘', '塵', '陣', '隨', '眾', '齊', '齡',
  // Additional common traditional characters
  '蘭', '鬥', '廣', '莊', '親', '戲', '腦', '輸', '歸', '齒',
  '雞', '龜', '蠶', '塊', '戰', '斷', '嚴', '蟲', '覆', '構',
  '確', '兒', '氣', '裝', '貓', '產', '衝', '筆', '詞', '創',
  '廢', '紅', '綠', '藍', '紫', '線', '級', '養', '趙', '馬',
  '陳', '張', '劉', '楊', '網', '絡', '維', '護', '範', '圍',
]);

// ─── Sorted city keys for longest-match-first location detection ───

const SORTED_CITY_KEYS = Object.keys(CITY_COUNTRY).sort((a, b) => b.length - a.length);

// ─── Signal weights ───

const WEIGHTS = {
  bioLang: 0.30,
  captionLang: 0.25,
  location: 0.20,
  hashtags: 0.15,
  namePattern: 0.10,
} as const;

// ─── GeoClassifier ───

export class GeoClassifier {
  /**
   * Main entry point: classify an influencer profile into a country.
   * Runs 5 signals and returns the most likely country with confidence.
   */
  classify(profile: InfluencerProfile): GeoResult {
    const signals: GeoResult['signals'] = {};
    const countryScores: Record<string, { total: number; signalContributions: Record<string, number> }> = {};

    const addScore = (country: string, signal: string, weight: number) => {
      if (!countryScores[country]) {
        countryScores[country] = { total: 0, signalContributions: {} };
      }
      countryScores[country].total += weight;
      countryScores[country].signalContributions[signal] =
        (countryScores[country].signalContributions[signal] ?? 0) + weight;
    };

    // Signal 1: Bio language
    const bioLang = this.detectLanguage(profile.bio);
    if (bioLang) {
      signals.bioLang = { lang: bioLang.lang, country: bioLang.country, score: WEIGHTS.bioLang };
      addScore(bioLang.country, 'bioLang', WEIGHTS.bioLang);
    }

    // Signal 2: Caption language (majority vote over up to 5 recent posts)
    const captionLang = this.detectCaptionLanguage(profile.recentPosts);
    if (captionLang) {
      signals.captionLang = { lang: captionLang.lang, country: captionLang.country, score: WEIGHTS.captionLang };
      addScore(captionLang.country, 'captionLang', WEIGHTS.captionLang);
    }

    // Signal 3: Location detection from bio
    const location = this.detectLocation(profile.bio);
    if (location) {
      signals.location = { city: location.city, country: location.country, score: WEIGHTS.location };
      addScore(location.country, 'location', WEIGHTS.location);
    }

    // Signal 4: Hashtag country detection
    const allHashtags = this.collectHashtags(profile);
    const hashtagResult = this.detectHashtagCountry(allHashtags);
    if (hashtagResult) {
      signals.hashtags = { country: hashtagResult.country, score: WEIGHTS.hashtags };
      addScore(hashtagResult.country, 'hashtags', WEIGHTS.hashtags);
    }

    // Signal 5: Name pattern (script detection)
    const namePattern = this.detectNamePattern(profile.fullName, profile.username);
    if (namePattern) {
      signals.namePattern = { script: namePattern.script, country: namePattern.country, score: WEIGHTS.namePattern };
      addScore(namePattern.country, 'namePattern', WEIGHTS.namePattern);
    }

    // Pick country with highest total weighted score
    let bestCountry = 'UNKNOWN';
    let bestScore = 0;
    let bestSource = 'none';

    for (const [country, data] of Object.entries(countryScores)) {
      if (data.total > bestScore) {
        bestScore = data.total;
        bestCountry = country;
      }
    }

    // Determine the most decisive signal for the winning country
    if (bestCountry !== 'UNKNOWN' && countryScores[bestCountry]) {
      const contributions = countryScores[bestCountry].signalContributions;
      let maxContribution = 0;
      for (const [signal, contribution] of Object.entries(contributions)) {
        if (contribution > maxContribution) {
          maxContribution = contribution;
          bestSource = signal;
        }
      }
    }

    // Determine language from the winning signals
    let language = 'und';
    if (signals.bioLang && signals.bioLang.country === bestCountry) {
      language = signals.bioLang.lang;
    } else if (signals.captionLang && signals.captionLang.country === bestCountry) {
      language = signals.captionLang.lang;
    }

    // Apply confidence threshold
    const confidence = Math.min(bestScore, 1.0);
    if (confidence < 0.4) {
      bestCountry = 'UNKNOWN';
    }

    return {
      country: bestCountry,
      language,
      confidence: Math.round(confidence * 100) / 100,
      source: bestSource,
      signals,
    };
  }

  /**
   * Detect language from a text string using franc.
   * Returns BCP 47 language code and default country, or null.
   */
  private detectLanguage(text: string): { lang: string; country: string } | null {
    if (!text || text.length < 10) return null;

    const iso639 = franc(text);
    if (iso639 === 'und') return null;

    let bcp47 = ISO639_TO_BCP47[iso639];
    if (!bcp47) return null;

    // Handle Chinese variant detection
    if (bcp47 === 'zh') {
      const variant = this.classifyChineseVariant(text);
      bcp47 = variant;
    }

    const countries = LANG_COUNTRY_MAP[bcp47];
    if (!countries || countries.length === 0) return null;

    return { lang: bcp47, country: countries[0] };
  }

  /**
   * Classify Chinese text as simplified (zh-Hans) or traditional (zh-Hant).
   * Counts traditional-only characters vs total CJK characters.
   */
  private classifyChineseVariant(text: string): 'zh-Hans' | 'zh-Hant' {
    let cjkCount = 0;
    let traditionalCount = 0;

    for (const char of text) {
      const code = char.codePointAt(0)!;
      // CJK Unified Ideographs: U+4E00 to U+9FFF
      if (code >= 0x4E00 && code <= 0x9FFF) {
        cjkCount++;
        if (TRADITIONAL_ONLY_CHARS.has(char)) {
          traditionalCount++;
        }
      }
    }

    if (cjkCount === 0) return 'zh-Hans';

    const traditionalRatio = traditionalCount / cjkCount;
    return traditionalRatio > 0.30 ? 'zh-Hant' : 'zh-Hans';
  }

  /**
   * Detect location mentions in text by matching against city/country map.
   * Checks longer keys first to avoid partial matches.
   */
  private detectLocation(text: string): { city: string; country: string } | null {
    if (!text) return null;

    const lowerText = text.toLowerCase();

    for (const key of SORTED_CITY_KEYS) {
      if (lowerText.includes(key)) {
        return { city: key, country: CITY_COUNTRY[key] };
      }
    }

    return null;
  }

  /**
   * Detect country from hashtags by counting matches against country hashtag patterns.
   * Returns the country with the most hashtag matches, or null.
   */
  private detectHashtagCountry(hashtags: string[]): { country: string; count: number } | null {
    if (!hashtags || hashtags.length === 0) return null;

    const normalizedTags = hashtags.map(h => h.toLowerCase().replace(/^#/, ''));
    const countryMatchCounts: Record<string, number> = {};

    for (const [country, patterns] of Object.entries(COUNTRY_HASHTAGS)) {
      for (const tag of normalizedTags) {
        if (patterns.includes(tag)) {
          countryMatchCounts[country] = (countryMatchCounts[country] ?? 0) + 1;
        }
      }
    }

    let bestCountry: string | null = null;
    let bestCount = 0;

    for (const [country, count] of Object.entries(countryMatchCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestCountry = country;
      }
    }

    if (!bestCountry) return null;
    return { country: bestCountry, count: bestCount };
  }

  /**
   * Detect script pattern in full name and username.
   * Checks if majority of non-ASCII characters belong to a specific script.
   */
  private detectNamePattern(fullName: string, username: string): { script: string; country: string } | null {
    const text = `${fullName ?? ''} ${username ?? ''}`;
    if (!text.trim()) return null;

    const scriptCounts: Record<string, number> = {};
    let nonAsciiCount = 0;

    for (const char of text) {
      const code = char.codePointAt(0)!;

      if (code <= 0x7F) continue; // Skip ASCII

      nonAsciiCount++;

      // Hangul Syllables (U+AC00-U+D7AF) + Hangul Jamo (U+1100-U+11FF)
      if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) {
        scriptCounts['hangul'] = (scriptCounts['hangul'] ?? 0) + 1;
      }
      // Katakana (U+30A0-U+30FF)
      else if (code >= 0x30A0 && code <= 0x30FF) {
        scriptCounts['kana'] = (scriptCounts['kana'] ?? 0) + 1;
      }
      // Hiragana (U+3040-U+309F)
      else if (code >= 0x3040 && code <= 0x309F) {
        scriptCounts['kana'] = (scriptCounts['kana'] ?? 0) + 1;
      }
      // Thai (U+0E00-U+0E7F)
      else if (code >= 0x0E00 && code <= 0x0E7F) {
        scriptCounts['thai'] = (scriptCounts['thai'] ?? 0) + 1;
      }
      // Arabic (U+0600-U+06FF)
      else if (code >= 0x0600 && code <= 0x06FF) {
        scriptCounts['arabic'] = (scriptCounts['arabic'] ?? 0) + 1;
      }
      // Devanagari (U+0900-U+097F)
      else if (code >= 0x0900 && code <= 0x097F) {
        scriptCounts['devanagari'] = (scriptCounts['devanagari'] ?? 0) + 1;
      }
      // Cyrillic (U+0400-U+04FF)
      else if (code >= 0x0400 && code <= 0x04FF) {
        scriptCounts['cyrillic'] = (scriptCounts['cyrillic'] ?? 0) + 1;
      }
    }

    if (nonAsciiCount === 0) return null;

    // Find the dominant script
    let bestScript: string | null = null;
    let bestCount = 0;

    for (const [script, count] of Object.entries(scriptCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestScript = script;
      }
    }

    // Require majority of non-ASCII characters to be in one script
    if (!bestScript || bestCount < nonAsciiCount * 0.5) return null;

    const scriptCountryMap: Record<string, string> = {
      'hangul': 'KR',
      'kana': 'JP',
      'thai': 'TH',
      'arabic': 'SA',
      'devanagari': 'IN',
      'cyrillic': 'RU',
    };

    const country = scriptCountryMap[bestScript];
    if (!country) return null;

    return { script: bestScript, country };
  }

  /**
   * Detect caption language using majority vote over up to 5 recent posts.
   */
  private detectCaptionLanguage(recentPosts?: { caption: string }[]): { lang: string; country: string } | null {
    if (!recentPosts || recentPosts.length === 0) return null;

    const postsToCheck = recentPosts.slice(0, 5);
    const langVotes: Record<string, { lang: string; country: string; count: number }> = {};

    for (const post of postsToCheck) {
      const result = this.detectLanguage(post.caption);
      if (result) {
        const key = `${result.lang}:${result.country}`;
        if (!langVotes[key]) {
          langVotes[key] = { lang: result.lang, country: result.country, count: 0 };
        }
        langVotes[key].count++;
      }
    }

    let best: { lang: string; country: string; count: number } | null = null;
    for (const vote of Object.values(langVotes)) {
      if (!best || vote.count > best.count) {
        best = vote;
      }
    }

    if (!best) return null;
    return { lang: best.lang, country: best.country };
  }

  /**
   * Collect all hashtags from profile's recent posts.
   */
  private collectHashtags(profile: InfluencerProfile): string[] {
    const hashtags: string[] = [];

    if (profile.recentPosts) {
      for (const post of profile.recentPosts) {
        if (post.hashtags) {
          hashtags.push(...post.hashtags);
        }
      }
    }

    return hashtags;
  }
}
