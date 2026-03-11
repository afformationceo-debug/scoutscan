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
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function exportJob(jobId, format) {
  window.location.href = `/api/jobs/${jobId}/export?format=${format}`;
}

// ─── Alpine.js Global App ───

function app() {
  return {};
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
      const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      this.addLog(`Starting search: #${this.hashtag} (max ${this.maxResults})`);

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
            this.addLog(`Posts collected: ${data.count} / ${data.total}`);
          }
        }
        this.isSearching = true;
      });

      this.eventSource.addEventListener('profile_start', (e) => {
        const data = JSON.parse(e.data);
        this.profilePhase = true;
        this.profileTotal = data.total;
        this.profileSkipped = data.skipped || 0;
        this.addLog(`Phase 2: ${data.total} profiles to enrich` + (data.skipped ? ` (${data.skipped} skipped - already exist)` : ''));
      });

      this.eventSource.addEventListener('profile', (e) => {
        const profile = JSON.parse(e.data);
        this.profiles.push(profile);
        this.profileCount++;
        if (this.profileCount % 10 === 0 || this.profileCount === 1) {
          this.addLog(`Profile enriched: @${profile.username} (${this.profileCount}/${this.profileTotal})`);
        }
      });

      this.eventSource.addEventListener('profile_error', (e) => {
        const data = JSON.parse(e.data);
        this.profileErrors++;
        this.addLog(`Profile failed: @${data.username} - ${data.error}`);
      });

      this.eventSource.addEventListener('profile_pause', (e) => {
        this.profilePaused = true;
        const data = JSON.parse(e.data);
        this.addLog(`Pausing ${data.pauseSeconds}s to recover from consecutive failures...`);
        setTimeout(() => { this.profilePaused = false; }, (data.pauseSeconds || 30) * 1000);
      });

      this.eventSource.addEventListener('profile_retry', (e) => {
        const data = JSON.parse(e.data);
        this.profileRetrying = true;
        this.addLog(`Retrying ${data.count} failed profiles...`);
      });

      this.eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        this.isSearching = false;
        this.profileRetrying = false;
        this.addLog(`Complete! Posts: ${data.postsCount || data.resultCount}, Profiles: ${data.profilesCount || 0}`);
        this.eventSource.close();
        this.eventSource = null;
      });

      this.eventSource.addEventListener('error', (e) => {
        if (e.data) {
          const data = JSON.parse(e.data);
          this.addLog(`Error: ${data.message}`);
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
          if (data.status === 'failed') this.addLog(`Job failed: ${data.error || 'Unknown error'}`);
        } else if (data.status === 'running') {
          this.isSearching = true;
          this.addLog('Job started running...');
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

// ─── Master Data Page Component ───

function dataPage() {
  return {
    profiles: [],
    stats: [],
    total: 0,
    totalAll: 0,
    platform: '',
    search: '',
    sortBy: 'followers',
    order: 'desc',
    limit: 100,
    offset: 0,
    loading: false,
    missingProfiles: {},
    enriching: false,
    enrichCount: 0,
    enrichTotal: 0,
    enrichErrors: 0,
    enrichPaused: false,
    enrichRetrying: false,
    enrichLogs: [],
    enrichEventSource: null,

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

      const [profileRes, statsRes, missingRes] = await Promise.all([
        fetch(`/api/profiles?${params}`),
        fetch('/api/profiles/stats'),
        fetch('/api/profiles/missing'),
      ]);
      const profileData = await profileRes.json();
      const statsData = await statsRes.json();
      const missingData = await missingRes.json();

      this.profiles = profileData.profiles;
      this.total = profileData.total;
      this.stats = statsData.stats;
      this.totalAll = statsData.stats.reduce((sum, s) => sum + s.count, 0);
      this.missingProfiles = missingData.missing || {};
      this.loading = false;
    },

    addEnrichLog(msg) {
      const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      this.addEnrichLog(`Starting re-enrichment for ${targetPlatform}...`);

      const res = await fetch('/api/jobs/re-enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: targetPlatform }),
      });
      const data = await res.json();

      if (!data.jobId) {
        this.addEnrichLog(`Error: ${data.error}`);
        this.enriching = false;
        return;
      }

      this.addEnrichLog(`Job started: ${data.missingCount} profiles to enrich`);
      this.connectEnrichSSE(data.jobId);
    },

    connectEnrichSSE(jobId) {
      if (this.enrichEventSource) this.enrichEventSource.close();
      this.enrichEventSource = new EventSource(`/api/jobs/${jobId}/stream`);

      this.enrichEventSource.addEventListener('profile_start', (e) => {
        const data = JSON.parse(e.data);
        this.enrichTotal = data.total;
        this.addEnrichLog(`${data.total} profiles to enrich`);
      });

      this.enrichEventSource.addEventListener('profile', (e) => {
        const profile = JSON.parse(e.data);
        this.enrichCount++;
        if (this.enrichCount % 5 === 0 || this.enrichCount === 1) {
          this.addEnrichLog(`Enriched @${profile.username} (${this.enrichCount}/${this.enrichTotal})`);
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
        this.addEnrichLog(`Failed @${data.username}: ${data.error}`);
      });

      this.enrichEventSource.addEventListener('profile_pause', (e) => {
        this.enrichPaused = true;
        const data = JSON.parse(e.data);
        this.addEnrichLog(`Pausing ${data.pauseSeconds}s...`);
        setTimeout(() => { this.enrichPaused = false; }, (data.pauseSeconds || 30) * 1000);
      });

      this.enrichEventSource.addEventListener('profile_retry', (e) => {
        const data = JSON.parse(e.data);
        this.enrichRetrying = true;
        this.addEnrichLog(`Retrying ${data.count} failed profiles...`);
      });

      this.enrichEventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        this.enriching = false;
        this.enrichRetrying = false;
        this.addEnrichLog(`Complete! ${data.profilesCount} profiles enriched.`);
        this.enrichEventSource.close();
        this.enrichEventSource = null;
        // Reload data
        this.load();
      });

      this.enrichEventSource.addEventListener('error', (e) => {
        if (e.data) {
          const data = JSON.parse(e.data);
          this.addEnrichLog(`Error: ${data.message}`);
        }
        this.enriching = false;
        this.enrichEventSource.close();
        this.enrichEventSource = null;
      });
    },

    exportAll(format) {
      // TODO: implement master export
      alert('Export coming soon. Use per-job export from History page for now.');
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
          this.error = 'Profile not found or scraping failed.';
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
        if (job.status === 'failed') throw new Error(job.error || 'Job failed');
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('Job timed out');
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
      if (!confirm('Delete this job and all its data?')) return;
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      this.load();
    },
  };
}

// ─── Settings Page Component ───

function settingsPage() {
  return {
    platforms: [],

    async load() {
      const res = await fetch('/api/platforms');
      const data = await res.json();
      this.platforms = data.platforms;
    },
  };
}
