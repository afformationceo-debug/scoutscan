import { Hono } from 'hono';
import { jobManager } from '../services/job-manager.js';

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

export { sse };
