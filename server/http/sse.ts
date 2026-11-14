/** Server-Sent Events helpers: heartbeat, safe writes, and clean teardown. */
import type { Response } from 'express';
import type { StreamEvent } from '../../shared/types.js';

export interface SseChannel {
  send: (event: StreamEvent) => void;
  comment: (text: string) => void;
  close: () => void;
  readonly closed: boolean;
}

export function openSse(res: Response): SseChannel {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  // Keep intermediaries from closing an idle stream during a long retrieval.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': keep-alive\n\n');
    } catch {
      closed = true;
    }
  }, 15_000);
  heartbeat.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    send(event: StreamEvent) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    comment(text: string) {
      if (closed) return;
      try {
        res.write(`: ${text}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* already ended */
      }
    },
    get closed() {
      return closed;
    },
  };
}
