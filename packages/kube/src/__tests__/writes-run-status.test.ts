// writes-run-status.test.ts — regression tests for the retry/backoff loops in
// patchRunStatus and patchRunAnnotations.
//
// Both helpers retry transient failures up to maxRetries+1 total attempts with
// an exponential backoff (100ms, 200ms, 400ms …) injected via a `sleep` seam.
// Retryable: 408/409/429, any 5xx, and network errors with no statusCode.
// Deterministic 4xx errors (400/401/403/404/422) throw immediately.

import { describe, expect, it } from 'bun:test';
import { RunPhase } from '@percussionist/api';
import { patchRunAnnotations, patchRunStatus } from '../index.js';
import {
  conflict,
  installFakeKube,
  kubeError,
  networkError,
  notFound,
  serverError,
  tooManyRequests,
} from './helpers/fake-kube.js';

const NS = 'test-ns';
const RUN = 'run-1';

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

describe('patchRunStatus', () => {
  it('retries 409 conflicts with exponential backoff (attempts + delays)', async () => {
    const fake = installFakeKube({ patchNamespacedCustomObjectStatus: { error: conflict() } });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep),
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

  it('succeeds on the 2nd attempt after one conflict', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: conflict('stale resourceVersion') },
        { value: { status: { phase: RunPhase.Running } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep);
      expect(run.status?.phase).toBe(RunPhase.Running);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
      // The retry carries the same body — merge-patch is idempotent.
      const first = fake.calls[0]?.args[0] as { body: { status: { phase: string } } };
      const second = fake.calls[1]?.args[0] as { body: { status: { phase: string } } };
      expect(first.body.status.phase).toBe(RunPhase.Running);
      expect(second.body.status.phase).toBe(RunPhase.Running);
    } finally {
      fake.restore();
    }
  });

  it('gives up after maxRetries+1 conflicts and throws', async () => {
    const fake = installFakeKube({ patchNamespacedCustomObjectStatus: { error: conflict() } });
    const { sleep } = recordingSleep();
    try {
      await expect(patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 2, sleep)).rejects.toThrow(
        /conflict/,
      );
      // maxRetries=2 → attempts 0..2 = 3 calls, then throw.
      expect(fake.calls).toHaveLength(3);
    } finally {
      fake.restore();
    }
  });

  it('throws immediately on a non-retryable 4xx error (404) without retrying or sleeping', async () => {
    const fake = installFakeKube({ patchNamespacedCustomObjectStatus: { error: notFound() } });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(fake.calls).toHaveLength(1);
      expect(delays).toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it('retries a 5xx and succeeds on the 2nd attempt with one backoff delay', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: serverError('transient API server hiccup') },
        { value: { status: { phase: RunPhase.Running } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep);
      expect(run.status?.phase).toBe(RunPhase.Running);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('retries 429 with backoff and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: tooManyRequests() },
        { value: { status: { phase: RunPhase.Running } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep);
      expect(run.status?.phase).toBe(RunPhase.Running);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('gives up after maxRetries+1 429 responses and throws', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: { error: tooManyRequests() },
    });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep),
      ).rejects.toMatchObject({ statusCode: 429 });
      // maxRetries=3 → attempts 0..3 = 4 calls, all rate-limited, then throw.
      expect(fake.calls).toHaveLength(4);
      expect(delays).toEqual([100, 200, 400]);
    } finally {
      fake.restore();
    }
  });

  it('retries a network error (no statusCode) and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: networkError('ECONNRESET') },
        { value: { status: { phase: RunPhase.Running } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep);
      expect(run.status?.phase).toBe(RunPhase.Running);
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
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
      await expect(patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep)).rejects.toThrow(
        /socket hang up/,
      );
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
          patchRunStatus(RUN, { phase: RunPhase.Running }, NS, 3, sleep),
        ).rejects.toMatchObject({ statusCode: status });
        expect(fake.calls).toHaveLength(1);
        expect(delays).toEqual([]);
      } finally {
        fake.restore();
      }
    }
  });
});

describe('patchRunAnnotations', () => {
  it('retries 409 conflicts and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObject: [
        { error: conflict() },
        { value: { metadata: { annotations: { 'percussionist.dev/merge-verdict': 'merged' } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunAnnotations(
        RUN,
        { 'percussionist.dev/merge-verdict': 'merged' },
        NS,
        3,
        sleep,
      );
      expect(run.metadata?.annotations?.['percussionist.dev/merge-verdict']).toBe('merged');
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
      const first = fake.calls[0]?.args[0] as { body: { metadata: { annotations: unknown } } };
      expect(first.body.metadata.annotations).toEqual({
        'percussionist.dev/merge-verdict': 'merged',
      });
    } finally {
      fake.restore();
    }
  });

  it('gives up after exhausting retries and throws', async () => {
    const fake = installFakeKube({ patchNamespacedCustomObject: { error: conflict() } });
    const { sleep } = recordingSleep();
    try {
      await expect(patchRunAnnotations(RUN, { verdict: 'merged' }, NS, 3, sleep)).rejects.toThrow(
        /conflict/,
      );
      expect(fake.calls).toHaveLength(4);
    } finally {
      fake.restore();
    }
  });

  it('retries a transient 5xx and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObject: [
        { error: serverError() },
        { value: { metadata: { annotations: { verdict: 'merged' } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunAnnotations(RUN, { verdict: 'merged' }, NS, 3, sleep);
      expect(run.metadata?.annotations?.verdict).toBe('merged');
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('retries a network error and succeeds on the 2nd attempt', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObject: [
        { error: networkError('ECONNREFUSED') },
        { value: { metadata: { annotations: { verdict: 'merged' } } } },
      ],
    });
    const { sleep, delays } = recordingSleep();
    try {
      const run = await patchRunAnnotations(RUN, { verdict: 'merged' }, NS, 3, sleep);
      expect(run.metadata?.annotations?.verdict).toBe('merged');
      expect(fake.calls).toHaveLength(2);
      expect(delays).toEqual([100]);
    } finally {
      fake.restore();
    }
  });

  it('throws immediately on a non-retryable 4xx without sleeping', async () => {
    const fake = installFakeKube({ patchNamespacedCustomObject: { error: kubeError(422) } });
    const { sleep, delays } = recordingSleep();
    try {
      await expect(
        patchRunAnnotations(RUN, { verdict: 'merged' }, NS, 3, sleep),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(fake.calls).toHaveLength(1);
      expect(delays).toEqual([]);
    } finally {
      fake.restore();
    }
  });
});
