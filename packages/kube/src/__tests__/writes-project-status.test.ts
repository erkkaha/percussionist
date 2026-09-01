// writes-project-status.test.ts — regression tests for the retry/backoff loop
// in patchProjectStatus.
//
// Like patchRunStatus/patchRunAnnotations, it retries transient failures
// (408/409/429, 5xx, network errors with no statusCode) up to maxRetries+1
// total attempts with an exponential backoff (100ms, 200ms, 400ms …), injected
// via the optional `sleep` seam (5th positional arg). Deterministic 4xx errors
// throw immediately.

import { describe, expect, it } from 'bun:test';
import { patchProjectStatus } from '../index.js';
import {
  conflict,
  installFakeKube,
  kubeError,
  networkError,
  serverError,
  tooManyRequests,
} from './helpers/fake-kube.js';

const NS = 'test-ns';
const PROJECT = 'proj-1';

/** Records the backoff delays passed to the injected sleep. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    // Injected sleep resolves immediately — no real waiting.
    delays,
  };
}

describe('patchProjectStatus', () => {
  it('retries 409 conflicts with exponential backoff (attempts + delays)', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: { error: conflict() },
    });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchProjectStatus(PROJECT, { board: { activeWorkers: 1 } }, NS, 3, sleep),
      ).rejects.toMatchObject({ statusCode: 409 });

      // maxRetries=3 → attempts 0..3 = 4 patch calls, all conflicts.
      expect(fake.calls).toHaveLength(4);
      expect(fake.calls.every((c) => c.method === 'patchNamespacedCustomObjectStatus')).toBe(true);
      // Backoff before attempts 1, 2, 3: 100, 200, 400.
      expect(delays).toEqual([100, 200, 400]);
    } finally {
      fake.restore();
    }
  });

  it('retries a transient 5xx and succeeds on the 2nd attempt with one backoff delay', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: serverError('transient API server hiccup') },
        { value: { status: { board: { activeWorkers: 1 } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const project = await patchProjectStatus(
        PROJECT,
        { board: { activeWorkers: 1 } },
        NS,
        3,
        sleep,
      );
      expect(project.status?.board?.activeWorkers).toBe(1);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
      // The retry carries the same body — merge-patch is idempotent.
      const first = fake.calls[0]?.args[0] as {
        body: { status: { board: { activeWorkers: number } } };
      };
      const second = fake.calls[1]?.args[0] as {
        body: { status: { board: { activeWorkers: number } } };
      };
      expect(first.body.status.board.activeWorkers).toBe(1);
      expect(second.body.status.board.activeWorkers).toBe(1);
    } finally {
      fake.restore();
    }
  });

  it('retries 429 with backoff and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: tooManyRequests() },
        { value: { status: { board: { activeWorkers: 2 } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const project = await patchProjectStatus(
        PROJECT,
        { board: { activeWorkers: 2 } },
        NS,
        3,
        sleep,
      );
      expect(project.status?.board?.activeWorkers).toBe(2);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('retries a network error (no statusCode) and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: networkError('ECONNRESET') },
        { value: { status: { board: { activeWorkers: 1 } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const project = await patchProjectStatus(
        PROJECT,
        { board: { activeWorkers: 1 } },
        NS,
        3,
        sleep,
      );
      expect(project.status?.board?.activeWorkers).toBe(1);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('gives up after maxRetries+1 5xx responses and throws', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: { error: serverError() },
    });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchProjectStatus(PROJECT, { board: { activeWorkers: 1 } }, NS, 3, sleep),
      ).rejects.toMatchObject({ statusCode: 500 });
      // maxRetries=3 → attempts 0..3 = 4 calls, all failing, then throw.
      expect(fake.calls).toHaveLength(4);
      expect(delays).toEqual([100, 200, 400]);
    } finally {
      fake.restore();
    }
  });

  it('gives up after maxRetries+1 network errors and throws', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: { error: networkError('socket hang up') },
    });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchProjectStatus(PROJECT, { board: { activeWorkers: 1 } }, NS, 3, sleep),
      ).rejects.toThrow(/socket hang up/);
      expect(fake.calls).toHaveLength(4);
      expect(delays).toEqual([100, 200, 400]);
    } finally {
      fake.restore();
    }
  });

  it('throws immediately on non-retryable 4xx (401/403/422) with a single call', async () => {
    for (const status of [401, 403, 422]) {
      const fake = installFakeKube({
        patchNamespacedCustomObjectStatus: { error: kubeError(status) },
      });
      const { sleep, delays } = recordingSleep();
      try {
        await expect(
          patchProjectStatus(PROJECT, { board: { activeWorkers: 1 } }, NS, 3, sleep),
        ).rejects.toMatchObject({ statusCode: status });
        expect(fake.calls).toHaveLength(1);
        expect(delays).toEqual([]);
      } finally {
        fake.restore();
      }
    }
  });
});
