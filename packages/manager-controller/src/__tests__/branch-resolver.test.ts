// branch-resolver.test.ts
//
// Coverage for test gap C1 from percussionist-dev-plan-4abf54. The branch
// naming contract (`feature/{plan}`, `feature/{plan}--{build}`) and the error
// paths (BUILD referencing a missing parent PLAN) are load-bearing for every
// feature-branched task — resolveTaskBranch/resolveParentBranch/
// resolveMergeBranch feed the worker, merge and PR-open run builders, so a
// regression here wedges every feature-branched run.

import { describe, expect, it } from 'bun:test';
import type { Task } from '@percussionist/api';
import { resolveMergeBranch, resolveParentBranch, resolveTaskBranch } from '../branch-resolver.js';
import { makeProject, makeTask } from '../reconciler/__tests__/fixtures.js';

/** A project with feature branching enabled and a source ref. */
function featureProject() {
  return makeProject('proj-a', {
    featureBranchingEnabled: true,
    source: { git: { url: 'https://github.com/acme/proj.git', ref: 'main' } },
  });
}

/** A project with feature branching enabled but no source ref (defaults to main). */
function featureProjectNoRef() {
  return makeProject('proj-a', { featureBranchingEnabled: true });
}

function plan(name = 'plan-abc'): Task {
  return makeTask(name, 'proj-a', { type: 'PLAN' });
}

function buildWithParent(name = 'build-123', parent = 'plan-abc'): Task {
  return makeTask(name, 'proj-a', { type: 'BUILD', parentTaskRef: parent });
}

// ---------------------------------------------------------------------------
// resolveTaskBranch — the branch a task works on
// ---------------------------------------------------------------------------

describe('resolveTaskBranch — feature branching disabled', () => {
  it('returns undefined for every task type (project default ref is used)', () => {
    const project = makeProject('proj-a'); // featureBranchingEnabled not set
    expect(resolveTaskBranch(plan(), project, [plan()])).toBeUndefined();
    expect(resolveTaskBranch(buildWithParent(), project, [plan()])).toBeUndefined();
    expect(resolveTaskBranch(makeTask('build-standalone', 'proj-a'), project, [])).toBeUndefined();
  });
});

describe('resolveTaskBranch — naming contract', () => {
  it('PLAN task → feature/{plan-task-id}', () => {
    const branch = resolveTaskBranch(plan('plan-abc'), featureProject(), []);
    expect(branch).toBe('feature/plan-abc');
  });

  it('BUILD task with parent PLAN → feature/{plan-task-id}--{build-task-id}', () => {
    const parent = plan('plan-abc');
    const build = buildWithParent('build-123');
    const branch = resolveTaskBranch(build, featureProject(), [parent, build]);
    expect(branch).toBe('feature/plan-abc--build-123');
  });

  it('standalone BUILD task → feature/{build-task-id}', () => {
    const branch = resolveTaskBranch(makeTask('build-99', 'proj-a'), featureProject(), []);
    expect(branch).toBe('feature/build-99');
  });

  it('a BUILD whose parent is itself a BUILD chains the branches', () => {
    const root = plan('plan-abc');
    const mid = buildWithParent('build-1');
    const leaf = buildWithParent('build-2', 'build-1');
    const branch = resolveTaskBranch(leaf, featureProject(), [root, mid, leaf]);
    expect(branch).toBe('feature/plan-abc--build-1--build-2');
  });

  it('reuses an already-assigned worker.gitBranch (idempotent across reconciles)', () => {
    const build = buildWithParent('build-123');
    build.status = {
      ...build.status,
      worker: { ...build.status?.worker, gitBranch: 'feature/plan-abc--build-123-retry' },
    };
    const branch = resolveTaskBranch(build, featureProject(), [plan('plan-abc')]);
    expect(branch).toBe('feature/plan-abc--build-123-retry');
  });
});

describe('resolveTaskBranch — error paths', () => {
  it('throws when a BUILD references a parent PLAN that does not exist in allTasks', () => {
    const build = buildWithParent('build-123', 'ghost-plan');
    expect(() => resolveTaskBranch(build, featureProject(), [build])).toThrow(
      /BUILD task build-123 references non-existent parent PLAN: ghost-plan/,
    );
  });

  it('throws when the task has no metadata.name', () => {
    expect(() => resolveTaskBranch(plan(''), featureProject(), [])).toThrow(
      /Task has no metadata.name/,
    );
  });

  it('throws for an unknown task type', () => {
    const weird = makeTask('weird', 'proj-a', { type: 'BUILD' });
    (weird.spec as { type: string }).type = 'REVIEW';
    expect(() => resolveTaskBranch(weird, featureProject(), [])).toThrow(
      /Unknown task type: REVIEW/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveParentBranch — the branch a task is created from
// ---------------------------------------------------------------------------

describe('resolveParentBranch — feature branching disabled', () => {
  it('returns undefined (project default ref is used)', () => {
    const project = makeProject('proj-a');
    expect(resolveParentBranch(plan(), project, [plan()])).toBeUndefined();
    expect(resolveParentBranch(buildWithParent(), project, [plan()])).toBeUndefined();
    expect(resolveParentBranch(makeTask('b', 'proj-a'), project, [])).toBeUndefined();
  });
});

describe('resolveParentBranch — naming contract', () => {
  it('PLAN task is created from the project default ref (source.git.ref or main)', () => {
    expect(resolveParentBranch(plan(), featureProject(), [])).toBe('main');
    expect(resolveParentBranch(plan(), featureProjectNoRef(), [])).toBe('main');
    const refProject = makeProject('proj-a', {
      featureBranchingEnabled: true,
      source: { git: { url: 'https://github.com/acme/proj.git', ref: 'develop' } },
    });
    expect(resolveParentBranch(plan(), refProject, [])).toBe('develop');
  });

  it('BUILD task with parent PLAN is created from the parent’s feature branch', () => {
    const parent = plan('plan-abc');
    const build = buildWithParent('build-123');
    expect(resolveParentBranch(build, featureProject(), [parent, build])).toBe('feature/plan-abc');
  });

  it('standalone BUILD task is created from the project default ref', () => {
    expect(resolveParentBranch(makeTask('build-99', 'proj-a'), featureProject(), [])).toBe('main');
  });

  it('reuses an already-assigned worker.parentBranch (idempotent)', () => {
    const build = buildWithParent('build-123');
    build.status = {
      ...build.status,
      worker: { ...build.status?.worker, parentBranch: 'feature/plan-abc-old' },
    };
    expect(resolveParentBranch(build, featureProject(), [plan('plan-abc')])).toBe(
      'feature/plan-abc-old',
    );
  });
});

describe('resolveParentBranch — error paths', () => {
  it('throws when a BUILD references a missing parent PLAN', () => {
    const build = buildWithParent('build-123', 'ghost-plan');
    expect(() => resolveParentBranch(build, featureProject(), [build])).toThrow(
      /BUILD task build-123 references non-existent parent PLAN: ghost-plan/,
    );
  });

  it('throws when the task has no metadata.name', () => {
    expect(() => resolveParentBranch(plan(''), featureProject(), [])).toThrow(
      /Task has no metadata.name/,
    );
  });

  it('throws for an unknown task type', () => {
    const weird = makeTask('weird', 'proj-a', { type: 'BUILD' });
    (weird.spec as { type: string }).type = 'REVIEW';
    expect(() => resolveParentBranch(weird, featureProject(), [])).toThrow(
      /Unknown task type: REVIEW/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveMergeBranch — the target a task merges into on approval
// ---------------------------------------------------------------------------

describe('resolveMergeBranch — feature branching disabled', () => {
  it('returns undefined (no auto-merge when feature branching is off)', () => {
    const project = makeProject('proj-a');
    expect(resolveMergeBranch(plan(), project, [plan()])).toBeUndefined();
    expect(resolveMergeBranch(buildWithParent(), project, [plan()])).toBeUndefined();
    expect(resolveMergeBranch(makeTask('b', 'proj-a'), project, [])).toBeUndefined();
  });
});

describe('resolveMergeBranch — naming contract', () => {
  it('PLAN task merges into the project default ref', () => {
    expect(resolveMergeBranch(plan(), featureProject(), [])).toBe('main');
    const refProject = makeProject('proj-a', {
      featureBranchingEnabled: true,
      source: { git: { url: 'https://github.com/acme/proj.git', ref: 'trunk' } },
    });
    expect(resolveMergeBranch(plan(), refProject, [])).toBe('trunk');
  });

  it('BUILD task with parent PLAN merges into the parent’s feature branch', () => {
    const parent = plan('plan-abc');
    const build = buildWithParent('build-123');
    expect(resolveMergeBranch(build, featureProject(), [parent, build])).toBe('feature/plan-abc');
  });

  it('standalone BUILD task merges into the project default ref', () => {
    expect(resolveMergeBranch(makeTask('build-99', 'proj-a'), featureProject(), [])).toBe('main');
  });

  it('reuses an already-assigned worker.mergeIntoBranch (idempotent)', () => {
    const build = buildWithParent('build-123');
    build.status = {
      ...build.status,
      worker: { ...build.status?.worker, mergeIntoBranch: 'feature/plan-abc' },
    };
    expect(resolveMergeBranch(build, featureProject(), [plan('plan-abc')])).toBe(
      'feature/plan-abc',
    );
  });
});

describe('resolveMergeBranch — error paths', () => {
  it('throws when a BUILD references a missing parent PLAN', () => {
    const build = buildWithParent('build-123', 'ghost-plan');
    expect(() => resolveMergeBranch(build, featureProject(), [build])).toThrow(
      /BUILD task build-123 references non-existent parent PLAN: ghost-plan/,
    );
  });

  it('throws when the task has no metadata.name', () => {
    expect(() => resolveMergeBranch(plan(''), featureProject(), [])).toThrow(
      /Task has no metadata.name/,
    );
  });

  it('throws for an unknown task type', () => {
    const weird = makeTask('weird', 'proj-a', { type: 'BUILD' });
    (weird.spec as { type: string }).type = 'REVIEW';
    expect(() => resolveMergeBranch(weird, featureProject(), [])).toThrow(
      /Unknown task type: REVIEW/,
    );
  });
});
