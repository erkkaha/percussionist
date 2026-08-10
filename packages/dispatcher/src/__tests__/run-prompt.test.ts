import { describe, expect, it, spyOn } from 'bun:test';
import type { CoreV1Api } from '@kubernetes/client-node';
import {
  FatalRunError,
  type PromptPostResult,
  type RunPromptDeps,
  resolveHardTimeoutMs,
  runInteractive,
  runPrompt,
} from '../polling.js';
import type { RawMessage } from '../session.js';

// Race-path coverage for runPrompt, the prompt-POST retry matrix and the
// hard-timeout guard. Every network/timing dependency is injected via the
// optional `deps` param (postMessage, fetchMessages, checkHealth, sleep, now,
// patchStatus, snapshot, sendStats, createSession, hardTimeoutMs), so each of
// the five Promise.race outcomes — completion, failure, plan, abort, race
// error — plus the ECONNRESET retry cases and the snapshot-less hard-timeout
// regression are exercised deterministically without a cluster or server.
//
// The runPrompt SSE stream and periodic-snapshot background loops hit global
// fetch; the 503 stub keeps them spinning quietly until terminate is set.

// FIRST_RESPONSE_TIMEOUT_MS / HARD_TIMEOUT_MS from polling.ts (module-private;
// kept in sync).
const FIRST_RESPONSE_TIMEOUT_MS = 3_600_000;
const HARD_TIMEOUT_MS = FIRST_RESPONSE_TIMEOUT_MS + 300_000;

const okPost = async (): Promise<PromptPostResult> => ({
  ok: true,
  status: 200,
  json: async () => ({ info: {}, parts: [] }),
  text: async () => '',
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  patches: object[];
  stats: Array<{ phase: string; message?: string }>;
  sleeps: number[];
  snapshotCalls: number;
  postCalls: number;
  completion: ReturnType<typeof deferred<string>>;
  failure: ReturnType<typeof deferred<string>>;
  plan: ReturnType<typeof deferred<string>>;
  run: () => Promise<{ sessionID: string; startedAt: string }>;
}

interface HarnessOpts {
  postMessage?: (sid: string, body: Record<string, unknown>) => Promise<PromptPostResult>;
  fetchMessages?: (sid: string, call: number) => Promise<RawMessage[]>;
  checkHealth?: () => Promise<boolean>;
  now?: () => number;
  withPlan?: boolean;
  hardTimeoutMs?: number;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const patches: object[] = [];
  const stats: Array<{ phase: string; message?: string }> = [];
  const sleeps: number[] = [];
  let snapshotCalls = 0;
  let postCalls = 0;
  let fetchCalls = 0;

  const completion = deferred<string>();
  const failure = deferred<string>();
  const plan = deferred<string>();

  const postMessage: RunPromptDeps['postMessage'] = async (sid, body) => {
    postCalls++;
    return opts.postMessage ? opts.postMessage(sid, body) : okPost();
  };
  const fetchMessages: RunPromptDeps['fetchMessages'] = async (sid) => {
    fetchCalls++;
    return opts.fetchMessages ? opts.fetchMessages(sid, fetchCalls) : [];
  };
  const checkHealth: RunPromptDeps['checkHealth'] = async () =>
    opts.checkHealth ? opts.checkHealth() : true;

  const deps: RunPromptDeps = {
    postMessage,
    fetchMessages,
    checkHealth,
    // Yield to the event loop (real setTimeout(0)) instead of resolving as a
    // pure microtask. runPrompt runs background loops (streamEvents,
    // periodicSnapshot) that otherwise spin as an endless microtask chain and
    // starve the timer phase — the hard-timeout timer, deferred completion
    // signals and the runInteractive shutdown interval would never fire.
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 0));
    },
    now: opts.now,
    snapshot: async () => {
      snapshotCalls++;
    },
    sendStats: async (_sessionID, phase, _startedAt, _completedAt, _totals, sessionError) => {
      stats.push({ phase, message: sessionError });
    },
    createSession: async () => ({ id: 'sess-1' }),
    ...(opts.hardTimeoutMs !== undefined ? { hardTimeoutMs: opts.hardTimeoutMs } : {}),
  };

  const run = () =>
    runPrompt(
      async (p) => {
        patches.push(p);
      },
      () => false,
      async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 0));
      },
      {} as CoreV1Api, // snapshot is injected; coreApi is unused
      'run-1',
      'ns',
      'uid',
      failure.promise,
      completion.promise,
      opts.withPlan ? plan.promise : undefined,
      deps,
    );

  return {
    patches,
    stats,
    sleeps,
    // Live getters: the counters are closure locals, so returning them by
    // value would snapshot 0 at harness creation.
    get snapshotCalls() {
      return snapshotCalls;
    },
    get postCalls() {
      return postCalls;
    },
    completion,
    failure,
    plan,
    run,
  };
}

const succeededPatch = (patches: object[]): { message?: string } | undefined =>
  patches.find((p) => (p as { phase?: string }).phase === 'Succeeded') as
    | { message?: string }
    | undefined;

describe('resolveHardTimeoutMs', () => {
  it('derives the deadline from timeoutSeconds minus the grace lead', () => {
    expect(resolveHardTimeoutMs('3600')).toBe(3_540_000);
    expect(resolveHardTimeoutMs('120')).toBe(60_000);
  });

  it('floors tiny timeouts at the 30s boot window', () => {
    expect(resolveHardTimeoutMs('30')).toBe(30_000);
    expect(resolveHardTimeoutMs('1')).toBe(30_000);
  });

  it('falls back to the legacy HARD_TIMEOUT_MS for missing or invalid values', () => {
    // envSeconds === undefined reads process.env.RUN_TIMEOUT_SECONDS, which is
    // unset at module scope in this file (each env test restores it).
    expect(resolveHardTimeoutMs(undefined)).toBe(HARD_TIMEOUT_MS);
    expect(resolveHardTimeoutMs('')).toBe(HARD_TIMEOUT_MS);
    expect(resolveHardTimeoutMs('abc')).toBe(HARD_TIMEOUT_MS);
    expect(resolveHardTimeoutMs('0')).toBe(HARD_TIMEOUT_MS);
    expect(resolveHardTimeoutMs('-5')).toBe(HARD_TIMEOUT_MS);
  });

  it('reads RUN_TIMEOUT_SECONDS from the environment when no arg is given', () => {
    const prev = process.env.RUN_TIMEOUT_SECONDS;
    process.env.RUN_TIMEOUT_SECONDS = '1800';
    try {
      expect(resolveHardTimeoutMs()).toBe(1_740_000);
    } finally {
      if (prev === undefined) delete process.env.RUN_TIMEOUT_SECONDS;
      else process.env.RUN_TIMEOUT_SECONDS = prev;
    }
  });
});

describe('runPrompt race outcomes', () => {
  it('patches Succeeded with the agent summary, reports Succeeded stats and snapshots when complete_run wins', async () => {
    const h = makeHarness();
    h.completion.resolve('build done');
    const result = await h.run();

    expect(result.sessionID).toBe('sess-1');
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(h.patches).toContainEqual(
      expect.objectContaining({ phase: 'Running', sessionID: 'sess-1' }),
    );
    expect(succeededPatch(h.patches)?.message).toContain('agent signalled completion — build done');
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Succeeded' }));
    expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
  });

  it('throws a session error and reports Failed stats when fail_run wins', async () => {
    const h = makeHarness();
    h.failure.resolve('the agent bailed');
    const err = await h.run().catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      'session error: agent signalled failure — the agent bailed',
    );
    expect(h.stats).toContainEqual(
      expect.objectContaining({
        phase: 'Failed',
        message: 'session error: agent signalled failure — the agent bailed',
      }),
    );
    expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
  });

  it('patches Succeeded with the plan summary when complete_plan wins', async () => {
    const h = makeHarness({ withPlan: true });
    h.plan.resolve('plan ready');
    const result = await h.run();

    expect(result.sessionID).toBe('sess-1');
    expect(succeededPatch(h.patches)?.message).toContain('agent signalled completion — plan ready');
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Succeeded' }));
  });

  it('keeps the run Running and patches "waiting for input (message aborted)" when the race sees a MessageAbortedError', async () => {
    const h = makeHarness({
      postMessage: async () => {
        throw new Error('MessageAbortedError');
      },
    });
    const result = await h.run();

    expect(result.sessionID).toBe('sess-1');
    expect(h.patches).toContainEqual(
      expect.objectContaining({ phase: 'Running', message: 'waiting for input (message aborted)' }),
    );
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Running' }));
    // The abort is not a failure: the run must not be marked Failed.
    expect(h.patches.some((p) => (p as { phase?: string }).phase === 'Failed')).toBe(false);
  });

  it('reports Failed stats with the race error and rethrows when the poll loop throws a FatalRunError', async () => {
    const h = makeHarness({
      checkHealth: async () => false,
    });
    const err = await h.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FatalRunError);
    expect((err as Error).message).toContain('health check failed');
    expect(h.stats).toContainEqual(
      expect.objectContaining({ phase: 'Failed', message: (err as Error).message }),
    );
    expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
  });

  it('reports Failed stats and rethrows when the poll loop hits the first-response timeout', async () => {
    // now() call order inside runPrompt: runStartedAt, then the poll loop's
    // startedAt, then the per-tick elapsed check.
    let calls = 0;
    const h = makeHarness({
      now: () => {
        calls++;
        if (calls <= 2) return 1_000_000;
        return 1_000_000 + FIRST_RESPONSE_TIMEOUT_MS + 1;
      },
    });
    const err = await h.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FatalRunError);
    expect((err as Error).message).toContain('did not produce an assistant response');
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
  });
});

describe('runPrompt prompt-POST retry matrix', () => {
  it('retries with a 5s sleep on ECONNRESET and succeeds on the second attempt', async () => {
    let attempts = 0;
    const h = makeHarness({
      postMessage: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        return okPost();
      },
    });
    // Resolve completion well after the promptPost retry (one injected-sleep
    // round trip + microtasks, well under 50ms) so the retry is observed.
    setTimeout(() => h.completion.resolve('done'), 50);
    await h.run();

    expect(attempts).toBe(2);
    expect(h.sleeps).toContain(5000);
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Succeeded' }));
  });

  it('skips the re-POST when the session already has messages after a transient failure', async () => {
    let attempts = 0;
    const h = makeHarness({
      postMessage: async () => {
        attempts++;
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      },
      // The retry check finds an existing message and decides not to re-POST.
      fetchMessages: async () => [{ info: { id: 'm1', role: 'assistant' } }],
    });
    setTimeout(() => h.completion.resolve('done'), 50);
    await h.run();

    expect(attempts).toBe(1);
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Succeeded' }));
  });

  it('throws after the prompt POST retries are exhausted', async () => {
    let attempts = 0;
    const h = makeHarness({
      postMessage: async () => {
        attempts++;
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      },
    });
    const err = await h.run().catch((e: unknown) => e);

    expect((err as Error).message).toBe('socket reset');
    // Initial POST + 3 retries.
    expect(attempts).toBe(4);
    expect(h.sleeps.filter((ms) => ms === 5000).length).toBeGreaterThanOrEqual(3);
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
  });

  it('throws immediately on a non-retryable POST error', async () => {
    let attempts = 0;
    const h = makeHarness({
      postMessage: async () => {
        attempts++;
        throw new Error('prompt failed: HTTP 422 validation error');
      },
    });
    const err = await h.run().catch((e: unknown) => e);

    expect((err as Error).message).toContain('HTTP 422');
    expect(attempts).toBe(1);
    expect(h.sleeps).not.toContain(5000);
    expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
  });
});

describe('runPrompt hard-timeout guard (regression)', () => {
  // The guard used to call process.exit(0)/process.exit(3) directly, skipping
  // the session snapshot, sendStats and the Failed phase. It must now reject
  // the race so the run exits through the normal snapshot → stats → Failed
  // path, and process.exit must never be reached from runPrompt.

  it('fails via the normal path when the hard timeout elapses before a first response', async () => {
    const exitSpy = spyOn(process, 'exit');
    try {
      const h = makeHarness({ hardTimeoutMs: 30 });
      const err = await h.run().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FatalRunError);
      expect((err as Error).message).toContain('hard timeout');
      expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
      expect(h.stats).toContainEqual(
        expect.objectContaining({ phase: 'Failed', message: (err as Error).message }),
      );
      expect(h.patches).toContainEqual(
        expect.objectContaining({ phase: 'Failed', message: (err as Error).message }),
      );
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails via the normal path when the hard timeout elapses while waiting for input', async () => {
    const exitSpy = spyOn(process, 'exit');
    try {
      // An aborted assistant message parks the poll loop in waitingForInput
      // before the (short) hard timeout fires.
      const h = makeHarness({
        hardTimeoutMs: 60,
        fetchMessages: async () => [
          { info: { id: 'm1', role: 'assistant', error: { type: 'MessageAbortedError' } } },
        ],
      });
      const err = await h.run().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FatalRunError);
      expect(h.patches).toContainEqual(expect.objectContaining({ phase: 'WaitingForInput' }));
      expect(h.patches).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
      expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
      expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('derives the deadline from RUN_TIMEOUT_SECONDS — the first-response cap shrinks and the run fails via the normal path', async () => {
    // RUN_TIMEOUT_SECONDS=30 → resolveHardTimeoutMs() floors at 30_000, so the
    // poll loop's firstResponseTimeoutMs is capped at min(3_600_000, 28_000)
    // = 28_000. A now()-jump past 28s trips the poll loop — with the legacy
    // 65-min fallback it would not. This proves the env reached the deadline
    // without waiting for the (30s-floored) hard-timeout timer.
    const prev = process.env.RUN_TIMEOUT_SECONDS;
    process.env.RUN_TIMEOUT_SECONDS = '30';
    try {
      const exitSpy = spyOn(process, 'exit');
      try {
        // now() call order: runStartedAt, poll startedAt, per-tick elapsed check.
        let calls = 0;
        const h = makeHarness({
          now: () => {
            calls++;
            if (calls <= 2) return 1_000_000;
            return 1_000_000 + 28_001;
          },
        });
        const err = await h.run().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(FatalRunError);
        expect((err as Error).message).toContain(
          'did not produce an assistant response within 28s',
        );
        expect(h.stats).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
        expect(h.patches).toContainEqual(expect.objectContaining({ phase: 'Failed' }));
        expect(h.snapshotCalls).toBeGreaterThanOrEqual(1);
        expect(exitSpy).not.toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
      }
    } finally {
      if (prev === undefined) delete process.env.RUN_TIMEOUT_SECONDS;
      else process.env.RUN_TIMEOUT_SECONDS = prev;
    }
  });
});

describe('runInteractive (smoke)', () => {
  it('patches the discovered sessionID and snapshots on the first session.idle', async () => {
    const enc = new TextEncoder();
    const makeSse = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {"type":"session.idle","properties":{}}\n\n'));
          controller.close();
        },
      });
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/event')) {
        return new Response(makeSse(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/session')) return new Response(JSON.stringify([{ id: 's1' }]));
      if (url.includes('/message')) return new Response(JSON.stringify([]));
      return new Response('', { status: 404 });
    };
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fakeFetch as typeof fetch;

    const patches: object[] = [];
    const cmCreates: unknown[] = [];
    const coreApi = {
      createNamespacedConfigMap: async (args: unknown) => {
        cmCreates.push(args);
      },
      patchNamespacedConfigMap: async () => {},
    } as unknown as CoreV1Api;

    // Spy on sendStats to assert the termination-path flush. The first session
    // id ('s1') is discovered before shutdown, so the flush is keyed on it.
    const statsCalls: Array<{
      sessionID: string;
      phase: string;
      startedAt: string;
      completedAt: string | undefined;
    }> = [];
    const before = new Date().toISOString();
    const sendStatsSpy = async (
      sessionID: string,
      phase: string,
      startedAt: string,
      completedAt: string | undefined,
    ): Promise<void> => {
      statsCalls.push({ sessionID, phase, startedAt, completedAt });
    };

    let shuttingDown = false;
    setTimeout(() => {
      shuttingDown = true;
    }, 300);

    try {
      await runInteractive(
        async (p) => {
          patches.push(p);
        },
        () => shuttingDown,
        // Yield to the event loop so the shutdown interval can fire.
        async () => {
          await new Promise((r) => setTimeout(r, 0));
        },
        coreApi,
        'run-1',
        'ns',
        'uid',
        { sendStats: sendStatsSpy },
      );
    } finally {
      (globalThis as { fetch: unknown }).fetch = origFetch;
    }

    // Session discovery patched the sessionID onto the Run status.
    expect(patches).toContainEqual(
      expect.objectContaining({ sessionID: 's1', message: 'session active' }),
    );
    // A session snapshot ConfigMap was written (on discovery and/or first idle).
    expect(cmCreates.length).toBeGreaterThanOrEqual(1);
    // Termination flushed a final full sendStats keyed on the first session,
    // in Running phase (interactive termination is not a failure), spanning
    // the whole interactive run (startedAt no earlier than test start).
    expect(statsCalls.length).toBe(1);
    expect(statsCalls[0]?.sessionID).toBe('s1');
    expect(statsCalls[0]?.phase).toBe('Running');
    expect(statsCalls[0]?.startedAt).toBeDefined();
    expect(statsCalls[0]?.startedAt >= before).toBe(true);
    expect(Number.isNaN(Date.parse(statsCalls[0]?.startedAt ?? ''))).toBe(false);
    expect(statsCalls[0]?.completedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(statsCalls[0]?.completedAt ?? ''))).toBe(false);
  });
});
