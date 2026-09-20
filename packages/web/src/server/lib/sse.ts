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

/**
 * Give unnamed SSE frames an `event:` name taken from their JSON `type`.
 *
 * The runners' `/event` streams (opencode v1, runner-claude, runner-opencode)
 * send `data: {"type":"message.updated",...}` with no `event:` line. The
 * browser's EventSource only dispatches `addEventListener('message.updated')`
 * for frames that carry that name; unnamed frames go to `onmessage`, which
 * nothing listens to — so the run page never refetched on agent activity and
 * a reply showed up only when something else happened to refetch. Frames that
 * already have a name (`event: ping`) and non-JSON frames pass through as-is.
 */
export function nameSseEventsByType(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const nameFrame = (frame: string): string => {
    const lines = frame.split('\n');
    if (lines.some((l) => l.startsWith('event:'))) return frame;
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return frame;
    try {
      const type = (JSON.parse(data) as { type?: unknown }).type;
      if (typeof type === 'string' && type && !/[\r\n]/.test(type)) {
        return `event: ${type}\n${frame}`;
      }
    } catch {
      // Not JSON; leave the frame alone.
    }
    return frame;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Frames end with a blank line; the runners write \n\n. Tolerate \r\n.
      let idx = buffer.search(/\r?\n\r?\n/);
      while (idx !== -1) {
        const match = /\r?\n\r?\n/.exec(buffer.slice(idx)) as RegExpExecArray;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + match[0].length);
        controller.enqueue(encoder.encode(`${nameFrame(frame)}\n\n`));
        idx = buffer.search(/\r?\n\r?\n/);
      }
    },
    flush(controller) {
      const rest = buffer + decoder.decode();
      if (rest.trim()) controller.enqueue(encoder.encode(`${nameFrame(rest)}\n\n`));
    },
  });
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
