# Global Scraper Platform Upgrade - Design Spec

## Overview

현재 키워드 기반 소셜 미디어 스크래핑 시스템을 글로벌 인플루언서 관리 플랫폼으로 확장합니다.

**핵심 흐름:**
```
국가x키워드 설정 → 콘텐츠 스크래핑 → 프로필 enrichment → NLP 국가 판별 → 마스터 DB → DM 발송
```

**아키텍처**: 모놀리식 확장 (Hono + SQLite + 단일 프로세스)
**배포**: 로컬 우선, 추후 VPS 이전 (pm2)

---

## Section 1: 스크래핑 엔진 속도 최적화

### 1.1 현재 병목

| 병목 | 현재 | 목표 |
|------|------|------|
| 프로필당 소요 시간 | 8-15초 (브라우저 재시작) | 1-3초 (컨텍스트 풀링) |
| 동시 처리 | 1건 (순차) | 3건 병렬 |
| API 사용 순서 | 브라우저 3회 → API 폴백 | API 우선 → 브라우저 폴백 |
| 228명 enrichment | ~30분 | ~5분 |

### 1.2 브라우저 컨텍스트 풀

`StealthBrowser`를 수정하여 프로필 scraping 시 브라우저 프로세스를 재사용합니다.

```
현재: launch() → context → page → closeAll() → launch() → ...
개선: launch(1회) → context1 → page → closeContext() → context2 → page → closeContext() → ...
```

- 브라우저 프로세스는 enrichment 세션 동안 1개만 유지
- 각 프로필마다 새로운 `BrowserContext` 생성 (독립된 fingerprint/쿠키)
- `closeContext(sessionId)`만 호출, `closeAll()`은 전체 enrichment 완료 시에만

**필수 코드 변경:** `getProfileOnce()` 메서드에서 `this.browser.closeAll()` (scraper.ts:332) 호출을 **제거**하고 `closeContext(sessionId)`만 호출하도록 수정. `closeAll()`은 enrichment 세션의 `finally` 블록에서만 호출.

**스코프 명시:** `InstagramScraper`는 per-job 인스턴스를 유지. 컨텍스트 풀링은 단일 enrichment 세션(=단일 job) 내에서만 적용. 프로세스 레벨 싱글톤으로 변경하지 않음.

### 1.3 API 우선 모드 (Fast Path)

**배경:** 현재 코드가 브라우저 우선인 이유는 Instagram의 비인증 API 엔드포인트가 서버 환경에서 차단될 수 있기 때문. 그러나 **쿠키 인증된 API 호출**은 성공률이 높음.

프로필 수집 순서를 역전합니다:

```
1차: Instagram GraphQL API (쿠키 기반, ~200ms/건)
     → initSession()으로 CSRF 토큰 + 쿠키 설정
     → 성공 시 바로 저장
2차: 브라우저 fallback (API 실패 시만, ~3초/건)
     → 컨텍스트 풀 사용
```

- 기존 `InstagramAPI.getProfile()` 메서드를 우선 호출 (신규 메서드 불필요)
- HTTP 429/401/차단 시 `StealthBrowser` 폴백
- API 경로는 `RateLimiter` 통과 (10req/min, 150req/hr)
- **구현 시 첫 10건으로 API 성공률 측정**: 성공률 < 50%면 자동으로 브라우저 우선 모드로 전환

### 1.4 병렬 enrichment (Concurrency 3)

`pLimit` 라이브러리로 동시 3건 처리:

```typescript
import pLimit from 'p-limit';
const limit = pLimit(3);

const tasks = usernames.map(username =>
  limit(() => enrichProfile(username))
);
await Promise.allSettled(tasks);
```

- 각 워커는 독립된 프록시/fingerprint 사용
- **전제 조건:** `getProfileOnce()`에서 `closeAll()` 제거 완료 (Section 1.2). 미완료 시 Worker A의 `closeAll()`이 Worker B/C의 브라우저를 파괴하여 크래시 발생.
- 5건 연속 실패 시 전체 일시 정지 30초 (기존 로직 유지)
- SSE 이벤트는 메인 스레드에서 안전하게 전송 (순서 보장)

**Phase 1 출력 대상:** 최적화 테스트 동안 enrichment 결과는 기존 `profiles` 테이블에 저장. `influencer_master` 연동은 Phase 2 완료 후.

---

## Section 2: 글로벌 마스터 DB 3계층 스키마

### 2.1 기존 테이블 유지

`jobs`, `posts`, `profiles` 테이블은 그대로 유지합니다 (raw 스크래핑 기록).

### 2.2 신규 Table 1: `keyword_targets` (수집 지휘소)

```sql
CREATE TABLE keyword_targets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id               TEXT NOT NULL UNIQUE,    -- 'INSTA_TW', 'TIKTOK_US'
  platform              TEXT NOT NULL,           -- 'instagram' | 'tiktok' | ...
  region                TEXT NOT NULL,           -- ISO 3166-1: 'TW', 'US', 'CN', 'KR', 'VN'
  keyword               TEXT NOT NULL,           -- '#KoreanSkincare', '#한국화장품'
  scraping_cycle_hours  INTEGER DEFAULT 72,      -- 키워드별 독립 스케줄
  last_post_timestamp   TEXT,                    -- 가장 최근 수집 게시글 timestamp (델타 기준)
  last_scraped_at       TEXT,                    -- 마지막 실행 시각
  next_scrape_at        TEXT,                    -- 다음 예정 시각 (UI 표시용)
  total_extracted       INTEGER DEFAULT 0,       -- 총 추출 인플루언서 수
  max_results_per_run   INTEGER DEFAULT 200,     -- 1회 실행 시 최대 수집 게시물 수
  is_active             INTEGER DEFAULT 1,       -- 0이면 스케줄러가 무시
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_kt_platform ON keyword_targets(platform);
CREATE INDEX idx_kt_next ON keyword_targets(next_scrape_at);
```

### 2.3 신규 Table 2: `influencer_master` (핵심 자산 금고)

```sql
CREATE TABLE influencer_master (
  influencer_key    TEXT PRIMARY KEY,       -- 'instagram:username'
  platform          TEXT NOT NULL,
  username          TEXT NOT NULL,
  full_name         TEXT,
  bio               TEXT,
  profile_pic_url   TEXT,
  followers_count   INTEGER DEFAULT 0,
  following_count   INTEGER DEFAULT 0,
  posts_count       INTEGER DEFAULT 0,
  engagement_rate   REAL,
  is_verified       INTEGER DEFAULT 0,
  is_business       INTEGER DEFAULT 0,
  is_private        INTEGER DEFAULT 0,
  category          TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  external_url      TEXT,
  -- Geo-Mapping
  detected_country  TEXT,                   -- ISO 3166-1 alpha-2: 'TW', 'US', 'KR'
  detected_language TEXT,                   -- BCP 47: 'zh-Hant', 'en', 'ko'
  geo_confidence    REAL DEFAULT 0,         -- 0.0 ~ 1.0
  geo_source        TEXT,                   -- 'bio_lang', 'caption_lang', 'location', 'manual'
  -- Scout Tier
  scout_tier        TEXT DEFAULT 'C',       -- 최종 적용 등급 (manual 우선)
  scout_tier_auto   TEXT DEFAULT 'C',       -- 자동 계산: followers + engagement 기반
  scout_tier_manual TEXT,                   -- NULL이면 auto 사용, 값 있으면 오버라이드
  -- DM Status
  dm_status         TEXT DEFAULT 'pending', -- pending/sent/replied/completed/blacklist
  dm_last_sent_at   TEXT,
  dm_campaign_id    TEXT,
  -- Meta
  source_pair_ids   TEXT,                   -- JSON array: ['INSTA_TW', 'INSTA_US']
  first_seen_at     TEXT NOT NULL,
  last_updated_at   TEXT NOT NULL,
  UNIQUE(platform, username)
);
CREATE INDEX idx_im_platform ON influencer_master(platform);
CREATE INDEX idx_im_country ON influencer_master(detected_country);
CREATE INDEX idx_im_tier ON influencer_master(scout_tier);
CREATE INDEX idx_im_dm ON influencer_master(dm_status);
```

**Scout Tier 자동 계산 기준:**

| Tier | 조건 |
|------|------|
| S | followers >= 100,000 AND engagement_rate >= 3.0 |
| A | followers >= 10,000 AND engagement_rate >= 2.0 |
| B | followers >= 1,000 AND engagement_rate >= 1.0 |
| C | 나머지 |

`scout_tier = scout_tier_manual ?? scout_tier_auto`

**등급 판정 우선순위 (상위 조건부터 평가, 첫 매칭 시 중단):**
```sql
CASE
  WHEN followers_count >= 100000 AND engagement_rate >= 3.0 THEN 'S'
  WHEN followers_count >= 10000  AND engagement_rate >= 2.0 THEN 'A'
  WHEN followers_count >= 1000   AND engagement_rate >= 1.0 THEN 'B'
  ELSE 'C'
END
```

### 2.3.1 `influencer_master` UPSERT 정책

프로필 enrichment 완료 시 `influencer_master`에 UPSERT합니다.

**필드별 병합 정책:**

| 분류 | 필드 | 정책 |
|------|------|------|
| 항상 최신값 덮어쓰기 | followers_count, following_count, posts_count, engagement_rate, bio, full_name, profile_pic_url, is_verified, is_business, is_private, category, contact_email, contact_phone, external_url | 최신 스크래핑 데이터로 갱신 |
| 수동 오버라이드 보존 | scout_tier_manual, detected_country (geo_source='manual'), dm_status | NULL이 아닌 기존 manual 값 유지 |
| 누적/병합 | source_pair_ids | JSON array에 새 pair_id append + 중복 제거 |
| 자동 재계산 | scout_tier_auto, scout_tier, detected_country (auto), geo_confidence | 데이터 갱신 시 자동 재계산 |
| 최초값 유지 | first_seen_at | INSERT 시에만 설정, UPDATE 시 변경 안 함 |

**UPSERT SQL 핵심:**
```sql
INSERT INTO influencer_master (...) VALUES (...)
ON CONFLICT(platform, username) DO UPDATE SET
  followers_count = excluded.followers_count,
  -- ... (항상 덮어쓰기 필드들)
  source_pair_ids = json_group_array_merge(
    influencer_master.source_pair_ids, excluded.source_pair_ids
  ),
  scout_tier_manual = COALESCE(influencer_master.scout_tier_manual, excluded.scout_tier_manual),
  detected_country = CASE
    WHEN influencer_master.geo_source = 'manual' THEN influencer_master.detected_country
    ELSE excluded.detected_country
  END,
  last_updated_at = excluded.last_updated_at
```

`json_group_array_merge`는 커스텀 SQLite 함수로 구현 (두 JSON array 합산 + DISTINCT).

### 2.4 신규 Table 3: `dm_campaigns` (캠페인 관리)

```sql
CREATE TABLE dm_campaigns (
  id                TEXT PRIMARY KEY,         -- UUID
  name              TEXT NOT NULL,
  brand             TEXT,
  platform          TEXT NOT NULL,
  target_country    TEXT,                     -- 'TW', 'US', 'ALL'
  target_tiers      TEXT,                     -- JSON array: ['S', 'A']
  min_followers     INTEGER,
  max_followers     INTEGER,
  message_template  TEXT NOT NULL,            -- 템플릿 본문 ({{변수}} 포함)
  daily_limit       INTEGER DEFAULT 40,       -- 계정당 일일 발송 한도
  max_retries       INTEGER DEFAULT 2,        -- 항목별 최대 재시도 횟수
  delay_min_sec     INTEGER DEFAULT 45,       -- 발송 간 최소 딜레이 (초)
  delay_max_sec     INTEGER DEFAULT 120,      -- 발송 간 최대 딜레이 (초)
  status            TEXT DEFAULT 'draft',     -- draft/active/paused/completed
  total_queued      INTEGER DEFAULT 0,
  total_sent        INTEGER DEFAULT 0,
  total_failed      INTEGER DEFAULT 0,
  total_replied     INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

### 2.5 신규 Table 4: `dm_action_queue` (발송 작업대)

```sql
CREATE TABLE dm_action_queue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  influencer_key    TEXT NOT NULL REFERENCES influencer_master(influencer_key),
  campaign_id       TEXT NOT NULL REFERENCES dm_campaigns(id),
  platform          TEXT NOT NULL,
  account_username  TEXT,                     -- 발송에 사용된 계정
  message_rendered  TEXT NOT NULL,            -- 변수 치환 완료된 최종 메시지
  execute_status    TEXT DEFAULT 'pending',   -- pending/processing/success/failed/skipped
  error_message     TEXT,
  scheduled_at      TEXT,                     -- 예약 발송 시각
  executed_at       TEXT,                     -- 실제 발송 시각
  retry_count       INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_dmq_status ON dm_action_queue(execute_status);
CREATE INDEX idx_dmq_campaign ON dm_action_queue(campaign_id);
```

### 2.6 신규 Table 5: `dm_accounts` (발송 계정 관리)

```sql
CREATE TABLE dm_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL,
  username        TEXT NOT NULL,
  session_file    TEXT,                       -- 세션 파일 경로
  daily_sent      INTEGER DEFAULT 0,         -- 오늘 발송 건수
  daily_limit     INTEGER DEFAULT 40,        -- 일일 리밋
  last_sent_at    TEXT,
  last_reset_date TEXT,                       -- daily_sent 리셋 날짜
  status          TEXT DEFAULT 'active',      -- active/paused/blocked
  created_at      TEXT NOT NULL,
  UNIQUE(platform, username)
);
```

### 2.7 데이터 흐름

```
keyword_targets (수집 지휘소)
    │
    ├─── Cron 스케줄러가 주기적으로 확인
    │
    ▼
jobs → posts (기존 스크래핑)
    │
    ├─── Phase 2: Profile Enrichment
    │
    ▼
profiles (raw, job별)
    │
    ├─── UPSERT to influencer_master
    ├─── GeoClassifier: 국가/언어 판별
    ├─── ScoutTier: 자동 등급 계산
    │
    ▼
influencer_master (최종 통합 뷰)
    │
    ├─── 캠페인 생성 → 타겟 추출 → dm_action_queue 생성
    │
    ▼
dm_campaigns + dm_action_queue
    │
    ├─── DMEngine: dm_accounts 로테이션으로 발송
    │
    ▼
상태 동기화: influencer_master.dm_status 업데이트
```

---

## Section 3: NLP 국가 판별 (GeoClassifier)

### 3.1 Multi-Signal 접근

5개 시그널의 가중 합산으로 국가를 판별합니다.

| # | 시그널 | 가중치 | 데이터 소스 | 방법 |
|---|--------|--------|------------|------|
| 1 | 바이오 언어 | 0.30 | profile.bio | franc → ISO 639-3 → 국가 매핑 |
| 2 | 캡션 언어 | 0.25 | posts.caption (최근 5개) | franc → 다수결 투표 |
| 3 | 위치 정보 | 0.20 | bio 텍스트 내 도시/국가명 | 도시 DB (5000+ 항목) + 정규식 |
| 4 | 해시태그 | 0.15 | posts.hashtags | 국가별 특유 해시태그 사전 |
| 5 | 이름 패턴 | 0.10 | profile.fullName, username | 문자 체계 분석 (한글, 한자, 카나 등) |

### 3.2 언어 → 국가 매핑

**2단계 변환:** `franc` (ISO 639-3) → BCP 47 → 국가 (ISO 3166-1)

```typescript
// Step 1: franc 출력(ISO 639-3) → BCP 47 변환
const ISO639_TO_BCP47: Record<string, string> = {
  'kor': 'ko', 'jpn': 'ja', 'vie': 'vi', 'tha': 'th',
  'ind': 'id', 'msa': 'ms', 'cmn': 'zh',  // zh는 3.3에서 Hans/Hant 세분화
  'eng': 'en', 'spa': 'es', 'por': 'pt',
  'fra': 'fr', 'deu': 'de', 'ita': 'it',
  'rus': 'ru', 'ara': 'ar', 'hin': 'hi',
  'tur': 'tr', 'pol': 'pl', 'nld': 'nl',
};

// Step 2: BCP 47 → 국가 매핑 (1:N)
const LANG_COUNTRY_MAP: Record<string, string[]> = {
  'ko': ['KR'],
  'ja': ['JP'],
  'vi': ['VN'],
  'th': ['TH'],
  'id': ['ID'],
  'ms': ['MY'],
  'zh-Hans': ['CN'],             // 간체 → 중국
  'zh-Hant': ['TW', 'HK'],      // 번체 → 대만/홍콩 (위치 정보로 2차 판별)
  'en': ['US', 'GB', 'AU'],     // 위치 정보로 2차 판별
  'es': ['ES', 'MX'],
  'pt': ['BR', 'PT'],
  'fr': ['FR'],
  'de': ['DE'],
};
```

1:1 매핑 언어(ko→KR, ja→JP 등)는 바로 국가 확정.
1:N 매핑 언어(en, zh-Hant, es 등)는 위치 정보(Section 3.5) 시그널로 2차 판별.

### 3.3 간체/번체 구분

`franc`은 `cmn`만 반환하므로 Unicode 범위 분석으로 직접 판별:

```typescript
function classifyChineseVariant(text: string): 'zh-Hans' | 'zh-Hant' {
  // CJK Unified Ideographs 범위에서 번체 전용 글자 비율 계산
  // 번체 비율 > 30% → zh-Hant (TW/HK)
  // 그 외 → zh-Hans (CN)
}
```

- `zh-Hant` → 1차 추정 TW, HK는 위치 정보로 2차 판별
- `zh-Hans` → CN

### 3.4 다중 언어 처리

한 프로필에 여러 언어가 섞일 경우:
- 바이오/캡션 각각에서 franc 실행
- 가장 높은 confidence의 언어 채택
- 여러 언어가 동등하면 위치 정보/해시태그로 결정

### 3.5 도시/국가 사전

약 5000개 도시/국가명을 포함하는 정적 매핑 파일:

```typescript
const CITY_COUNTRY: Record<string, string> = {
  'taipei': 'TW', '台北': 'TW', '台灣': 'TW',
  'seoul': 'KR', '서울': 'KR', '한국': 'KR',
  'tokyo': 'JP', '東京': 'JP',
  'bangkok': 'TH', 'ho chi minh': 'VN',
  'jakarta': 'ID', 'kuala lumpur': 'MY',
  // ... 5000+ entries
};
```

### 3.6 GeoClassifier 인터페이스

```typescript
interface GeoResult {
  country: string;      // ISO 3166-1 alpha-2 ('TW', 'US', 'KR', ...)
  language: string;     // BCP 47 ('zh-Hant', 'en', 'ko', ...)
  confidence: number;   // 0.0 ~ 1.0
  source: string;       // 가장 결정적이었던 시그널
  signals: {            // 각 시그널별 판별 결과
    bioLang?: { lang: string; country: string; score: number };
    captionLang?: { lang: string; country: string; score: number };
    location?: { city: string; country: string; score: number };
    hashtags?: { country: string; score: number };
    namePattern?: { script: string; country: string; score: number };
  };
}
```

- confidence < 0.4 → `detected_country = 'UNKNOWN'`
- 웹 UI에서 수동 오버라이드 가능 (`geo_source = 'manual'`)

---

## Section 4: 델타 스크래핑 + Cron 스케줄러

### 4.1 SchedulerService

```typescript
class SchedulerService {
  // Cron Job 1: 매 시간 정각에 스크래핑 스케줄 확인
  //   → keyword_targets WHERE next_scrape_at <= NOW AND is_active = 1
  // Cron Job 2: 매일 자정에 DM 발송 계정 일일 카운터 리셋
  //   → UPDATE dm_accounts SET daily_sent = 0, last_reset_date = today

  start(): void;      // cron 시작 (스크래핑 + 리셋 모두)
  stop(): void;       // cron 정지
  runNow(pairId: string): void;  // 특정 키워드 즉시 실행

  private async checkSchedule(): Promise<void>;
  private async runScheduledJob(target: KeywordTarget): Promise<void>;
  private async resetDailyLimits(): Promise<void>;  // dm_accounts.daily_sent = 0
}
```

**dm_accounts 일일 카운터 리셋 방식:**
- 자정 cron으로 일괄 리셋 (`daily_sent = 0, last_reset_date = today`)
- 추가 안전장치: DMEngine에서 발송 시 `last_reset_date !== today`이면 lazy 리셋

### 4.2 델타 스크래핑 로직

`SearchOptions`에 `since` 파라미터 추가:

```typescript
interface SearchOptions {
  maxResults?: number;
  since?: string;  // ISO timestamp
}
```

스크래핑 중 `post.timestamp < since`인 게시물은 수집 대상에서 제외합니다.

**주의: Instagram 해시태그 피드는 "top posts" + "recent posts"가 혼합 정렬됩니다.**
따라서 단순히 첫 `since` 이전 게시물 발견 시 중단하면 최신 게시물을 놓칠 수 있습니다.

**구현 방식:** 전체 수집 후 서버측 필터링
1. `maxResults`만큼 게시물을 수집 (기존 방식)
2. 수집 완료 후 `post.timestamp >= since`인 게시물만 DB에 저장
3. 연속으로 `since` 이전 게시물이 20건 이상 발견되면 조기 중단 (비용 절감)
4. 새 게시물 0건이면 스킵, 로그만 기록

### 4.3 스케줄 실행 흐름

```
1. checkSchedule() → keyword_targets WHERE next_scrape_at <= NOW AND is_active = 1
2. for each target:
   a. startScheduledJob(target)
      → searchByHashtag(keyword, { maxResults, since: last_post_timestamp })
      → Phase 2 enrichment (API 우선, 병렬 3)
      → GeoClassifier 실행
      → influencer_master UPSERT
      → keyword_targets 업데이트: last_post_timestamp, last_scraped_at, next_scrape_at, total_extracted
3. 새 게시물 0건 → 스킵, 로그만 기록
```

### 4.4 키워드 관리 UI

Data 페이지에 **Keywords 탭** 추가:

- 키워드 CRUD: pair_id, 플랫폼, 국가, 해시태그, 수집 주기, 최대 수집 수
- 활성/비활성 토글
- 마지막 수집 시간, 다음 예정 시각, 총 추출 수 표시
- "Run Now" 즉시 실행 버튼
- 수집 주기 실시간 수정 (1시간~30일 범위)

---

## Section 5: CLI DM 발송 퍼널

### 5.1 DM 엔진 아키텍처

instagram-cli 프로젝트(github.com/supreme-gg-gg/instagram-cli) 분석 결과를 반영합니다.

**Instagram**: `instagram-private-api` + `instagram_mqtt` 라이브러리 사용
- 브라우저 자동화가 아닌 모바일 API 에뮬레이션
- `POST /api/v1/direct_v2/threads/broadcast/text/`
- 세션 파일 재사용으로 재로그인 최소화
- pre/post login flow 에뮬레이션

**기타 플랫폼**: Playwright 브라우저 자동화
- TikTok, Twitter, YouTube, Xiaohongshu
- 기존 StealthBrowser + humanBehavior 재활용

### 5.2 멀티 계정 로테이션

`dm_accounts` 테이블에서 플랫폼별 여러 계정을 관리합니다:

```
계정 A: 오늘 40건 발송 → 리밋 도달 → 계정 B로 자동 전환
계정 B: 오늘 15건 발송 → 계속 발송
계정 C: blocked 상태 → 스킵
```

- 일일 리밋 자동 리셋 (자정 기준)
- 계정별 독립 세션 파일
- 계정 차단 감지 시 자동 비활성화

### 5.3 4단계 퍼널

**퍼널 1: 타겟팅 쿼리**
```sql
SELECT * FROM influencer_master
WHERE platform = ?
  AND detected_country = ?
  AND scout_tier IN (?, ?)
  AND followers_count BETWEEN ? AND ?
  AND dm_status = 'pending'
  AND influencer_key NOT IN (
    SELECT influencer_key FROM dm_action_queue WHERE campaign_id = ?
  )
LIMIT ?;
```

**퍼널 2: 메시지 생성 (템플릿 기반)**

지원 변수:
```
{{username}}        - 인플루언서 유저네임
{{full_name}}       - 풀네임
{{followers_count}} - 팔로워 수 (포맷팅)
{{platform}}        - 플랫폼명
{{brand}}           - 캠페인 브랜드명
{{campaign_name}}   - 캠페인명
```

템플릿 예시:
```
Hi @{{username}}! We love your content and think you'd be a great fit
for our {{brand}} campaign. Would you be interested in collaborating?
```

**퍼널 3: 큐어링 & 발송**

```typescript
class DMEngine {
  async processCampaign(campaignId: string): Promise<void> {
    // 1. dm_action_queue에서 pending 항목 가져오기
    // 2. 사용 가능한 dm_accounts 선택 (daily_sent < daily_limit)
    // 3. 계정 로테이션: 10건마다 계정 변경
    // 4. 발송 루프:
    //    a. 랜덤 딜레이 (campaign.delay_min_sec ~ delay_max_sec, 정규분포)
    //    b. DM 발송 (instagram-private-api 또는 Playwright)
    //    c. 상태 업데이트: execute_status = 'success' / 'failed'
    //    d. 20건 발송 후 15-30분 쿨다운
    //    e. 계정 daily_sent++
    // 5. 실패 시 retry_count++ (최대 2회)
  }
}
```

안티봇 스텔스 전략:
- 랜덤 딜레이: 45-120초 (정규분포, 평균 75초)
- 일일 계정당 리밋: 기본 40건 (설정 가능)
- 계정 로테이션: 10건마다 다음 계정
- 세션 쿨다운: 20건 후 15-30분 휴식
- 시간대 인식: 해당 국가 비즈니스 시간에만 발송 (선택)

**퍼널 4: 상태 동기화**

DM 발송 성공 시:
```
dm_action_queue.execute_status → 'success'
influencer_master.dm_status → 'sent'
influencer_master.dm_last_sent_at → NOW
influencer_master.dm_campaign_id → campaign_id
dm_campaigns.total_sent++
dm_accounts.daily_sent++
```

### 5.4 플랫폼별 DM 구현

| 플랫폼 | 방식 | 라이브러리 | 진입 경로 |
|--------|------|-----------|----------|
| Instagram | 모바일 API | instagram-private-api | `/api/v1/direct_v2/threads/broadcast/text/` |
| TikTok | 브라우저 자동화 | Playwright + StealthBrowser | 프로필 → 메시지 → 입력 |
| Twitter | 브라우저 자동화 | Playwright + StealthBrowser | `/messages/compose` → 검색 → 입력 |
| YouTube | 이메일 추출 | N/A | 채널 정보 → contact_email 사용 |
| Xiaohongshu | 브라우저 자동화 | Playwright + StealthBrowser | 프로필 → 私信 → 입력 |

### 5.5 캠페인 관리 UI

Data 페이지에 **Campaigns 탭** 추가:
- 캠페인 CRUD: 이름, 브랜드, 플랫폼, 타겟 국가, 등급, 팔로워 범위
- 메시지 템플릿 편집기 (변수 미리보기)
- 타겟 추출 버튼: 조건에 맞는 인플루언서 → dm_action_queue 자동 생성
- 발송 시작/일시정지/재개 컨트롤
- 발송 대시보드: 진행률, 성공/실패/응답 현황
- 발송 계정 관리: 추가/제거/상태 확인

---

## Section 6: 웹 UI 확장

### 6.1 Data 페이지 탭 구조

```
Data 페이지
├── Profiles 탭 (기존 마스터 데이터)
│   └── 국가 필터, 등급 필터 추가
├── Keywords 탭 (NEW)
│   └── keyword_targets CRUD + 스케줄 관리
├── Campaigns 탭 (NEW)
│   └── 캠페인 CRUD + DM 발송 관리
└── Accounts 탭 (NEW)
    └── DM 발송 계정 관리
```

### 6.2 Profiles 탭 확장

기존 프로필 테이블에 다음 컬럼 추가:
- Country (국기 이모지 + 코드)
- Language
- Tier (S/A/B/C 배지)
- DM Status (상태 배지)
- Source Keywords (어떤 키워드에서 발견됐는지)

필터 추가:
- 국가별 필터 탭
- 등급별 필터
- DM 상태별 필터

---

## Section 7: 파일 구조 (신규/수정)

### 신규 파일

```
src/
├── core/
│   └── geo-classifier.ts        # NLP 국가 판별 엔진
├── services/
│   ├── scheduler.ts              # Cron 스케줄러
│   └── dm-engine.ts              # DM 발송 엔진
├── data/
│   ├── city-country-map.ts       # 도시→국가 매핑 (5000+)
│   ├── lang-country-map.ts       # 언어→국가 매핑
│   └── country-hashtags.ts       # 국가별 특유 해시태그
└── web/
    ├── services/
    │   └── master-db.ts          # influencer_master CRUD
    ├── routes/
    │   └── api.ts                # 추가 엔드포인트
    └── views/
        └── data.html             # 탭 UI 확장
```

### 수정 파일

```
src/core/types.ts                 # 신규 인터페이스 추가
src/core/anti-detection/stealth-browser.ts  # 컨텍스트 풀링
src/platforms/instagram/scraper.ts  # API 우선 모드
src/web/services/db.ts            # 신규 테이블 스키마
src/web/services/job-manager.ts   # 스케줄러 연동, 병렬 enrichment
src/web/public/app.js             # 신규 UI 컴포넌트
src/web/views/data.html           # 탭 UI
src/web/views/layout.html         # 네비게이션 업데이트 (필요시)
```

---

## Section 8: 의존성 추가

```json
{
  "franc": "^6.0.0",              // 언어 감지
  "node-cron": "^3.0.0",          // Cron 스케줄러
  "p-limit": "^5.0.0",            // 병렬 제한
  "instagram-private-api": "^1.46.1",  // Instagram 모바일 API
  "instagram_mqtt": "^1.6.0"       // Instagram 실시간 메시징
}
```

---

## Section 9: 구현 순서

이 프로젝트는 5개 서브시스템으로 구성되며, 아래 순서로 구현합니다:

### Phase 1: 스크래핑 엔진 최적화 (즉각 효과)
1. StealthBrowser 컨텍스트 풀링
2. API 우선 모드 (Fast Path)
3. pLimit 병렬 enrichment
4. 테스트: 228명 재enrichment 5분 이내 완료

### Phase 2: DB 스키마 확장
1. keyword_targets 테이블
2. influencer_master 테이블
3. dm_campaigns + dm_action_queue + dm_accounts 테이블
4. profiles → influencer_master UPSERT 로직
5. 기존 데이터 마이그레이션

### Phase 3: NLP 국가 판별
1. franc 설치 + GeoClassifier 구현
2. 도시/국가 매핑 데이터 구축
3. 간체/번체 판별 로직
4. 기존 influencer_master 데이터에 국가 일괄 태깅

### Phase 4: 델타 스크래핑 + 스케줄러
1. node-cron 설치 + SchedulerService
2. SearchOptions.since 구현
3. keyword_targets CRUD API
4. Keywords 탭 UI

### Phase 5: DM 발송 퍼널
1. instagram-private-api 통합
2. DMEngine 코어 로직
3. 멀티 계정 로테이션
4. Campaigns + Accounts 탭 UI
5. 플랫폼별 DM 구현 (Instagram 우선)
