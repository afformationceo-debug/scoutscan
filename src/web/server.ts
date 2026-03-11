import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { api } from './routes/api.js';
import { sse } from './routes/sse.js';
import { pages } from './routes/pages.js';
import { recoverStuckJobs } from './services/db.js';

const app = new Hono();

// Middleware
app.use('*', cors());

// Static files
app.use('/public/*', serveStatic({ root: 'src/web/' }));

// API routes
app.route('/api', api);
app.route('/api', sse);

// Page routes
app.route('/', pages);

// Recover jobs stuck from previous server crash
const recovered = recoverStuckJobs();
if (recovered > 0) console.log(`Recovered ${recovered} stuck job(s) from previous session.`);

// Start server
const port = parseInt(process.env.PORT || '3000');

serve({ fetch: app.fetch, port, serverOptions: { maxHeaderSize: 65536 } }, (info) => {
  console.log(`
  Social Scraper Dashboard
  ========================
  Server running at http://localhost:${info.port}

  Pages:
    /          - Dashboard
    /search    - Hashtag Search
    /profiles  - Profile Lookup
    /history   - Scraping History
    /settings  - Cookie Settings
  `);
});
