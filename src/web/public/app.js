// ─── Utility Functions ───

function formatNumber(num) {
  if (num == null) return '-';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' ' + d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
}

function formatDateKST(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' ' + d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function exportJob(jobId, format) {
  window.location.href = `/api/jobs/${jobId}/export?format=${format}`;
}

// ─── Alpine.js Global App ───

function app() {
  return {};
}

// ─── Global Notifications Component ───

function globalNotifications() {
  return {
    notifications: [],
    eventSource: null,
    maxVisible: 5,
    _idCounter: 0,

    init() {
      this.connect();
    },

    connect() {
      if (this.eventSource) {
        this.eventSource.close();
      }

      this.eventSource = new EventSource('/api/global/stream');

      this.eventSource.addEventListener('scraping_started', (e) => {
        const data = JSON.parse(e.data);
        const keyword = data.keyword || '';
        const platform = data.platform || '';
        this.addNotification({
          type: 'scraping_started',
          message: `스크래핑 시작: ${keyword} (${platform})`,
          detail: data.scheduled ? '예약 작업' : data.jobId ? `Job: ${data.jobId.slice(0, 8)}` : '',
        });
      });

      this.eventSource.addEventListener('scraping_completed', (e) => {
        const data = JSON.parse(e.data);
        const postsCount = data.postsCount || 0;
        const profilesCount = data.profilesCount || 0;
        this.addNotification({
          type: 'scraping_completed',
          message: `스크래핑 완료: ${postsCount}개 포스트, ${profilesCount}명 프로필`,
          detail: data.jobId ? `Job: ${data.jobId.slice(0, 8)}` : '',
        });
      });

      this.eventSource.addEventListener('auto_assign', (e) => {
        const data = JSON.parse(e.data);
        const assigned = data.assigned || 0;
        this.addNotification({
          type: 'auto_assign',
          message: `캠페인 자동 배정: ${assigned}명 배정됨`,
          detail: data.message || '',
        });
      });

      this.eventSource.addEventListener('cookie_warning', (e) => {
        const data = JSON.parse(e.data);
        this.addNotification({
          type: 'cookie_warning',
          message: `쿠키 만료 경고: @${data.username} (${data.platform})`,
          detail: data.detail || '',
        });
      });

      this.eventSource.addEventListener('cookie_expired', (e) => {
        const data = JSON.parse(e.data);
        this.addNotification({
          type: 'cookie_expired',
          message: `쿠키 만료됨: @${data.username} (${data.platform})`,
          detail: data.detail || '',
        });
      });

      this.eventSource.addEventListener('error', () => {
        // SSE will auto-reconnect
      });
    },

    addNotification({ type, message, detail }) {
      const id = ++this._idCounter;
      const notification = {
        id,
        type,
        message,
        detail: detail || '',
        timestamp: new Date().toISOString(),
        visible: true,
      };

      // Add to front (newest first)
      this.notifications.unshift(notification);

      // Trim to max visible
      const visibleCount = this.notifications.filter(n => n.visible).length;
      if (visibleCount > this.maxVisible) {
        // Hide oldest visible notifications
        const visible = this.notifications.filter(n => n.visible);
        for (let i = this.maxVisible; i < visible.length; i++) {
          visible[i].visible = false;
        }
      }

      // Auto-dismiss after 10 seconds
      setTimeout(() => {
        this.dismiss(id);
      }, 10000);

      // Clean up old hidden notifications (keep array from growing)
      if (this.notifications.length > 50) {
        this.notifications = this.notifications.filter(n => n.visible);
      }
    },

    dismiss(id) {
      const n = this.notifications.find(n => n.id === id);
      if (n) n.visible = false;
    },

    destroy() {
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    },
  };
}

// ─── Platform Status Component ───

function platformStatus() {
  return {
    platforms: [],
    searchPlatform: 'instagram',
    searchTag: '',
    searchMax: 50,

    async load() {
      const res = await fetch('/api/platforms');
      const data = await res.json();
      this.platforms = data.platforms;
    },

    async quickSearch() {
      if (!this.searchTag) return;
      const res = await fetch('/api/jobs/hashtag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: this.searchPlatform,
          hashtag: this.searchTag,
          maxResults: this.searchMax || 50,
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        window.location.href = `/search?jobId=${data.jobId}`;
      }
    },
  };
}

// ─── Recent Jobs Component ───

function recentJobs() {
  return {
    jobs: [],

    async load() {
      const res = await fetch('/api/jobs?limit=10');
      const data = await res.json();
      this.jobs = data.jobs;
    },
  };
}

// ─── Search Page Component ───

function searchPage() {
  return {
    platform: 'instagram',
    hashtag: '',
    maxResults: 50,
    isSearching: false,
    posts: [],
    profiles: [],
    activeTab: 'posts',
    enrichProfiles: true,
    progressCount: 0,
    profilePhase: false,
    profileCount: 0,
    profileTotal: 0,
    profileSkipped: 0,
    profileErrors: 0,
    profileRetrying: false,
    profilePaused: false,
    currentJobId: null,
    sortBy: 'likes',
    eventSource: null,
    activityLogs: [],

    addLog(msg) {
      const ts = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.activityLogs.push(`[${ts}] ${msg}`);
      if (this.activityLogs.length > 100) this.activityLogs.shift();
      this.$nextTick(() => {
        const el = this.$refs.activityLog;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    init() {
      const params = new URLSearchParams(window.location.search);
      const jobId = params.get('jobId');
      if (jobId) {
        this.currentJobId = jobId;
        this.loadJobResults(jobId);
        this.connectSSE(jobId);
      }
    },

    async startSearch() {
      if (!this.hashtag) return;

      this.posts = [];
      this.profiles = [];
      this.progressCount = 0;
      this.profilePhase = false;
      this.profileCount = 0;
      this.profileTotal = 0;
      this.profileSkipped = 0;
      this.profileErrors = 0;
      this.profileRetrying = false;
      this.profilePaused = false;
      this.activeTab = 'posts';
      this.isSearching = true;
      this.activityLogs = [];
      this.addLog(`검색 시작: #${this.hashtag} (최대 ${this.maxResults}개)`);

      const res = await fetch('/api/jobs/hashtag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: this.platform,
          hashtag: this.hashtag,
          maxResults: this.maxResults,
          enrichProfiles: this.enrichProfiles,
        }),
      });
      const data = await res.json();
      this.currentJobId = data.jobId;

      history.pushState(null, '', `/search?jobId=${data.jobId}`);
      this.connectSSE(data.jobId);
    },

    connectSSE(jobId) {
      if (this.eventSource) {
        this.eventSource.close();
      }

      this.eventSource = new EventSource(`/api/jobs/${jobId}/stream`);

      this.eventSource.addEventListener('post', (e) => {
        const post = JSON.parse(e.data);
        this.posts.push(post);
        this.sortPosts();
      });

      this.eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        if (data.phase === 'profiles') {
          this.profileCount = data.count;
          this.profileTotal = data.total;
        } else {
          this.progressCount = data.count;
          if (data.count % 50 === 0 || data.count === 1) {
            this.addLog(`포스트 수집: ${data.count} / ${data.total}`);
          }
        }
        this.isSearching = true;
      });

      this.eventSource.addEventListener('profile_start', (e) => {
        const data = JSON.parse(e.data);
        this.profilePhase = true;
        this.profileTotal = data.total;
        this.profileSkipped = data.skipped || 0;
        this.addLog(`2단계: ${data.total}개 프로필 분석 시작` + (data.skipped ? ` (${data.skipped}개 건너뜀 - 이미 존재)` : ''));
      });

      this.eventSource.addEventListener('profile', (e) => {
        const profile = JSON.parse(e.data);
        this.profiles.push(profile);
        this.profileCount++;
        if (this.profileCount % 10 === 0 || this.profileCount === 1) {
          this.addLog(`프로필 분석 완료: @${profile.username} (${this.profileCount}/${this.profileTotal})`);
        }
      });

      this.eventSource.addEventListener('profile_error', (e) => {
        const data = JSON.parse(e.data);
        this.profileErrors++;
        this.addLog(`프로필 실패: @${data.username} - ${data.error}`);
      });

      this.eventSource.addEventListener('profile_pause', (e) => {
        this.profilePaused = true;
        const data = JSON.parse(e.data);
        this.addLog(`연속 실패로 ${data.pauseSeconds}초 대기 중...`);
        setTimeout(() => { this.profilePaused = false; }, (data.pauseSeconds || 30) * 1000);
      });

      this.eventSource.addEventListener('profile_retry', (e) => {
        const data = JSON.parse(e.data);
        this.profileRetrying = true;
        this.addLog(`실패한 ${data.count}개 프로필 재시도 중...`);
      });

      this.eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        this.isSearching = false;
        this.profileRetrying = false;
        this.addLog(`완료! 포스트: ${data.postsCount || data.resultCount}개, 프로필: ${data.profilesCount || 0}개`);
        this.eventSource.close();
        this.eventSource = null;
      });

      this.eventSource.addEventListener('error', (e) => {
        if (e.data) {
          const data = JSON.parse(e.data);
          this.addLog(`오류: ${data.message}`);
          console.error('SSE error:', data.message);
        }
        this.isSearching = false;
        this.eventSource.close();
        this.eventSource = null;
      });

      this.eventSource.addEventListener('status', (e) => {
        const data = JSON.parse(e.data);
        if (data.status === 'completed' || data.status === 'failed') {
          this.isSearching = false;
          if (data.status === 'failed') this.addLog(`작업 실패: ${data.error || '알 수 없는 오류'}`);
        } else if (data.status === 'running') {
          this.isSearching = true;
          this.addLog('작업 실행 중...');
        }
      });
    },

    async loadJobResults(jobId) {
      const res = await fetch(`/api/jobs/${jobId}/posts?sortBy=${this.sortBy}&limit=2000`);
      const data = await res.json();
      this.posts = data.posts;
      this.progressCount = data.total;

      const profileRes = await fetch(`/api/jobs/${jobId}/profiles`);
      const profileData = await profileRes.json();
      this.profiles = profileData.profiles || [];

      const jobRes = await fetch(`/api/jobs/${jobId}`);
      const job = await jobRes.json();
      this.isSearching = job.status === 'running' || job.status === 'pending';
      this.platform = job.platform;
      this.hashtag = job.query;
      this.maxResults = job.maxResults;
    },

    sortPosts() {
      const key = this.sortBy === 'likes' ? 'likesCount'
        : this.sortBy === 'comments' ? 'commentsCount'
        : 'viewsCount';
      this.posts.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    },
  };
}

// ─── Keywords Page Component ───

function keywordsPage() {
  return {
    targets: [],
    loading: false,
    showAddForm: false,
    newTarget: {
      pairId: '',
      platform: 'instagram',
      region: '',
      keyword: '',
      scrapingCycleHours: 72,
      maxResultsPerRun: 200,
      scrapeUntil: '',
    },
    estimatedTime: '~17분',
    estimatedPostTime: '~10분',
    estimatedProfileTime: '~7분',

    // Per-keyword running jobs
    _runningJobs: {},  // { pairId: { jobId, status, phase, counts, percent, sse, startedAt, ... } }
    _globalSSE: null,
    _refreshTimer: null,
    _tick: 0,  // incremented every second to force elapsed time re-render

    _saveRunningState() {
      try {
        const state = {};
        for (const [k, v] of Object.entries(this._runningJobs)) {
          if (v.status === 'running' || v.status === 'completed' || v.status === 'failed') {
            state[k] = { jobId: v.jobId, status: v.status, phase: v.phase, counts: { ...v.counts }, percent: v.percent, startedAt: v.startedAt, completedAt: v.completedAt };
          }
        }
        sessionStorage.setItem('_runningJobs', JSON.stringify(state));
      } catch {}
    },

    _restoreRunningState() {
      try {
        const saved = sessionStorage.getItem('_runningJobs');
        if (!saved) return;
        const state = JSON.parse(saved);
        for (const [pairId, v] of Object.entries(state)) {
          if (!this._runningJobs[pairId]) {
            if (v.status === 'running' && v.jobId) {
              this._runningJobs[pairId] = { ...v, sse: null };
              this._connectJobSSE(pairId, v.jobId);
            } else if (v.status === 'completed' || v.status === 'failed') {
              this._runningJobs[pairId] = { ...v, sse: null };
            }
          }
        }
      } catch {}
    },

    startJobMonitor(pairId, jobId) {
      // Close existing SSE for this pairId
      if (this._runningJobs[pairId]?.sse) {
        this._runningJobs[pairId].sse.close();
      }

      this._runningJobs[pairId] = {
        jobId,
        status: 'running',
        phase: '브라우저 초기화...',
        counts: { posts: 0, profiles: 0, profilesTotal: 0, ai: 0, aiTotal: 0, total: 0, skipped: 0 },
        percent: 0,
        sse: null,
        startedAt: Date.now(),
      };

      this._connectJobSSE(pairId, jobId);
      this._saveRunningState();
    },

    _connectJobSSE(pairId, jobId) {
      const job = this._runningJobs[pairId];
      if (!job) return;
      job.sse = new EventSource(`/api/jobs/${jobId}/stream`);

      // Handle initial status (sent on SSE connect)
      job.sse.addEventListener('status', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.status === 'running' && d.result_count > 0) {
            job.counts.posts = d.result_count;
            job.phase = `포스트 수집 중 ${d.result_count}건`;
            job.percent = Math.min(30, Math.round(d.result_count / (job.counts.total || 200) * 33));
          } else if (d.status === 'completed') {
            job.status = 'completed';
            job.phase = `완료 (${d.result_count || 0}건)`;
            job.percent = 100;
            job.sse?.close();
            this._saveRunningState();
            this.load();
          }
        } catch {}
      });

      job.sse.addEventListener('progress', (e) => {
        const d = JSON.parse(e.data);
        if (d.phase === 'posts') {
          job.counts.posts = d.count;
          job.counts.total = d.total || 0;
          job.phase = `포스트 수집 ${d.count}/${d.total || '?'}`;
          job.percent = d.total ? Math.round((d.count / d.total) * 33) : Math.min(30, d.count);
          // Live update extracted count on target row
          const t = this.targets?.find(t => t.pairId === pairId);
          if (t) t._liveExtracted = (t.totalExtracted || 0) + d.count;
        } else if (d.phase === 'profiles') {
          job.counts.profiles = d.count;
          job.counts.profilesTotal = d.total || 0;
          job.phase = `프로필 추출 ${d.count}/${d.total || '?'}`;
          job.percent = 33 + (d.total ? Math.round((d.count / d.total) * 34) : Math.min(30, d.count));
        } else if (d.phase === 'ai_classify') {
          job.counts.ai = d.count;
          job.counts.aiTotal = d.total || 0;
          job.phase = `AI 분류 ${d.count}/${d.total || '?'}`;
          job.percent = 67 + (d.total ? Math.round((d.count / d.total) * 33) : Math.min(30, d.count));
        }
        this._saveRunningState();
      });

      job.sse.addEventListener('profile_start', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.counts.profilesTotal = d.total;
          job.counts.skipped = d.skipped || 0;
          job.phase = `프로필 추출 시작 (신규 ${d.total}명${d.skipped ? ', 기존 ' + d.skipped + '명 스킵' : ''})`;
          job.percent = 33;
        } catch {}
      });

      job.sse.addEventListener('profile_pause', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.phase = `⏸ 안티봇 대기 ${d.pauseSeconds || 30}초...`;
        } catch {}
      });

      job.sse.addEventListener('profile_retry', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.phase = `재시도 ${d.count}건...`;
        } catch {}
      });

      job.sse.addEventListener('profile_error', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.consecutiveFailures >= 3) {
            job.phase = `프로필 추출 ${job.counts.profiles}/${job.counts.profilesTotal} (연속실패 ${d.consecutiveFailures})`;
          }
        } catch {}
      });

      job.sse.addEventListener('ai_complete', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.phase = `AI 분류 완료 (${d.classified}명, ${d.assigned}명 캠페인 배정)`;
          job.percent = 95;
        } catch {}
      });

      job.sse.addEventListener('complete', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.status = 'completed';
          job.phase = `완료 — ${d.postsCount || 0}P, ${d.profilesCount || 0}명 추출`;
          job.percent = 100;
          job.completedAt = new Date().toISOString();
          job.sse?.close();
          this._saveRunningState();
          this.load();
        } catch {}
      });

      job.sse.addEventListener('error', (e) => {
        try {
          const d = JSON.parse(e.data);
          job.status = 'failed';
          job.phase = `오류: ${d.message?.substring(0, 60) || '알 수 없음'}`;
          job.sse?.close();
          this._saveRunningState();
        } catch {}
      });

      job.sse.onerror = () => {
        if (job.status === 'running') {
          job.phase = '연결 재시도...';
          // Reconnect after 3s
          setTimeout(() => {
            if (job.status === 'running' && (!job.sse || job.sse.readyState === 2)) {
              this._connectJobSSE(pairId, jobId);
            }
          }, 3000);
        }
      };
    },

    getJobProgress(pairId) {
      return this._runningJobs[pairId] || null;
    },

    _getElapsed(pairId) {
      void this._tick; // reactive dependency for auto-refresh
      const job = this._runningJobs[pairId];
      if (!job?.startedAt) return '';
      const sec = Math.floor((Date.now() - job.startedAt) / 1000);
      if (sec < 60) return sec + '초';
      return Math.floor(sec / 60) + '분 ' + (sec % 60) + '초';
    },

    updatePairId() {
      const kw = this.newTarget.keyword.replace(/^#/, '').trim();
      if (this.newTarget.platform && this.newTarget.region && kw) {
        this.newTarget.pairId = `${this.newTarget.platform}:${this.newTarget.region}:${kw}`;
      } else {
        this.newTarget.pairId = '';
      }
    },

    updateEstimate() {
      const max = this.newTarget.maxResultsPerRun || 200;
      // Post collection: ~3s per post (anti-bot delays included)
      const postSec = max * 3;
      // Profile enrichment: ~75% unique authors, ~2.5s per profile
      const uniqueProfiles = Math.round(max * 0.75);
      const profileSec = uniqueProfiles * 2.5;
      const totalSec = postSec + profileSec;
      const totalMin = Math.ceil(totalSec / 60);
      const postMin = Math.ceil(postSec / 60);
      const profileMin = Math.ceil(profileSec / 60);
      this.estimatedTime = `~${totalMin}분`;
      this.estimatedPostTime = `~${postMin}분`;
      this.estimatedProfileTime = `~${profileMin}분`;
    },

    async load() {
      this.loading = true;
      const res = await fetch('/api/keywords');
      const data = await res.json();
      this.targets = data.targets;
      this.loading = false;
      // Restore saved running state from sessionStorage (page navigation)
      this._restoreRunningState();
      // Start SSE monitoring for any keywords that have a running job
      for (const t of this.targets) {
        if (t.lastJobStatus === 'running' && t.lastJobId && !this._runningJobs[t.pairId]) {
          this.startJobMonitor(t.pairId, t.lastJobId);
        }
      }
      // Start global SSE to auto-detect scheduler-triggered scraping
      this._startGlobalSSE();
      // Auto-refresh every 30s to pick up scheduler changes
      if (!this._refreshTimer) {
        this._refreshTimer = setInterval(() => this._silentRefresh(), 30000);
      }
      // Tick every 2s to update elapsed time display
      if (!this._tickTimer) {
        this._tickTimer = setInterval(() => { this._tick++; }, 2000);
      }
    },

    async _silentRefresh() {
      try {
        const res = await fetch('/api/keywords');
        const data = await res.json();
        // Update targets without flicker
        for (const t of data.targets) {
          const existing = this.targets.find(e => e.pairId === t.pairId);
          if (existing) {
            Object.assign(existing, t);
          }
        }
        // Detect newly running jobs from scheduler
        for (const t of data.targets) {
          if (t.lastJobStatus === 'running' && t.lastJobId && !this._runningJobs[t.pairId]) {
            this.startJobMonitor(t.pairId, t.lastJobId);
          }
        }
      } catch { /* silent */ }
    },

    _startGlobalSSE() {
      if (this._globalSSE) return;
      this._globalSSE = new EventSource('/api/global/stream');
      this._globalSSE.addEventListener('scraping_started', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.pairId && d.jobId && !this._runningJobs[d.pairId]) {
            this.startJobMonitor(d.pairId, d.jobId);
          }
        } catch {}
      });
      this._globalSSE.addEventListener('scraping_completed', () => {
        this._silentRefresh();
      });
    },

    async addKeyword() {
      if (!this.newTarget.region || !this.newTarget.keyword) {
        alert('국가와 키워드를 입력하세요');
        return;
      }
      this.updatePairId();
      if (!this.newTarget.pairId) {
        alert('플랫폼, 국가, 키워드를 모두 입력하세요');
        return;
      }
      const payload = {
        pairId: this.newTarget.pairId,
        platform: this.newTarget.platform,
        region: this.newTarget.region,
        keyword: this.newTarget.keyword,
        scrapingCycleHours: this.newTarget.scrapingCycleHours,
        maxResultsPerRun: this.newTarget.maxResultsPerRun,
      };
      if (this.newTarget.scrapeUntil) {
        payload.scrapeUntil = new Date(this.newTarget.scrapeUntil + 'T23:59:59Z').toISOString();
      }
      const res = await fetch('/api/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        alert('오류: ' + data.error);
        return;
      }
      this.showAddForm = false;
      this.newTarget = { pairId: '', platform: 'instagram', region: '', keyword: '', scrapingCycleHours: 72, maxResultsPerRun: 200, scrapeUntil: '' };
      this.load();
    },

    async toggleActive(target) {
      await fetch(`/api/keywords/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !target.isActive }),
      });
      this.load();
    },

    async runNow(target) {
      try {
        const res = await fetch(`/api/keywords/${target.pairId}/run`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          alert(data.error);
        } else {
          this.startJobMonitor(target.pairId, data.jobId);
          this.load();
        }
      } catch (err) {
        alert('시작 실패: ' + err.message);
      }
    },

    // Inline editing
    _editing: null,  // { id, field, value }

    startEdit(target, field) {
      this._editing = {
        id: target.id,
        pairId: target.pairId,
        field,
        value: field === 'scrapeUntil' ? (target.scrapeUntil ? target.scrapeUntil.split('T')[0] : '') :
               field === 'scrapingCycleHours' ? target.scrapingCycleHours :
               field === 'maxResultsPerRun' ? target.maxResultsPerRun : '',
      };
    },

    isEditing(target, field) {
      return this._editing && this._editing.id === target.id && this._editing.field === field;
    },

    async saveEdit() {
      if (!this._editing) return;
      const { id, field, value } = this._editing;
      const payload = {};
      if (field === 'scrapingCycleHours') payload.scrapingCycleHours = parseInt(value) || 72;
      else if (field === 'maxResultsPerRun') payload.maxResultsPerRun = parseInt(value) || 200;
      else if (field === 'scrapeUntil') payload.scrapeUntil = value ? new Date(value + 'T23:59:59Z').toISOString() : '';

      await fetch(`/api/keywords/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this._editing = null;
      this.load();
    },

    cancelEdit() {
      this._editing = null;
    },

    getLastResult(target) {
      // Show from session (current run) or from DB (last_job_result)
      const progress = this._runningJobs[target.pairId];
      if (progress) return progress;
      if (target.lastJobResult) {
        try {
          const r = JSON.parse(target.lastJobResult);
          return {
            status: target.lastJobStatus || 'completed',
            phase: target.lastJobStatus === 'failed'
              ? `오류: ${(r.error || '').substring(0, 50)}`
              : `완료 — ${r.posts || 0}P, ${r.profiles || 0}명 추출`,
            percent: target.lastJobStatus === 'completed' ? 100 : 0,
            counts: { posts: r.posts || 0, profiles: r.profiles || 0 },
            completedAt: r.completedAt || r.failedAt,
          };
        } catch { return null; }
      }
      return null;
    },

    async removeKeyword(id) {
      if (!confirm('이 키워드 타겟을 삭제하시겠습니까?')) return;
      await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
      this.load();
    },
  };
}

// ─── AI Classification Banner Component ───

function aiClassifyBanner() {
  return {
    aiTotal: 0,
    aiClassified: 0,
    aiUnclassified: 0,
    aiInfluencers: 0,
    aiBusinesses: 0,
    aiRunning: false,
    aiMessage: '',

    async loadStatus() {
      try {
        const res = await fetch('/api/master/ai-status');
        const data = await res.json();
        this.aiTotal = data.total;
        this.aiClassified = data.classified;
        this.aiUnclassified = data.unclassified;
        this.aiInfluencers = data.influencers;
        this.aiBusinesses = data.businesses;
      } catch { /* ignore */ }
    },

    async runClassify(reClassify = false) {
      this.aiRunning = true;
      this.aiMessage = '';
      try {
        const res = await fetch('/api/master/ai-classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reClassify }),
        });
        const data = await res.json();
        if (data.error) {
          this.aiMessage = 'Error: ' + data.error;
        } else {
          this.aiMessage = `${data.classified}개 프로필 분류 완료, ${data.assigned}개 캠페인 배정`;
          this.loadStatus();
          // Reload the profiles table if dataPage is loaded
          if (typeof this.$root !== 'undefined') {
            const dp = document.querySelector('[x-data="dataPage()"]');
            if (dp && dp.__x) dp.__x.$data.load();
          }
        }
      } catch (err) {
        this.aiMessage = 'Error: ' + err.message;
      } finally {
        this.aiRunning = false;
      }
    },
  };
}

// ─── Master Data Page Component ───

function dataPage() {
  return {
    profiles: [],
    stats: [],
    total: 0,
    totalAll: 0,
    platform: '',
    search: '',
    aiType: '',
    filterCountry: '',
    filterTier: '',
    filterDmStatus: '',
    filterCampaign: '',
    filterVerified: false,
    filterHasEmail: false,
    sortBy: 'added',
    order: 'desc',
    limit: 100,
    offset: 0,
    loading: false,
    filterOptions: {},
    campaignMap: {},
    missingProfiles: {},
    enriching: false,
    enrichCount: 0,
    enrichTotal: 0,
    enrichErrors: 0,
    enrichPaused: false,
    enrichRetrying: false,
    enrichLogs: [],
    enrichEventSource: null,

    hasActiveFilters() {
      return this.filterCountry || this.filterTier || this.aiType || this.filterDmStatus || this.filterCampaign || this.filterVerified || this.filterHasEmail;
    },

    resetFilters() {
      this.filterCountry = '';
      this.filterTier = '';
      this.aiType = '';
      this.filterDmStatus = '';
      this.filterCampaign = '';
      this.filterVerified = false;
      this.filterHasEmail = false;
      this.offset = 0;
      this.load();
    },

    async load() {
      this.loading = true;
      const params = new URLSearchParams({
        limit: this.limit.toString(),
        offset: this.offset.toString(),
        sortBy: this.sortBy,
        order: this.order,
      });
      if (this.platform) params.set('platform', this.platform);
      if (this.search) params.set('search', this.search);
      if (this.aiType) params.set('aiType', this.aiType);
      if (this.filterCountry) params.set('country', this.filterCountry);
      if (this.filterTier) params.set('tier', this.filterTier);
      if (this.filterDmStatus) params.set('dmStatus', this.filterDmStatus);
      if (this.filterCampaign) params.set('campaignId', this.filterCampaign);
      if (this.filterVerified) params.set('isVerified', '1');
      if (this.filterHasEmail) params.set('hasEmail', '1');

      const [profileRes, statsRes, missingRes] = await Promise.all([
        fetch(`/api/master/influencers?${params}`),
        fetch('/api/master/stats'),
        fetch('/api/profiles/missing'),
      ]);
      const profileData = await profileRes.json();
      const statsData = await statsRes.json();
      const missingData = await missingRes.json();

      // Build campaign name map from stats
      this.filterOptions = statsData;
      if (statsData.campaigns) {
        this.campaignMap = {};
        for (const cp of statsData.campaigns) this.campaignMap[cp.id] = cp.name;
      }

      // Enrich profiles with campaign name
      this.profiles = (profileData.influencers || []).map(p => {
        p._campaignName = p.dm_campaign_id ? (this.campaignMap[p.dm_campaign_id] || p.dm_campaign_id) : '';
        return p;
      });
      this.total = profileData.total;
      this.totalAll = statsData.total || 0;
      this.missingProfiles = missingData.missing || {};
      this.loading = false;
    },

    addEnrichLog(msg) {
      const ts = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.enrichLogs.push(`[${ts}] ${msg}`);
      if (this.enrichLogs.length > 100) this.enrichLogs.shift();
      this.$nextTick(() => {
        const el = this.$refs.enrichLog;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    async startReEnrich() {
      // Find first platform with missing profiles (or use current filter)
      const targetPlatform = this.platform || Object.keys(this.missingProfiles)[0];
      if (!targetPlatform) return;

      this.enriching = true;
      this.enrichCount = 0;
      this.enrichTotal = 0;
      this.enrichErrors = 0;
      this.enrichPaused = false;
      this.enrichRetrying = false;
      this.enrichLogs = [];
      this.addEnrichLog(`${targetPlatform} 재분석 시작...`);

      const res = await fetch('/api/jobs/re-enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: targetPlatform }),
      });
      const data = await res.json();

      if (!data.jobId) {
        this.addEnrichLog(`오류: ${data.error}`);
        this.enriching = false;
        return;
      }

      this.addEnrichLog(`작업 시작: ${data.missingCount}개 프로필 분석 예정`);
      this.connectEnrichSSE(data.jobId);
    },

    connectEnrichSSE(jobId) {
      if (this.enrichEventSource) this.enrichEventSource.close();
      this.enrichEventSource = new EventSource(`/api/jobs/${jobId}/stream`);

      this.enrichEventSource.addEventListener('profile_start', (e) => {
        const data = JSON.parse(e.data);
        this.enrichTotal = data.total;
        this.addEnrichLog(`${data.total}개 프로필 분석 예정`);
      });

      this.enrichEventSource.addEventListener('profile', (e) => {
        const profile = JSON.parse(e.data);
        this.enrichCount++;
        if (this.enrichCount % 5 === 0 || this.enrichCount === 1) {
          this.addEnrichLog(`분석 완료 @${profile.username} (${this.enrichCount}/${this.enrichTotal})`);
        }
      });

      this.enrichEventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        this.enrichCount = data.count;
        this.enrichTotal = data.total;
      });

      this.enrichEventSource.addEventListener('profile_error', (e) => {
        const data = JSON.parse(e.data);
        this.enrichErrors++;
        this.addEnrichLog(`실패 @${data.username}: ${data.error}`);
      });

      this.enrichEventSource.addEventListener('profile_pause', (e) => {
        this.enrichPaused = true;
        const data = JSON.parse(e.data);
        this.addEnrichLog(`${data.pauseSeconds}초 대기 중...`);
        setTimeout(() => { this.enrichPaused = false; }, (data.pauseSeconds || 30) * 1000);
      });

      this.enrichEventSource.addEventListener('profile_retry', (e) => {
        const data = JSON.parse(e.data);
        this.enrichRetrying = true;
        this.addEnrichLog(`실패한 ${data.count}개 프로필 재시도 중...`);
      });

      this.enrichEventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        this.enriching = false;
        this.enrichRetrying = false;
        this.addEnrichLog(`완료! ${data.profilesCount}개 프로필 분석됨.`);
        this.enrichEventSource.close();
        this.enrichEventSource = null;
        // Reload data
        this.load();
      });

      this.enrichEventSource.addEventListener('error', (e) => {
        if (e.data) {
          const data = JSON.parse(e.data);
          this.addEnrichLog(`오류: ${data.message}`);
        }
        this.enriching = false;
        this.enrichEventSource.close();
        this.enrichEventSource = null;
      });
    },

    exportAll(format) {
      // TODO: implement master export
      alert('내보내기 기능 준비 중입니다. 작업 이력 페이지에서 개별 작업 내보내기를 이용하세요.');
    },
  };
}

// ─── Campaigns Page Component ───

function campaignsPage() {
  return {
    campaigns: [],
    loading: false,
    showCreateForm: false,
    showCookieUpload: false,
    showEditModal: false,
    editCampaign: null,
    cookieUploadCampaign: null,
    cookieSenderUsername: '',
    cookieJsonText: '',
    campaignSearch: '',
    campaignPage: 0,
    campaignsPerPage: 20,
    _cookieSSE: null,
    _refreshTimer: null,
    get filteredCampaigns() {
      if (!this.campaignSearch) return this.campaigns;
      const q = this.campaignSearch.toLowerCase();
      return this.campaigns.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.brand || '').toLowerCase().includes(q) ||
        (c.platform || '').toLowerCase().includes(q) ||
        (c.target_country || '').toLowerCase().includes(q)
      );
    },
    get paginatedCampaigns() {
      const start = this.campaignPage * this.campaignsPerPage;
      return this.filteredCampaigns.slice(start, start + this.campaignsPerPage);
    },
    filterCampaigns() { this.campaignPage = 0; },
    newCampaign: {
      name: '',
      brand: '',
      platform: 'instagram',
      targetCountry: '',
      dailyLimit: 40,
      messageTemplate: '',
      senderUsername: '',
      cookieJson: '',
    },

    _refreshInterval: null,

    toggleCampaign(campaign) {
      const wasCollapsed = campaign._collapsed;
      // Collapse all
      this.campaigns.forEach(c => c._collapsed = true);
      // Toggle clicked one
      campaign._collapsed = !wasCollapsed;
    },

    async load() {
      this.loading = true;
      const res = await fetch('/api/campaigns');
      const data = await res.json();
      this.campaigns = data.campaigns.map(c => {
        // Preserve existing expand state
        const existing = this.campaigns.find(e => e.id === c.id);
        return {
          ...c,
          _collapsed: existing ? existing._collapsed : true,
          _showTargets: existing ? existing._showTargets : false,
          _targets: existing ? existing._targets : [],
          _targetTotal: existing ? existing._targetTotal : 0,
          _targetsLoading: false,
          _targetPage: existing ? existing._targetPage : 0,
        };
      });
      this.loading = false;

      // Auto-refresh every 10s for active campaigns or every 30s otherwise
      if (!this._refreshInterval) {
        const interval = this.campaigns.some(c => c.status === 'active') ? 10000 : 30000;
        this._refreshInterval = setInterval(() => this.refreshStats(), interval);
      }
      // Subscribe to cookie-health SSE for real-time cookie status
      if (!this._cookieSSE) {
        this._cookieSSE = new EventSource('/api/cookie-health/stream');
        this._cookieSSE.addEventListener('status_change', (e) => {
          try {
            const d = JSON.parse(e.data);
            // Update matching campaigns' cookie status
            for (const c of this.campaigns) {
              if (c.sender_username === d.username && c.platform === d.platform) {
                c.cookie_status = d.status;
              }
            }
          } catch {}
        });
      }
    },

    async refreshStats() {
      try {
        const res = await fetch('/api/campaigns');
        const data = await res.json();
        for (const updated of data.campaigns) {
          const existing = this.campaigns.find(c => c.id === updated.id);
          if (existing) {
            existing.total_sent = updated.total_sent;
            existing.total_failed = updated.total_failed;
            existing.total_queued = updated.total_queued;
            existing.total_replied = updated.total_replied;
            existing.status = updated.status;
            existing.cookie_status = updated.cookie_status;
          }
        }
        // Stop refresh if no active campaigns
        if (!this.campaigns.some(c => c.status === 'active') && this._refreshInterval) {
          clearInterval(this._refreshInterval);
          this._refreshInterval = null;
        }
      } catch { /* ignore */ }
    },

    async createCampaign() {
      if (!this.newCampaign.name || !this.newCampaign.messageTemplate) {
        alert('캠페인 이름과 메시지 템플릿을 입력하세요');
        return;
      }
      const payload = {
        name: this.newCampaign.name,
        brand: this.newCampaign.brand || undefined,
        platform: this.newCampaign.platform,
        targetCountry: this.newCampaign.targetCountry || undefined,
        dailyLimit: this.newCampaign.dailyLimit,
        messageTemplate: this.newCampaign.messageTemplate,
        senderUsername: this.newCampaign.senderUsername.replace(/^@/, '') || undefined,
        cookieJson: this.newCampaign.cookieJson || undefined,
      };
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        alert('오류: ' + data.error);
        return;
      }
      this.showCreateForm = false;
      this.newCampaign = { name: '', brand: '', platform: 'instagram', targetCountry: '', dailyLimit: 40, messageTemplate: '', senderUsername: '', cookieJson: '' };
      this.load();
    },

    async generateQueue(campaignId) {
      const res = await fetch(`/api/campaigns/${campaignId}/queue`, { method: 'POST' });
      const data = await res.json();
      alert(data.message || data.error || '완료');
      this.load();
    },

    async startCampaign(campaignId) {
      await fetch(`/api/campaigns/${campaignId}/start`, { method: 'POST' });
      this.load();
    },

    async pauseCampaign(campaignId) {
      await fetch(`/api/campaigns/${campaignId}/pause`, { method: 'POST' });
      this.load();
    },

    async openEditModal(campaign) {
      this.editCampaign = {
        ...campaign,
        target_country: (campaign.target_country || '').toUpperCase(),
        target_tiers_input: campaign.target_tiers ? JSON.parse(campaign.target_tiers).join(',') : '',
        _cookieJson: '',
        _cookieLoading: false,
      };
      this.showEditModal = true;
      // Load current cookie JSON if available
      if (campaign.sender_username) {
        this.editCampaign._cookieLoading = true;
        try {
          const res = await fetch(`/api/campaigns/${campaign.id}/cookie-json`);
          const data = await res.json();
          if (data.cookieJson) {
            this.editCampaign._cookieJson = data.cookieJson;
          }
        } catch {}
        this.editCampaign._cookieLoading = false;
      }
    },

    async saveCampaignEdit() {
      if (!this.editCampaign) return;
      let targetTiers = null;
      if (this.editCampaign.target_tiers_input) {
        targetTiers = JSON.stringify(this.editCampaign.target_tiers_input.split(',').map(t => t.trim().toUpperCase()).filter(Boolean));
      }
      const payload = {
        name: this.editCampaign.name,
        brand: this.editCampaign.brand || null,
        platform: this.editCampaign.platform,
        targetCountry: this.editCampaign.target_country || null,
        dailyLimit: this.editCampaign.daily_limit,
        messageTemplate: this.editCampaign.message_template,
        senderUsername: this.editCampaign.sender_username || null,
        delayMinSec: this.editCampaign.delay_min_sec,
        delayMaxSec: this.editCampaign.delay_max_sec,
        maxRetries: this.editCampaign.max_retries,
        status: this.editCampaign.status,
        minFollowers: this.editCampaign.min_followers || null,
        maxFollowers: this.editCampaign.max_followers || null,
        targetTiers: targetTiers,
      };
      const res = await fetch(`/api/campaigns/${this.editCampaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) { alert('오류: ' + data.error); return; }
      // If cookie JSON was modified, also update cookies
      if (this.editCampaign._cookieJson && this.editCampaign.sender_username) {
        try {
          JSON.parse(this.editCampaign._cookieJson);
          await fetch(`/api/campaigns/${this.editCampaign.id}/upload-cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cookies: this.editCampaign._cookieJson,
              senderUsername: (this.editCampaign.sender_username || '').replace(/^@/, ''),
            }),
          });
        } catch { /* ignore invalid JSON */ }
      }
      this.showEditModal = false;
      this.load();
    },

    async toggleTargets(campaign) {
      campaign._showTargets = !campaign._showTargets;
      if (campaign._showTargets && (!campaign._targets || campaign._targets.length === 0)) {
        campaign._targetsLoading = true;
        try {
          const res = await fetch(`/api/campaigns/${campaign.id}/targets?limit=50&offset=0`);
          const data = await res.json();
          campaign._targets = data.targets;
          campaign._targetTotal = data.total;
          campaign._targetPage = 0;
        } catch { /* ignore */ }
        campaign._targetsLoading = false;
      }
    },

    async loadTargetsPage(campaign, page) {
      campaign._targetsLoading = true;
      try {
        const offset = page * 50;
        const res = await fetch(`/api/campaigns/${campaign.id}/targets?limit=50&offset=${offset}`);
        const data = await res.json();
        campaign._targets = data.targets;
        campaign._targetTotal = data.total;
        campaign._targetPage = page;
      } catch { /* ignore */ }
      campaign._targetsLoading = false;
    },

    async loadAllTargets(campaign) {
      campaign._targetsLoading = true;
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}/targets?limit=10000&offset=0`);
        const data = await res.json();
        campaign._targets = data.targets;
        campaign._targetTotal = data.total;
        campaign._targetPage = 0;
      } catch { /* ignore */ }
      campaign._targetsLoading = false;
    },

    cookieUploadResult: null,

    uploadCookieDialog(campaign) {
      this.cookieUploadCampaign = campaign;
      this.cookieSenderUsername = campaign.sender_username || '';
      this.cookieJsonText = '';
      this.cookieUploadResult = null;
      this.showCookieUpload = true;
    },

    async submitCookieUpload() {
      if (!this.cookieUploadCampaign || !this.cookieJsonText) {
        alert('쿠키 JSON 데이터를 입력하세요');
        return;
      }
      if (!this.cookieSenderUsername) {
        alert('발송 계정 유저명을 입력하세요');
        return;
      }
      try {
        JSON.parse(this.cookieJsonText);
      } catch {
        alert('잘못된 JSON 형식입니다');
        return;
      }
      const res = await fetch(`/api/campaigns/${this.cookieUploadCampaign.id}/upload-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: this.cookieJsonText, senderUsername: this.cookieSenderUsername.replace(/^@/, '') }),
      });
      const data = await res.json();
      if (data.error) {
        this.cookieUploadResult = { status: 'error', message: '오류: ' + data.error };
      } else {
        const msg = data.status === 'valid'
          ? '쿠키 업로드 완료! 상태: 유효함 (Valid)'
          : `쿠키 업로드됨. 상태: ${data.status}` + (data.missingCookies?.length ? ` (누락: ${data.missingCookies.join(', ')})` : '');
        this.cookieUploadResult = { status: data.status, message: msg, expiresAt: data.expiresAt };
        this.load();
      }
    },

    async checkCookieNow(campaign) {
      if (!campaign.sender_username) {
        alert('발송 계정이 설정되지 않았습니다. Cookie 버튼으로 쿠키를 먼저 업로드하세요.');
        return;
      }
      const res = await fetch(`/api/campaigns/${campaign.id}/check-cookies`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        alert(`쿠키 상태: ${data.status}` + (data.missingCookies?.length ? `\n누락: ${data.missingCookies.join(', ')}` : ''));
      } else if (data.error) {
        alert(data.error);
      }
      this.load();
    },
  };
}

// ─── Accounts Page Component ───

function accountsPage() {
  return {
    accounts: [],
    loading: false,
    showAddForm: false,
    showCookieUpload: false,
    cookieUploadAccount: null,
    cookieJsonText: '',
    cookieFileData: null,
    newAccount: { platform: 'instagram', username: '', sessionFile: '' },

    async load() {
      this.loading = true;
      const res = await fetch('/api/dm-accounts');
      const data = await res.json();
      this.accounts = data.accounts;
      this.loading = false;
    },

    async addAccount() {
      if (!this.newAccount.username) { alert('유저명을 입력하세요'); return; }
      await fetch('/api/dm-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.newAccount),
      });
      this.showAddForm = false;
      this.newAccount = { platform: 'instagram', username: '', sessionFile: '' };
      this.load();
    },

    async removeAccount(id) {
      if (!confirm('이 DM 계정을 삭제하시겠습니까?')) return;
      await fetch(`/api/dm-accounts/${id}`, { method: 'DELETE' });
      this.load();
    },

    uploadCookieDialog(account) {
      this.cookieUploadAccount = account;
      this.cookieJsonText = '';
      this.cookieFileData = null;
      this.showCookieUpload = true;
    },

    handleCookieFile(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        this.cookieJsonText = e.target.result;
      };
      reader.readAsText(file);
    },

    async submitCookieUpload() {
      if (!this.cookieUploadAccount || !this.cookieJsonText) {
        alert('쿠키 JSON 데이터를 입력하세요');
        return;
      }
      try {
        JSON.parse(this.cookieJsonText); // validate JSON
      } catch {
        alert('잘못된 JSON 형식입니다');
        return;
      }
      const res = await fetch(`/api/dm-accounts/${this.cookieUploadAccount.id}/upload-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: this.cookieJsonText }),
      });
      const data = await res.json();
      if (data.error) {
        alert('오류: ' + data.error);
      } else {
        alert(`쿠키 업로드 완료. 상태: ${data.status}` + (data.missingCookies?.length ? ` (누락: ${data.missingCookies.join(', ')})` : ''));
        this.showCookieUpload = false;
        this.load();
      }
    },

    async checkCookieNow(account) {
      const res = await fetch(`/api/cookie-health/${account.platform}/${account.username}/check`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        alert(`쿠키 상태: ${data.status}` + (data.missingCookies?.length ? `\n누락: ${data.missingCookies.join(', ')}` : ''));
      }
      this.load();
    },
  };
}

// ─── Profiles Page Component ───

function profilesPage() {
  return {
    platform: 'instagram',
    username: '',
    profiles: [],
    isLoading: false,
    error: null,

    async lookupProfile() {
      if (!this.username) return;

      this.isLoading = true;
      this.error = null;

      try {
        const res = await fetch('/api/jobs/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: this.platform,
            username: this.username,
          }),
        });
        const data = await res.json();
        const jobId = data.jobId;

        // Poll for completion
        await this.waitForJob(jobId);

        // Load profile
        const profileRes = await fetch(`/api/jobs/${jobId}/profiles`);
        const profileData = await profileRes.json();
        if (profileData.profiles.length > 0) {
          this.profiles.unshift(...profileData.profiles);
        } else {
          this.error = '프로필을 찾을 수 없거나 스크래핑에 실패했습니다.';
        }
      } catch (err) {
        this.error = err.message;
      } finally {
        this.isLoading = false;
      }
    },

    async waitForJob(jobId) {
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`/api/jobs/${jobId}`);
        const job = await res.json();
        if (job.status === 'completed') return;
        if (job.status === 'failed') throw new Error(job.error || '작업 실패');
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('작업 시간 초과');
    },
  };
}

// ─── History Page Component ───

function historyPage() {
  return {
    jobs: [],
    total: 0,
    limit: 20,
    offset: 0,

    async load() {
      const res = await fetch(`/api/jobs?limit=${this.limit}&offset=${this.offset}`);
      const data = await res.json();
      this.jobs = data.jobs;
      this.total = data.total;
    },

    async rerun(job) {
      let res;
      if (job.type === 'hashtag') {
        res = await fetch('/api/jobs/hashtag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: job.platform,
            hashtag: job.query,
            maxResults: job.maxResults,
          }),
        });
      } else {
        res = await fetch('/api/jobs/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: job.platform,
            username: job.query,
          }),
        });
      }
      const data = await res.json();
      if (data.jobId) {
        const url = job.type === 'hashtag' ? `/search?jobId=${data.jobId}` : `/profiles?jobId=${data.jobId}`;
        window.location.href = url;
      }
    },

    async remove(jobId) {
      if (!confirm('이 작업과 모든 데이터를 삭제하시겠습니까?')) return;
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      this.load();
    },
  };
}

// ─── Comment Templates Page Component ───

function commentTemplatesPage() {
  return {
    templates: [],
    campaigns: [],
    loading: false,
    showAddForm: false,
    newTemplate: { platform: 'instagram', category: '', template: '', variablesStr: '', campaignId: '' },

    async load() {
      this.loading = true;
      const [tRes, cRes] = await Promise.all([
        fetch('/api/comment-templates'),
        fetch('/api/campaigns'),
      ]);
      const tData = await tRes.json();
      const cData = await cRes.json();
      this.templates = tData.templates;
      this.campaigns = cData.campaigns;
      this.loading = false;
    },

    async addTemplate() {
      if (!this.newTemplate.category || !this.newTemplate.template) {
        alert('카테고리와 템플릿을 입력하세요');
        return;
      }
      const variables = this.newTemplate.variablesStr.split(',').map(s => s.trim()).filter(Boolean);
      await fetch('/api/comment-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: this.newTemplate.platform,
          category: this.newTemplate.category,
          template: this.newTemplate.template,
          variables,
          campaignId: this.newTemplate.campaignId || undefined,
        }),
      });
      this.showAddForm = false;
      this.newTemplate = { platform: 'instagram', category: '', template: '', variablesStr: '', campaignId: '' };
      this.load();
    },

    async removeTemplate(id) {
      if (!confirm('이 템플릿을 삭제하시겠습니까?')) return;
      await fetch(`/api/comment-templates/${id}`, { method: 'DELETE' });
      this.load();
    },
  };
}

// ─── Campaign Live View Component (DB + SSE) ───

function campaignLive(campaignId) {
  return {
    activity: [],
    summary: {},
    liveEvents: [],
    eventSource: null,
    _pollInterval: null,
    _countdownInterval: null,
    currentStatus: '',
    currentPhase: '',
    countdown: 0,

    async init() {
      await this.loadActivity();
      this.connectSSE();
      this._pollInterval = setInterval(() => this.loadActivity(), 8000);
    },

    async loadActivity() {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/activity?limit=50`);
        const data = await res.json();
        this.activity = data.activity;
        this.summary = data.summary;
      } catch { /* ignore */ }
    },

    startCountdown(seconds) {
      if (this._countdownInterval) clearInterval(this._countdownInterval);
      this.countdown = seconds;
      this._countdownInterval = setInterval(() => {
        this.countdown--;
        if (this.countdown <= 0) {
          clearInterval(this._countdownInterval);
          this._countdownInterval = null;
          this.currentStatus = '';
          this.currentPhase = '';
        }
      }, 1000);
    },

    connectSSE() {
      if (this.eventSource) this.eventSource.close();
      this.eventSource = new EventSource(`/api/campaigns/${campaignId}/stream`);

      const ts = () => new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const addLive = (type, data, msg) => {
        this.liveEvents.unshift({ type, ...data, ts: ts(), msg });
        if (this.liveEvents.length > 50) this.liveEvents.pop();
        this.loadActivity();
      };

      this.eventSource.addEventListener('status', (e) => {
        const d = JSON.parse(e.data);
        this.currentStatus = d.message;
        this.currentPhase = d.phase;
        if (d.delaySec) this.startCountdown(d.delaySec);
        else if (d.cooldownMin) this.startCountdown(d.cooldownMin * 60);
        else { this.countdown = 0; }
      });

      this.eventSource.addEventListener('dm_sent', (e) => {
        const d = JSON.parse(e.data);
        this.currentStatus = `@${d.recipient}에게 DM 발송 완료!`;
        this.currentPhase = 'sent';
        this.countdown = 0;
        addLive('dm_sent', d, `DM 발송 → @${d.recipient} (#${d.sentCount})`);
      });
      this.eventSource.addEventListener('dm_failed', (e) => {
        const d = JSON.parse(e.data);
        this.currentStatus = `@${d.recipient} 실패: ${d.error || ''}`;
        this.currentPhase = 'failed';
        this.countdown = 0;
        addLive('dm_failed', d, `실패 → @${d.recipient}: ${d.error || ''}`);
      });
      this.eventSource.addEventListener('engagement', (e) => {
        const d = JSON.parse(e.data);
        let details = [];
        if (d.liked) details.push(d.likedPostUrl ? `좋아요(${d.likedPostUrl.split('/').filter(Boolean).pop()})` : '좋아요');
        if (d.commented) details.push(d.commentText ? `댓글: "${d.commentText.slice(0,30)}"` : '댓글');
        const detailStr = details.join(' + ');
        this.currentStatus = `@${d.recipient} 참여 완료 → ${detailStr}`;
        this.currentPhase = 'engaged';
        addLive('engagement', d, `@${d.recipient} → ${detailStr}`);
      });
      this.eventSource.addEventListener('round_complete', (e) => {
        const d = JSON.parse(e.data);
        this.currentStatus = `라운드 완료: 발송 ${d.sentCount}, 실패 ${d.failedCount}`;
        this.currentPhase = 'round';
        addLive('round_complete', d, `라운드 완료`);
      });

      // Detailed step-by-step progress (DM sending sub-steps)
      this.eventSource.addEventListener('step', (e) => {
        const d = JSON.parse(e.data);
        this.currentStatus = `@${d.recipient}: ${d.detail}`;
        this.currentPhase = d.step || 'dm_step';
        addLive('step', d, `@${d.recipient} → ${d.detail}`);
      });

      this.eventSource.addEventListener('error', () => {
        if (this.eventSource) this.eventSource.close();
        this.eventSource = null;
        setTimeout(() => { if (!this.eventSource) this.connectSSE(); }, 5000);
      });
    },

    destroy() {
      if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
      if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
      if (this._countdownInterval) { clearInterval(this._countdownInterval); this._countdownInterval = null; }
    },
  };
}

// ─── Settings Page Component ───

function settingsPage() {
  return {
    platforms: [],
    campaignCookies: [],

    async load() {
      const [platformRes, campaignRes] = await Promise.all([
        fetch('/api/platforms'),
        fetch('/api/campaigns'),
      ]);
      const platformData = await platformRes.json();
      const campaignData = await campaignRes.json();
      this.platforms = platformData.platforms;
      this.campaignCookies = campaignData.campaigns || [];
    },

    async checkCampaignCookie(campaign) {
      if (!campaign.sender_username) {
        alert('발송 계정이 설정되지 않았습니다.');
        return;
      }
      const res = await fetch(`/api/campaigns/${campaign.id}/check-cookies`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        alert(`쿠키 상태: ${data.status}` + (data.missingCookies?.length ? `\n누락: ${data.missingCookies.join(', ')}` : ''));
      } else if (data.error) {
        alert(data.error);
      }
      this.load();
    },
  };
}

// ─── Cookie Health Banner Component (Dashboard) ───

function cookieHealthBanner() {
  return {
    expiredAccounts: [],
    eventSource: null,

    async init() {
      // Load initial state
      try {
        const res = await fetch('/api/cookie-health');
        const data = await res.json();
        this.expiredAccounts = (data.accounts || []).filter(a => a.cookie_status === 'expired');
      } catch { /* ignore */ }

      // Subscribe to SSE for real-time updates
      this.eventSource = new EventSource('/api/cookie-health/stream');

      this.eventSource.addEventListener('status_change', (e) => {
        const status = JSON.parse(e.data);
        // Update or add to list
        const idx = this.expiredAccounts.findIndex(a => a.platform === status.platform && a.username === status.username);
        if (status.status === 'expired') {
          if (idx === -1) {
            this.expiredAccounts.push(status);
          } else {
            this.expiredAccounts[idx] = status;
          }
        } else {
          // Remove if no longer expired
          if (idx !== -1) {
            this.expiredAccounts.splice(idx, 1);
          }
        }
      });

      this.eventSource.addEventListener('expired', (e) => {
        const data = JSON.parse(e.data);
        const exists = this.expiredAccounts.some(a => a.platform === data.platform && a.username === data.username);
        if (!exists) {
          this.expiredAccounts.push({ platform: data.platform, username: data.username, status: 'expired', missingCookies: [] });
        }
      });

      this.eventSource.addEventListener('error', () => {
        // SSE connection error — will auto-reconnect
      });
    },
  };
}

// ─── Live Dashboard Component ───

function liveDashboard() {
  return {
    stats: {
      totalInfluencers: 0,
      aiClassified: 0,
      activeCampaigns: 0,
      totalCampaigns: 0,
      totalSent: 0,
      totalFailed: 0,
      totalPending: 0,
      activeKeywords: 0,
      totalExtracted: 0,
    },
    keywords: [],
    campaigns: [],
    platforms: [],
    expiredCookies: [],
    activities: [],
    _sse: null,
    _refreshInterval: null,

    async init() {
      await this.loadData();
      await this.loadRecentActivity();
      this.connectSSE();
      // Auto-refresh every 30 seconds
      this._refreshInterval = setInterval(() => this.loadData(), 30000);
    },

    async loadRecentActivity() {
      try {
        const res = await fetch('/api/dashboard/activity?limit=30');
        const data = await res.json();
        if (data.activities && data.activities.length > 0) {
          const ts = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          this.activities = data.activities.map(a => ({
            type: a.type,
            message: a.message,
            ts: ts(a.ts),
          }));
        }
      } catch (err) {
        console.warn('[liveDashboard] loadRecentActivity error:', err);
      }
    },

    async loadData() {
      try {
        const [statsRes, keywordsRes, campaignsRes, platformsRes, cookieRes] = await Promise.all([
          fetch('/api/dashboard/stats'),
          fetch('/api/keywords'),
          fetch('/api/campaigns'),
          fetch('/api/platforms'),
          fetch('/api/cookie-health'),
        ]);

        const statsData = await statsRes.json();
        const keywordsData = await keywordsRes.json();
        const campaignsData = await campaignsRes.json();
        const platformsData = await platformsRes.json();
        const cookieData = await cookieRes.json();

        // Stats from aggregate endpoint
        this.stats.totalInfluencers = statsData.totalInfluencers || 0;
        this.stats.aiClassified = statsData.aiClassified || 0;
        this.stats.activeCampaigns = statsData.activeCampaigns || 0;
        this.stats.totalCampaigns = statsData.totalCampaigns || 0;
        this.stats.totalSent = statsData.totalSent || 0;
        this.stats.totalFailed = statsData.totalFailed || 0;
        this.stats.totalPending = statsData.totalPending || 0;
        this.stats.activeKeywords = statsData.activeKeywords || 0;
        this.stats.totalExtracted = statsData.totalExtracted || 0;

        // Keywords
        this.keywords = keywordsData.targets || [];

        // Campaigns
        this.campaigns = campaignsData.campaigns || [];

        // Platforms
        this.platforms = platformsData.platforms || [];

        // Cookie health
        this.expiredCookies = (cookieData.accounts || []).filter(a => a.cookie_status === 'expired');
      } catch (err) {
        console.warn('[liveDashboard] loadData error:', err);
      }
    },

    connectSSE() {
      this._sse = new EventSource('/api/global/stream');
      const ts = () => new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' });

      this._sse.addEventListener('scraping_started', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'scraping_started', message: `스크래핑 시작: ${d.keyword || ''} (${d.platform || ''})`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
        // Mark keyword as running
        const kw = this.keywords.find(k => k.pairId === d.pairId);
        if (kw) { kw._running = true; kw._phase = '시작...'; }
      });

      this._sse.addEventListener('scraping_completed', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'scraping_completed', message: `스크래핑 완료: ${d.postsCount || 0}P, ${d.profilesCount || 0}명`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
        const kw = this.keywords.find(k => k.pairId === d.pairId);
        if (kw) { kw._running = false; kw._phase = ''; }
        // Refresh data to update counts
        this.loadData();
      });

      this._sse.addEventListener('auto_assign', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'auto_assign', message: `캠페인 자동 배정: ${d.assigned || 0}명`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
      });

      this._sse.addEventListener('cookie_warning', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'cookie_warning', message: `쿠키 경고: @${d.username} (${d.platform})`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
      });

      this._sse.addEventListener('cookie_expired', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'cookie_expired', message: `쿠키 만료: @${d.username} (${d.platform})`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
        this.loadData();
      });

      this._sse.addEventListener('dm_sent', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'dm_sent', message: `DM 발송: @${d.recipient} (${d.campaign || d.platform})`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
      });

      this._sse.addEventListener('dm_failed', (e) => {
        const d = JSON.parse(e.data);
        this.activities.unshift({ type: 'dm_failed', message: `DM 실패: @${d.recipient} (${d.campaign || d.platform})`, ts: ts() });
        if (this.activities.length > 50) this.activities.pop();
      });

      this._sse.onerror = () => {
        // Will auto-reconnect
      };
    },
  };
}
