// ttl.test.ts — Tests for TTL expiry precedence (per-run vs cluster default)
// and the worktree-cleanup Job renderer (buildCleanupJob).

import { describe, expect, it } from 'bun:test';
import type { Run } from '@percussionist/api';
import { gitUrlHash } from '@percussionist/kube';
import { buildCleanupJob, isExpired } from './ttl.js';

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

describe('buildCleanupJob', () => {
  it('mounts the overridden pvcName when spec.data.pvcName is set', () => {
    const run = makeRun({ data: { pvcName: 'custom-pvc' } });
    const job = buildCleanupJob(run);
    expect(job.spec.template.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe('custom-pvc');
  });

  it('defaults the claim name to `${project}-data` when no override is set', () => {
    const run = makeRun();
    const job = buildCleanupJob(run);
    expect(job.spec.template.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(
      'test-project-data',
    );
  });

  it('mounts the overridden mountPath when spec.data.mountPath is set', () => {
    const run = makeRun({ data: { mountPath: '/custom-mount' } });
    const job = buildCleanupJob(run);
    const container = job.spec.template.spec.containers[0];
    expect(container?.volumeMounts[0]?.mountPath).toBe('/custom-mount');
    expect(container?.args[0]).toContain('/custom-mount/worktrees/test-run-123');
  });

  it('defaults the mountPath to /data when no override is set', () => {
    const run = makeRun();
    const job = buildCleanupJob(run);
    expect(job.spec.template.spec.containers[0]?.volumeMounts[0]?.mountPath).toBe('/data');
  });

  it('sets a 1h TTL, backoffLimit 2, and restartPolicy Never', () => {
    const run = makeRun();
    const job = buildCleanupJob(run);
    expect(job.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(job.spec.backoffLimit).toBe(2);
    expect(job.spec.template.spec.restartPolicy).toBe('Never');
  });

  it('sanitizes and truncates a long/odd-charactered run name into a valid Job name', () => {
    const longName = `Weird_Run.Name--${'x'.repeat(80)}`;
    const run = makeRun();
    run.metadata.name = longName;
    const job = buildCleanupJob(run);
    expect(job.metadata.name.length).toBeLessThanOrEqual(63);
    expect(job.metadata.name).toMatch(/^[a-z0-9-]+$/);
    expect(job.metadata.name.startsWith('cleanup-ttl-')).toBe(true);
    expect(job.metadata.name.endsWith('-')).toBe(false);
  });

  it('shell script removes the worktree after recording its branch', () => {
    const run = makeRun();
    const script = buildCleanupJob(run).spec.template.spec.containers[0]?.args?.[0] ?? '';
    expect(script.startsWith('set -e')).toBe(true);
    expect(script).toContain('rm -rf /data/worktrees/test-run-123');
    // The branch is captured BEFORE the worktree is deleted so the mirror
    // cleanup below can delete the feature branch.
    const branchLine = script.split('\n').find((l) => l.includes('symbolic-ref HEAD'));
    expect(branchLine).toContain('git -C /data/worktrees/test-run-123 symbolic-ref HEAD');
    expect(branchLine).toContain('2>/dev/null || true');
    expect(script).toContain('echo "[cleanup-ttl] done"');
  });

  it('prunes the git mirror and deletes the recorded feature branch when a git URL is set', () => {
    const gitUrl = 'ssh://git@github.com/acme/repo.git';
    const hash = gitUrlHash(gitUrl);
    const run = makeRun({ source: { git: { url: gitUrl } } });
    const script = buildCleanupJob(run).spec.template.spec.containers[0]?.args?.[0] ?? '';
    const mirrorDir = `/data/git-mirrors/${hash}`;

    expect(script).toContain(`if [ -d "${mirrorDir}" ]; then`);
    expect(script).toContain(
      `git -C "${mirrorDir}" worktree prune --expire=now 2>/dev/null || true`,
    );
    // mirrorDir is interpolated at render time; the BRANCH ref-strip stays
    // literal in the generated script (escaped \$ in ttl.ts).
    expect(script).toContain(`git -C "${mirrorDir}" branch -D "\${BRANCH#refs/heads/}"`);
    expect(script).toContain(`git -C "${mirrorDir}" gc --auto 2>/dev/null || true`);
    // The branch deletion is guarded by the captured branch being non-empty.
    expect(script).toContain('if [ -n "$BRANCH" ]; then');
    expect(script).toContain('fi');
  });

  it('omits the mirror prune block entirely when no git URL is configured', () => {
    const run = makeRun({ source: { local: true } });
    const script = buildCleanupJob(run).spec.template.spec.containers[0]?.args?.[0] ?? '';
    expect(script).not.toContain('git-mirrors');
    expect(script).not.toContain('worktree prune');
    expect(script).not.toContain('branch -D');
    expect(script).not.toContain('gc --auto');
  });
});
