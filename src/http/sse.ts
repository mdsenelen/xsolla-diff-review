import type { FastifyReply } from 'fastify';
import type { Job, SseEvent, SseListener } from '../core/types.js';
import { replay, subscribe } from '../core/jobStore.js';

function formatEvent(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

// The 'done' event is always the last event of a successful run; a
// 'status: failed' event is always the last event of a failed run (failJob
// never emits a 'done' event). Either marks the log as exhausted.
function isTerminalEvent(event: SseEvent): boolean {
  return event.event === 'done' || (event.event === 'status' && event.status === 'failed');
}

export function handleSseStream(job: Job, reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let unsubscribe: (() => void) | undefined;
  const listener: SseListener = (event) => {
    reply.raw.write(formatEvent(event));
    if (isTerminalEvent(event)) {
      unsubscribe?.();
      reply.raw.end();
    }
  };

  // Replaying alone fully serves an already-finished job: the terminal event
  // in the log triggers reply.raw.end() above.
  replay(job, listener);

  if (job.status !== 'done' && job.status !== 'failed') {
    unsubscribe = subscribe(job, listener);
    reply.raw.on('close', () => {
      unsubscribe?.();
    });
  }
}
