import { describe, expect, it } from 'bun:test';
import {
  FatalRunError,
  type PollLoopSharedState,
  type RunPollStatusConstants,
  type RunPollStatusDeps,
  runPollStatusLoop,
  TokenAggregator,
} from '../polling.js';
import type { RawMessage } from '../session.js';

// Table-driven coverage for the extracted poll-status loop (runPollStatusLoop).
// Every timing dependency (now/sleep), the message stream (fetchMessages) and
// the health check are scripted, so each transition — settle, idle timeout,
// waiting-for-input, FatalRunError — is exercised deterministically without a
// cluster or an opencode server.

const DEFAULT_CONSTANTS: RunPollStatusConstants = {
  pollMs: 2000,
  firstResponseTimeoutMs: 3_600_000,
  settleMs: 10_000,
  idleTimeoutMs: 900_000,
  healthFailThreshold: 3,
};

// --- message builders -------------------------------------------------------

const assistantMsg = (
  id: string,
  opts: { completed?: boolean; input?: number; output?: number; error?: unknown } = {},
): RawMessage => ({
  info: {
    id,
    role: 'assistant',
    ...(opts.completed ? { time: { created: 1, completed: 2 } } : {}),
    ...(opts.input !== undefined || opts.output !== undefined
      ? { tokens: { input: opts.input ?? 0, output: opts.output ?? 0 } }
      : {}),
    ...(opts.error ? { error: opts.error } : {}),
  },
});

const abortedAssistantMsg = (id: string): RawMessage => ({
  info: { id, role: 'assistant', error: { type: 'MessageAbortedError' } },
});

// --- harness ----------------------------------------------------------------

interface Harness {
  deps: RunPollStatusDeps;
  state: PollLoopSharedState;
  patches: object[];
  calls: { fetch: number; health: number };
}

function makeHarness(
  opts: {
    // `messages` returning undefined simulates a transient fetchMessages failure.
    messages?: (clock: { t: number }, call: number) => RawMessage[] | undefined;
    health?: () => boolean;
    now?: () => number;
    clock?: { t: number };
    terminateAfterSleeps?: number;
    constants?: Partial<RunPollStatusConstants>;
  } = {},
): Harness {
  const state: PollLoopSharedState = {
    terminate: false,
    waitingForInput: false,
    needsHumanInput: false,
  };
  const patches: object[] = [];
  const clock = opts.clock ?? { t: 0 };
  const calls = { fetch: 0, health: 0 };
  let sleepCount = 0;
  const terminateAfterSleeps = opts.terminateAfterSleeps ?? Number.POSITIVE_INFINITY;

  const deps: RunPollStatusDeps = {
    fetchMessages: async () => {
      calls.fetch++;
      if (opts.messages) {
        const msgs = opts.messages(clock, calls.fetch);
        if (msgs === undefined) throw new Error('transient fetch failure');
        return msgs;
      }
      return [];
    },
    checkHealth: async () => {
      calls.health++;
      return opts.health ? opts.health() : true;
    },
    patchStatus: async (p: object) => {
      patches.push(p);
    },
    sleep: async () => {
      // The loop's first sleep is the 1s warm-up, the rest are poll ticks.
      sleepCount++;
      if (sleepCount >= terminateAfterSleeps) state.terminate = true;
    },
    now: opts.now ?? (() => clock.t),
    isShuttingDown: () => false,
    sessionID: 'sess-1',
    state,
    tokens: new TokenAggregator(),
    constants: { ...DEFAULT_CONSTANTS, ...opts.constants },
  };
  return { deps, state, patches, calls };
}

function makeNow(first: number, then: number): () => number {
  let calls = 0;
  return () => {
    calls++;
    return calls === 1 ? first : then;
  };
}

describe('runPollStatusLoop', () => {
  it('records usage on the first assistant message and does not settle or time out prematurely', async () => {
    const clock = { t: 0 };
    const h = makeHarness({
      clock,
      messages: (c, call) => {
        // After the first assistant message is seen the clock jumps far past
        // the first-response timeout. The loop must NOT throw — sawBusy was set.
        if (call === 2) c.t = DEFAULT_CONSTANTS.firstResponseTimeoutMs + 5000;
        return [assistantMsg('m1', { input: 2, output: 100 })]; // not completed
      },
      terminateAfterSleeps: 4,
    });
    await runPollStatusLoop(h.deps);
    // Kept polling instead of settling (no completed timestamp) or timing out.
    expect(h.calls.fetch).toBeGreaterThanOrEqual(2);
    // Usage was flushed to the CR on the first assistant delivery.
    const usagePatch = h.patches.find((p) => (p as { tokensOut?: number }).tokensOut === 100);
    expect(usagePatch).toBeDefined();
  });

  it('terminates via the settle path once the completed message has settled for SETTLE_MS', async () => {
    // Base clock is nonzero so completingSince (=now()) stays truthy — a 0
    // timestamp would make the settle branch (`completingSince && …`) unreachable.
    const clock = { t: 1_000_000 };
    const h = makeHarness({
      clock,
      messages: (c, call) => {
        // Second delivery advances the clock past the settling window.
        if (call === 2) c.t += DEFAULT_CONSTANTS.settleMs;
        return [assistantMsg('m1', { completed: true, input: 2, output: 100 })];
      },
    });
    await runPollStatusLoop(h.deps);
    expect(h.state.terminate).toBe(true);
    const usagePatch = h.patches.find((p) => (p as { tokensOut?: number }).tokensOut === 100);
    expect(usagePatch).toBeDefined();
  });

  it('throws FatalRunError when the first assistant response has zero token usage (regression: guard used to be unreachable)', async () => {
    const h = makeHarness({
      // Completed assistant message that records no usage at all.
      messages: () => [assistantMsg('m1', { completed: true })],
      terminateAfterSleeps: 3,
    });
    const err = await runPollStatusLoop(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalRunError);
    expect((err as Error).message).toContain('zero token usage');
  });

  it('terminates when the session has been waiting for input past IDLE_TIMEOUT_MS', async () => {
    const clock = { t: 0 };
    const h = makeHarness({
      clock,
      messages: (c, call) => {
        // idleSince is captured at t=0 on the first delivery; the second
        // delivery jumps the clock past the idle timeout.
        if (call === 2) c.t = DEFAULT_CONSTANTS.idleTimeoutMs;
        return [abortedAssistantMsg('m1')];
      },
    });
    await runPollStatusLoop(h.deps);
    expect(h.state.terminate).toBe(true);
  });

  it('publishes WaitingForInput then flips back to Running when needsHumanInput clears', async () => {
    const h = makeHarness({
      messages: (_c, call) => {
        if (call === 1) return [abortedAssistantMsg('m1')];
        // A new, completed, non-aborted message with usage means work resumed.
        return [assistantMsg('m2', { completed: true, input: 2, output: 100 })];
      },
      terminateAfterSleeps: 3,
    });
    await runPollStatusLoop(h.deps);
    const phases = h.patches
      .map((p) => (p as { phase?: string }).phase)
      .filter((phase): phase is string => phase !== undefined);
    expect(phases).toEqual(['WaitingForInput', 'Running']);
    expect(h.state.waitingForInput).toBe(false);
    expect(h.state.needsHumanInput).toBe(false);
  });

  it('throws FatalRunError after healthFailThreshold consecutive failed health checks', async () => {
    const h = makeHarness({ health: () => false });
    const err = await runPollStatusLoop(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalRunError);
    expect(h.calls.health).toBe(3);
  });

  it('throws FatalRunError when no assistant response appears within firstResponseTimeoutMs', async () => {
    const h = makeHarness({
      // First now() call is `startedAt`; the first poll tick is already past
      // the deadline and sawBusy is still false.
      now: makeNow(0, DEFAULT_CONSTANTS.firstResponseTimeoutMs + 1),
    });
    const err = await runPollStatusLoop(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalRunError);
    expect((err as Error).message).toContain('did not produce an assistant response');
  });

  it('marks the run as waiting for human input when the last message carries a MessageAbortedError', async () => {
    const h = makeHarness({
      messages: () => [abortedAssistantMsg('m1')],
      terminateAfterSleeps: 3,
    });
    await runPollStatusLoop(h.deps);
    expect(h.state.waitingForInput).toBe(true);
    expect(h.state.needsHumanInput).toBe(true);
    expect(h.patches).toContainEqual({ phase: 'WaitingForInput' });
  });

  it('rethrows a non-abort session error instead of swallowing it', async () => {
    const h = makeHarness({
      messages: () => [assistantMsg('m1', { error: { type: 'InternalError', message: 'boom' } })],
    });
    const err = await runPollStatusLoop(h.deps).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^session error:/);
  });

  it('swallows a transient fetchMessages rejection and keeps polling', async () => {
    const h = makeHarness({
      messages: (_c, call) => (call === 1 ? undefined : []),
      terminateAfterSleeps: 3,
    });
    await expect(runPollStatusLoop(h.deps)).resolves.toBeUndefined();
    expect(h.calls.fetch).toBeGreaterThanOrEqual(2);
  });
});
