// ttl-flow.test.ts — flow-level tests for ttl.ts driven through the BUILD-1
// recording fake kube client: runTTLCleanup (expiry filtering, deletion,
// 404 tolerance, deleted-count log), the ClusterSettings → runTTLDays fallback
// to 7 days, and spawnWorktreeCleanupJob's skip/409/non-409 paths. The pure
// helpers (isExpired, buildCleanupJob) remain covered in ttl.test.ts.

import { describe, expect, it } from 'bun:test';
import { type Run, RunPhase } from '@percussionist/api';
import { conflict, installFakeKube, notFound, serverError } from './test-helpers/fake-kube.js';
import { runTTLCleanup, spawnWorktreeCleanupJob } from './ttl.js';

function makeRun(name: string, overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name,
      namespace: 'percussionist',
      uid: `uid-${name}`,
      labels: { 'percussionist.dev/project': 'proj' },
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: 'proj',
      task: 'task-1',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
    },
    ...overrides,
  } as Run;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function terminalRun(name: string, phase: RunPhase, completedAt: string): Run {
  return makeRun(name, { status: { phase, completedAt } });
}

function deletedNames(fake: { calls: { method: string; args: unknown[] }[] }): string[] {
  return fake.calls
    .filter((c) => c.method === 'deleteNamespacedCustomObject')
    .map((c) => (c.args[0] as { name: string })?.name);
}

/** Run a thunk with console.log/console.error captured into string arrays. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = origOut;
    console.error = origErr;
  }
  return { out, err };
}

describe('runTTLCleanup', () => {
  it('deletes only expired terminal runs and logs the deleted count', async () => {
    const expired = terminalRun('expired', RunPhase.Succeeded, daysAgo(8));
    const recent = terminalRun('recent', RunPhase.Succeeded, daysAgo(1));
    const expiredFailed = terminalRun('expired-failed', RunPhase.Failed, daysAgo(8));
    const running = makeRun('still-running', { status: { phase: RunPhase.Running } });

    const fake = installFakeKube({
      getClusterCustomObject: { value: { spec: { runTTLDays: 7 } } },
      listNamespacedCustomObject: { value: { items: [expired, recent, expiredFailed, running] } },
      deleteNamespacedCustomObject: { value: undefined },
    });
    try {
      const { out } = await captureConsole(() => runTTLCleanup());

      // Non-terminal runs are filtered out before the expiry check; only the
      // two runs past their 7-day TTL are deleted.
      expect(deletedNames(fake)).toEqual(['expired', 'expired-failed']);
      expect(out.some((l) => l.includes('cleanup complete: 2 Run(s) deleted'))).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it('does not delete any run when none are expired', async () => {
    const recent = terminalRun('recent', RunPhase.Succeeded, daysAgo(1));
    const fake = installFakeKube({
      getClusterCustomObject: { value: { spec: { runTTLDays: 7 } } },
      listNamespacedCustomObject: { value: { items: [recent] } },
    });
    try {
      const { out } = await captureConsole(() => runTTLCleanup());

      expect(deletedNames(fake)).toEqual([]);
      // deleted === 0 → no "cleanup complete" line.
      expect(out.some((l) => l.includes('cleanup complete'))).toBe(false);
    } finally {
      fake.restore();
    }
  });

  it('tolerates a 404 when deleting an expired run (no throw, no error log)', async () => {
    const expired = terminalRun('expired', RunPhase.Succeeded, daysAgo(8));
    const fake = installFakeKube({
      getClusterCustomObject: { value: { spec: { runTTLDays: 7 } } },
      listNamespacedCustomObject: { value: { items: [expired] } },
      deleteNamespacedCustomObject: { error: notFound() },
    });
    try {
      const { out, err } = await captureConsole(() => runTTLCleanup());

      // The delete was attempted (call recorded) but a 404 is tolerated
      // silently: it neither throws nor counts toward the deleted total.
      expect(deletedNames(fake)).toEqual(['expired']);
      expect(err.some((l) => l.includes('delete Run'))).toBe(false);
      expect(out.some((l) => l.includes('cleanup complete'))).toBe(false);
    } finally {
      fake.restore();
    }
  });
});

describe('fetchRunTTLDays fallback (via runTTLCleanup)', () => {
  it('falls back to a 7-day TTL when ClusterSettings is missing (404)', async () => {
    // An 8-day-old run is past the 7-day fallback; a 1-day-old one is not.
    const expired = terminalRun('expired', RunPhase.Succeeded, daysAgo(8));
    const recent = terminalRun('recent', RunPhase.Succeeded, daysAgo(1));
    const fake = installFakeKube({
      getClusterCustomObject: { error: notFound('no ClusterSettings yet') },
      listNamespacedCustomObject: { value: { items: [expired, recent] } },
      deleteNamespacedCustomObject: { value: undefined },
    });
    try {
      await runTTLCleanup();

      // Deleted exactly the run past 7 days — proves the fallback was 7, not
      // 0 (would delete `recent` too) and not huge (would skip `expired`).
      expect(deletedNames(fake)).toEqual(['expired']);
    } finally {
      fake.restore();
    }
  });

  it('falls back to a 7-day TTL when reading ClusterSettings errors', async () => {
    const expired = terminalRun('expired', RunPhase.Succeeded, daysAgo(8));
    const recent = terminalRun('recent', RunPhase.Succeeded, daysAgo(1));
    const fake = installFakeKube({
      getClusterCustomObject: { error: serverError('apiserver down') },
      listNamespacedCustomObject: { value: { items: [expired, recent] } },
      deleteNamespacedCustomObject: { value: undefined },
    });
    try {
      await runTTLCleanup();

      expect(deletedNames(fake)).toEqual(['expired']);
    } finally {
      fake.restore();
    }
  });
});

describe('spawnWorktreeCleanupJob', () => {
  it('skips creating a job when the run has no project label and no pvcName', async () => {
    const bare = makeRun('bare');
    bare.metadata.labels = {};
    const fake = installFakeKube(); // any kube call would fail loudly
    try {
      await spawnWorktreeCleanupJob(bare);

      expect(fake.calls).toHaveLength(0);
    } finally {
      fake.restore();
    }
  });

  it('proceeds when no project label is set but spec.data.pvcName is present', async () => {
    const run = makeRun('pvc-only');
    run.metadata.labels = {};
    run.spec.data = { pvcName: 'custom-data' };
    const fake = installFakeKube({
      createNamespacedJob: { value: { metadata: { name: 'cleanup-ttl-pvc-only' } } },
    });
    try {
      await spawnWorktreeCleanupJob(run);

      expect(fake.calls.map((c) => c.method)).toEqual(['createNamespacedJob']);
      const job = fake.calls[0]?.args[0]?.body as {
        spec: {
          template: { spec: { volumes: { persistentVolumeClaim: { claimName: string } }[] } };
        };
      };
      expect(job.spec.template.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(
        'custom-data',
      );
    } finally {
      fake.restore();
    }
  });

  it('tolerates a 409 (job already in flight) without logging', async () => {
    const run = makeRun('with-label');
    const fake = installFakeKube({
      createNamespacedJob: { error: conflict('already exists') },
    });
    try {
      const { err } = await captureConsole(() => spawnWorktreeCleanupJob(run));

      expect(fake.calls).toHaveLength(1);
      expect(err).toHaveLength(0);
    } finally {
      fake.restore();
    }
  });

  it('surfaces a non-409 create error via the error log (pinned: no rethrow)', async () => {
    const run = makeRun('with-label');
    const fake = installFakeKube({
      createNamespacedJob: { error: serverError('apiserver down') },
    });
    try {
      const { err } = await captureConsole(() => spawnWorktreeCleanupJob(run));

      expect(fake.calls).toHaveLength(1);
      expect(err.some((l) => l.includes('cleanup job for with-label'))).toBe(true);
    } finally {
      fake.restore();
    }
  });
});
