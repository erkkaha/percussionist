// submit-wait.test.ts — `submit --attach` polling loop (waitForRunning).
//
// wait.test.ts covers waitForOutcome (the `beatctl wait` command); this file
// covers the submit-specific poller that blocks until the dispatcher reports
// Running, with a terminal phase or timeout as the failure modes. The loop is
// driven with an injected getRunFn so no cluster is needed.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run } from '@percussionist/api';
import { RunPhase } from '@percussionist/api';
import { waitForRunning } from '../src/submit.ts';

function runWith(phase?: string, message?: string): Run {
  return { status: phase ? { phase, message } : undefined } as unknown as Run;
}

describe('waitForRunning', () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    stderrSpy?.mockRestore();
  });

  it('returns the run as soon as the phase becomes Running', async () => {
    stderrSpy = spyOn(process.stderr, 'write');
    const run = await waitForRunning('ns', 'run-a', 5_000, async () => runWith(RunPhase.Running));
    expect(run.status?.phase).toBe(RunPhase.Running);
    // The in-place spinner wrote the phase transition to stderr.
    expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes('phase=Running'))).toBe(
      true,
    );
  });

  it('polls through intermediate phases before Running', async () => {
    const phases = [undefined, RunPhase.Pending, RunPhase.Running];
    const run = await waitForRunning('ns', 'run-b', 5_000, async () => runWith(phases.shift()));
    expect(run.status?.phase).toBe(RunPhase.Running);
  });

  it('throws with the run message when a terminal phase is hit before Running', async () => {
    stderrSpy = spyOn(process.stderr, 'write');
    await expect(
      waitForRunning('ns', 'run-c', 5_000, async () => runWith(RunPhase.Failed, 'lint failed')),
    ).rejects.toThrow(/terminal phase Failed before Running/);
    await expect(
      waitForRunning('ns', 'run-c', 5_000, async () => runWith(RunPhase.Failed, 'lint failed')),
    ).rejects.toThrow(/lint failed/);
  });

  it('treats every terminal phase as fatal, not just Failed', async () => {
    for (const phase of [RunPhase.Succeeded, RunPhase.Cancelled]) {
      await expect(
        waitForRunning('ns', 'run-term', 5_000, async () => runWith(phase)),
      ).rejects.toThrow(new RegExp(`terminal phase ${phase} before Running`));
    }
  });

  it('throws with the last observed phase when the deadline expires', async () => {
    stderrSpy = spyOn(process.stderr, 'write');
    await expect(
      waitForRunning('ns', 'run-slow', 50, async () => runWith(RunPhase.Pending)),
    ).rejects.toThrow(/did not reach Running within/);
    await expect(
      waitForRunning('ns', 'run-slow', 50, async () => runWith(RunPhase.Pending)),
    ).rejects.toThrow(/last phase=Pending/);
  });

  it('reports an unset phase as "-" in the timeout message', async () => {
    stderrSpy = spyOn(process.stderr, 'write');
    await expect(waitForRunning('ns', 'run-empty', 50, async () => runWith())).rejects.toThrow(
      /last phase=-/,
    );
  });
});
