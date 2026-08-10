// index.test.ts — Tests for the Run informer's delete-event handler, which is
// the single trigger path for worktree cleanup (see ttl.ts spawnWorktreeCleanupJob).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Run } from '@percussionist/api';
import * as reconciler from './reconciler.js';
import * as ttl from './ttl.js';

function makeRun(overrides: Partial<Run['spec']> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name: 'test-run',
      namespace: 'test-ns',
      uid: 'test-uid',
      labels: { 'percussionist.dev/project': 'test-project' },
    },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
      ...overrides,
    },
    status: {},
  } as unknown as Run;
}

describe('handleRunDelete', () => {
  let dequeueSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let indexModule: typeof import('./index.js');

  beforeEach(async () => {
    dequeueSpy = spyOn(reconciler, 'dequeue');
    spawnSpy = spyOn(ttl, 'spawnWorktreeCleanupJob').mockResolvedValue(undefined);
    indexModule = await import('./index.js');
  });

  afterEach(() => {
    dequeueSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it('always dequeues the run', () => {
    const run = makeRun({ source: { git: { url: 'https://example.com/repo.git' } } });
    indexModule.handleRunDelete(run);
    expect(dequeueSpy).toHaveBeenCalledWith('test-ns/test-run');
  });

  it('spawns the worktree cleanup Job for a git-source run', () => {
    const run = makeRun({ source: { git: { url: 'https://example.com/repo.git' } } });
    indexModule.handleRunDelete(run);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(run);
  });

  it('does not spawn a cleanup Job for a local-source run (no spec.source.git)', () => {
    const run = makeRun();
    indexModule.handleRunDelete(run);
    expect(dequeueSpy).toHaveBeenCalledWith('test-ns/test-run');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('does not spawn a cleanup Job when the run has no project label', () => {
    const run = makeRun({ source: { git: { url: 'https://example.com/repo.git' } } });
    delete (run.metadata as { labels?: Record<string, string> }).labels;
    indexModule.handleRunDelete(run);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('does not throw when spawnWorktreeCleanupJob rejects (fire-and-forget)', () => {
    spawnSpy.mockRejectedValue(new Error('boom'));
    const run = makeRun({ source: { git: { url: 'https://example.com/repo.git' } } });
    expect(() => indexModule.handleRunDelete(run)).not.toThrow();
  });
});
