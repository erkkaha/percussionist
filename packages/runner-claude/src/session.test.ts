// Wiring tests for the transient-retry path in RunSession.
//
// The classifier and the transcript flag are unit-tested next door; what those
// cannot catch is the loop that joins them — whether a retried turn really is
// re-driven, whether `idle` leaks out mid-retry (which would have the
// dispatcher settle the run), and whether the budget is honoured. Both
// production failures were in wiring, not in a predicate.
//
// Env is set before importing session.js so the module-level constants pick it
// up, which also keeps the backoff at ~1ms instead of 5s.
process.env.CLAUDE_MAX_TRANSIENT_RETRIES = '2';
process.env.CLAUDE_RETRY_BASE_MS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';

/** Messages the fake SDK query will yield, in order. */
let scripted: unknown[] = [];
/** User messages the session pushed back into the input queue. */
let enqueued: string[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ message?: { content?: string } }> }) => {
    // Drain the input queue in the background, exactly as the real SDK does.
    void (async () => {
      for await (const m of prompt) {
        const content = m?.message?.content;
        if (typeof content === 'string') enqueued.push(content);
      }
    })();

    return (async function* gen() {
      for (const msg of scripted) {
        // Yield across ticks so the session's retry timer can fire between
        // messages, the way it does against a real stream.
        await new Promise((r) => setTimeout(r, 5));
        yield msg;
      }
      // Stay open afterwards so a retried turn has a live loop to land in,
      // matching the SDK's streaming-input behaviour.
      await new Promise((r) => setTimeout(r, 40));
    })();
  },
}));

const { RunSession } = await import('./session.js');

const overloaded = (uuid: string) => ({
  type: 'result',
  uuid,
  session_id: 'sdk-1',
  is_error: true,
  result: 'API Error: 529 Overloaded',
  api_error_status: 529,
  usage: {},
});

const assistantText = (text: string) => ({
  type: 'assistant',
  uuid: `a-${text}`,
  session_id: 'sdk-1',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
});

function makeSession() {
  return new RunSession(
    { cwd: '/workspace', permissionMode: 'bypassPermissions' as never },
    'sess-1',
  );
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('RunSession transient retry', () => {
  beforeEach(() => {
    scripted = [];
    enqueued = [];
  });

  it('re-drives the turn and keeps the error out of the transcript', async () => {
    scripted = [assistantText('working'), overloaded('r1')];
    const s = makeSession();
    const idle: unknown[] = [];
    s.subscribe((event, data) => {
      if (event === 'idle') idle.push(data);
    });

    s.startOrSend('do the task');
    await settle();

    const last = s.messages()[s.messages().length - 1];
    expect(last?.info.error).toBeUndefined();
    // The original prompt plus one continuation.
    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]).toContain('transient API error');
    // Settling mid-retry would have polling.ts declare the run finished.
    expect(idle).toHaveLength(0);
  });

  it('records the error once the retry budget is spent', async () => {
    // Budget is 2, so a third failure has to be terminal.
    scripted = [assistantText('working'), overloaded('r1'), overloaded('r2'), overloaded('r3')];
    const s = makeSession();
    const idle: unknown[] = [];
    s.subscribe((event) => {
      if (event === 'idle') idle.push(event);
    });

    s.startOrSend('do the task');
    await settle(300);

    const last = s.messages()[s.messages().length - 1];
    expect(last?.info.error).toMatchObject({ status: 529 });
    // Two retries taken, and no more.
    expect(enqueued).toHaveLength(3);
    expect(idle).toHaveLength(1);
  });

  it('does not retry an error that would fail identically', async () => {
    scripted = [
      assistantText('working'),
      {
        type: 'result',
        uuid: 'r1',
        session_id: 'sdk-1',
        is_error: true,
        result: 'API Error: 401 authentication_error',
        api_error_status: 401,
        usage: {},
      },
    ];
    const s = makeSession();
    s.startOrSend('do the task');
    await settle();

    expect(s.messages()[s.messages().length - 1]?.info.error).toMatchObject({ status: 401 });
    expect(enqueued).toHaveLength(1);
  });

  it('leaves a successful turn alone', async () => {
    scripted = [
      assistantText('done'),
      { type: 'result', uuid: 'r1', session_id: 'sdk-1', is_error: false, usage: {} },
    ];
    const s = makeSession();
    const idle: unknown[] = [];
    s.subscribe((event) => {
      if (event === 'idle') idle.push(event);
    });

    s.startOrSend('do the task');
    await settle();

    expect(s.messages()[s.messages().length - 1]?.info.error).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(idle).toHaveLength(1);
  });
});
