// ttl.test.ts — Tests for TTL expiry precedence (per-run vs cluster default)

import { describe, expect, it } from 'bun:test';
import type { Run } from '@percussionist/api';
import { isExpired } from './ttl.js';

// Helper to create a minimal terminal Run CR with all required fields
function makeRun(overrides: Partial<Run['spec']> = {}, completedAt?: string): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run-123',
      namespace: 'test-ns',
      uid: 'test-uid-123',
      labels: { 'percussionist.dev/project': 'test-project' },
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
      ...overrides,
    },
    status: completedAt ? { phase: 'done', completedAt } : {},
  } as unknown as Run;
}

describe('isExpired', () => {
  it('honors a per-run ttlSecondsAfterFinished even when the cluster default would not yet be expired', () => {
    // Completed 2 hours ago; per-run TTL is 1 hour, so it should be expired
    // even though the cluster default (7 days) would say not-yet-expired.
    const completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const run = makeRun({ ttlSecondsAfterFinished: 3600 }, completedAt);
    expect(isExpired(run, 7)).toBe(true);
  });

  it('does not expire a run whose per-run TTL has not yet elapsed', () => {
    // Completed 10 minutes ago; per-run TTL is 1 hour.
    const completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const run = makeRun({ ttlSecondsAfterFinished: 3600 }, completedAt);
    expect(isExpired(run, 7)).toBe(false);
  });

  it('falls back to the cluster runTTLDays when ttlSecondsAfterFinished is absent', () => {
    // Completed 2 hours ago; no per-run TTL set, cluster default is 7 days.
    const completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const run = makeRun({}, completedAt);
    expect(isExpired(run, 7)).toBe(false);

    // With a cluster default of 0 days, the same run is immediately expired.
    expect(isExpired(run, 0)).toBe(true);
  });

  it('never considers a run without completedAt expired', () => {
    const run = makeRun({ ttlSecondsAfterFinished: 0 });
    expect(isExpired(run, 0)).toBe(false);
  });
});
