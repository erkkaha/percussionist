// sse-name-events.test.ts — nameSseEventsByType, the transform the run events
// proxy pipes the runner's /event stream through.
//
// The runners send `data: {"type":...}` frames with no `event:` line, and the
// browser only dispatches EventSource listeners for named frames. The
// transform must name frames after their JSON type, leave already-named and
// non-JSON frames alone, and cope with frames split across chunks.

import { describe, expect, it } from 'bun:test';
import { nameSseEventsByType } from '../src/server/lib/sse.js';

async function run(chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const out = source.pipeThrough(nameSseEventsByType());
  return await new Response(out).text();
}

describe('nameSseEventsByType', () => {
  it('names an unnamed JSON frame after its type', async () => {
    const out = await run(['data: {"type":"message.updated","properties":{}}\n\n']);
    expect(out).toBe(
      'event: message.updated\ndata: {"type":"message.updated","properties":{}}\n\n',
    );
  });

  it('leaves already-named frames and non-JSON frames alone', async () => {
    const out = await run(['event: ping\ndata: \n\n', 'data: not json\n\n', ': comment\n\n']);
    expect(out).toBe('event: ping\ndata: \n\n' + 'data: not json\n\n' + ': comment\n\n');
  });

  it('reassembles a frame split across chunks and handles several per chunk', async () => {
    const out = await run([
      'data: {"type":"sess',
      'ion.idle"}\n\ndata: {"type":"server.connected"}\n\nda',
      'ta: {"type":"permission.updated"}\n\n',
    ]);
    expect(out).toBe(
      'event: session.idle\ndata: {"type":"session.idle"}\n\n' +
        'event: server.connected\ndata: {"type":"server.connected"}\n\n' +
        'event: permission.updated\ndata: {"type":"permission.updated"}\n\n',
    );
  });

  it('flushes a trailing frame without a terminator when the stream ends', async () => {
    const out = await run(['data: {"type":"session.idle"}']);
    expect(out).toBe('event: session.idle\ndata: {"type":"session.idle"}\n\n');
  });

  it('refuses a type that would break framing', async () => {
    const out = await run(['data: {"type":"bad\\nevent"}\n\n']);
    expect(out).toBe('data: {"type":"bad\\nevent"}\n\n');
  });
});
