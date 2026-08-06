// wait.test.ts — Unit tests for the wait polling core (waitForOutcome).
//
// The core is a pure decision loop with an injected `getRunFn`, so these
// tests run without any cluster access. They pin the documented exit-code
// contract:
//   0 — awaited phase reached (default success = Succeeded)
//   1 — other terminal phase, or the run was deleted after being observed
//   2 — timeout
//   3 — transient error, or the run CR was never found (usage error)
//
// Regression: a 404 on the FIRST poll used to exit 1 with "was deleted before
// settling", making usage errors masquerade as run failures in `submit && wait`.

import { describe, expect, it } from 'bun:test';
import { type Run, RunPhase } from '@percussionist/api';
import { waitForOutcome } from '../src/wait.ts';

function runWith(phase?: string, message?: string): Run {
  return {
    status: phase ? { phase, message } : undefined,
  } as unknown as Run;
}

function notFoundError(): Error {
  return Object.assign(new Error('the server could not find the requested resource'), {
    code: 404,
  });
}

const NS = 'percussionist';

describe('waitForOutcome', () => {
  it('exits 3 when the run is never found (404 on the first poll)', async () => {
    const outcome = await waitForOutcome('typo', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      getRunFn: async () => {
        throw notFoundError();
      },
    });
    expect(outcome.code).toBe(3);
    expect(outcome.message).toContain('typo not found in namespace percussionist');
    // Usage error — printed even in quiet mode.
    expect(outcome.shownOnlyWhenNotQuiet).toBeUndefined();
  });

  it('exits 1 when a run observed mid-wait is then deleted (404 after a phase)', async () => {
    let calls = 0;
    const outcome = await waitForOutcome('cancelled', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      getRunFn: async () => {
        calls += 1;
        if (calls === 1) return runWith(RunPhase.Pending);
        throw notFoundError();
      },
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain('was deleted before settling');
    expect(outcome.message).toContain('last phase=Pending');
    expect(outcome.shownOnlyWhenNotQuiet).toBe(true);
  });

  it('exits 0 when the run reaches Succeeded', async () => {
    const outcome = await waitForOutcome('good', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      getRunFn: async () => runWith(RunPhase.Succeeded),
    });
    expect(outcome.code).toBe(0);
    expect(outcome.message).toBeUndefined();
  });

  it('exits 1 when the run reaches a terminal phase other than the awaited one', async () => {
    const outcome = await waitForOutcome('bad', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      getRunFn: async () => runWith(RunPhase.Failed, 'lint failed'),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain('reached Failed');
    expect(outcome.message).toContain('lint failed');
  });

  it('exits 2 when no terminal phase is reached before the timeout', async () => {
    const outcome = await waitForOutcome('slow', {
      ns: NS,
      timeoutSec: 1,
      quiet: true,
      getRunFn: async () => runWith(RunPhase.Running),
    });
    expect(outcome.code).toBe(2);
    expect(outcome.message).toContain('timed out after 1s');
    expect(outcome.message).toContain('last phase=Running');
  });

  it('exits 0 as soon as an explicit --for phase is observed', async () => {
    const outcome = await waitForOutcome('attach', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      awaited: RunPhase.Running,
      getRunFn: async () => runWith(RunPhase.Running),
    });
    expect(outcome.code).toBe(0);
    expect(outcome.message).toBeUndefined();
  });

  it('exits 3 on a transient API error', async () => {
    const outcome = await waitForOutcome('flaky', {
      ns: NS,
      timeoutSec: 10,
      quiet: true,
      getRunFn: async () => {
        throw new Error('connection reset');
      },
    });
    expect(outcome.code).toBe(3);
    expect(outcome.message).toContain('connection reset');
  });
});
