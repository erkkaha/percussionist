export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface PollingSseOptions {
  signal: AbortSignal;
  getSignature: () => Promise<string>;
  updatedEvent: string;
  errorEvent?: string;
  readyEvent?: SseEvent;
  pollIntervalMs?: number;
  keepAliveMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_KEEPALIVE_MS = 15_000;

export function sseHeaders(): Headers {
  const headers = new Headers();
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'off');
  return headers;
}

export function sseEventChunk(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createPollingSseResponse(opts: PollingSseOptions): Response {
  const encoder = new TextEncoder();
  const {
    signal,
    getSignature,
    updatedEvent,
    errorEvent,
    readyEvent,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
  } = opts;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let polling = false;
      let lastSignature = '';
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const onAbort = () => cleanup();
      signal.addEventListener('abort', onAbort, { once: true });

      const enqueue = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const signature = await getSignature();
          if (signature !== lastSignature) {
            lastSignature = signature;
            enqueue(sseEventChunk(updatedEvent, { at: Date.now() }));
          }
        } catch {
          if (errorEvent) {
            enqueue(sseEventChunk(errorEvent, { at: Date.now() }));
          }
        } finally {
          polling = false;
        }
      };

      if (readyEvent) {
        enqueue(sseEventChunk(readyEvent.event, readyEvent.data));
      }
      void poll();

      pollTimer = setInterval(() => {
        void poll();
      }, pollIntervalMs);

      keepAliveTimer = setInterval(() => {
        enqueue(`: keepalive ${Date.now()}\n\n`);
      }, keepAliveMs);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(),
  });
}
