import { Hono } from 'hono';
import { jobManager } from '../services/job-manager.js';
import { sseManager } from '../services/sse-manager.js';
import { db } from '../services/db.js';

const sse = new Hono();

sse.get('/jobs/:id/stream', (c) => {
  const jobId = c.req.param('id');

  const stream = new ReadableStream({
    start(controller) {
      const clientId = jobManager.addSSEClient(jobId, controller);

      // Send keepalive every 15s
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        jobManager.removeSSEClient(clientId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ─── Campaign SSE Stream ───

sse.get('/campaigns/:id/stream', (c) => {
  const campaignId = c.req.param('id');

  const stream = new ReadableStream({
    start(controller) {
      const clientId = sseManager.addClient('campaign:' + campaignId, controller);

      // Send immediate connection confirmation with current campaign state
      try {
        const campaign = db.prepare('SELECT status, total_sent, total_failed, total_queued FROM dm_campaigns WHERE id = ?').get(campaignId) as any;
        if (campaign) {
          const initPayload = `event: status\ndata: ${JSON.stringify({
            phase: campaign.status === 'active' ? 'processing' : 'idle',
            message: campaign.status === 'active' ? '캠페인 진행 중...' : `캠페인 상태: ${campaign.status}`,
            sentCount: campaign.total_sent,
            failedCount: campaign.total_failed,
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(initPayload));
        }
      } catch { /* ignore init errors */ }

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        sseManager.removeClient(clientId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ─── Global Notification SSE Stream ───

sse.get('/global/stream', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const clientId = sseManager.addClient('global', controller);

      // Send connection confirmation
      try {
        const initPayload = `event: connected\ndata: ${JSON.stringify({ message: 'Global notification stream connected' })}\n\n`;
        controller.enqueue(new TextEncoder().encode(initPayload));
      } catch { /* ignore init errors */ }

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        sseManager.removeClient(clientId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// ─── Cookie Health SSE Stream ───

sse.get('/cookie-health/stream', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const clientId = sseManager.addClient('cookie-health', controller);

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        sseManager.removeClient(clientId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

export { sse };
