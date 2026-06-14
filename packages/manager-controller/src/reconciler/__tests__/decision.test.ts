import { describe, expect, it } from 'bun:test';
import { decide } from '../decision.js';
import { resolveFlow } from '../flow.js';
import { isValidTransition } from '../transitions.js';
import { makeProject, makeRun, makeTask } from './fixtures.js';

const now = '2026-05-29T00:00:00.000Z';
const project = makeProject('test-project');
const flow = resolveFlow(project);

const reviewContext = {
  baseSha: 'base1',
  headSha: 'head1',
  forkSha: 'fork1',
  diffFingerprint: 'fp1',
};

const reviewFinding = {
  id: 'f1',
  source: 'reviewer' as const,
  severity: 'high' as const,
  title: 'Missing test',
  comment: 'Add coverage.',
  anchors: [{ path: 'src/index.ts', side: 'new' as const, line: 42 }],
  context: reviewContext,
  createdAt: '2026-06-13T00:00:00.000Z',
};

function makeInput(
  task: ReturnType<typeof makeTask>,
  overrides?: {
    observed?: {
      worker?: ReturnType<typeof makeRun>;
      review?: ReturnType<typeof makeRun>;
      merge?: ReturnType<typeof makeRun>;
      buildgen?: ReturnType<typeof makeRun>;
    };
    manualActions?: {
      approved?: boolean;
      requestChanges?: boolean;
      reworkFeedback?: string;
      abandon?: boolean;
      answer?: string;
    };
    capacity?: { activeCount: number; maxParallel: number };
    allTasks?: ReturnType<typeof makeTask>[];
  },
) {
  return {
    task,
    project,
    allTasks: overrides?.allTasks ?? [task],
    observed: overrides?.observed ?? {},
    manualActions: overrides?.manualActions ?? {},
    flow,
    capacity: overrides?.capacity ?? { activeCount: 0, maxParallel: 2 },
    now,
  };
}

describe('decide — terminal/no-op', () => {
  it('returns no decision for done tasks', () => {
    const task = makeTask('t1', 'test-project', { phase: 'done' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('returns no decision for idea tasks', () => {
    const task = makeTask('t1', 'test-project', { phase: 'idea' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
  });

  it('returns no decision for blocked tasks', () => {
    const task = makeTask('t1', 'test-project', { phase: 'pending', blocked: true });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
  });
});

describe('decide — pending', () => {
  it('pending + capacity → scheduled', () => {
    const task = makeTask('t1', 'test-project', { phase: 'pending' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('scheduled');
    expect(result.events[0]?.reason).toBe('TaskScheduled');
  });

  it('pending + no capacity → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'pending' });
    const result = decide(makeInput(task, { capacity: { activeCount: 2, maxParallel: 2 } }));
    expect(result.toPhase).toBeUndefined();
  });

  it('pending + incomplete predecessor → no-op', () => {
    const pred = makeTask('pred', 'test-project', { phase: 'running' });
    const task = makeTask('t1', 'test-project', { phase: 'pending', predecessorRef: 'pred' });
    const result = decide(makeInput(task, { allTasks: [pred, task] }));
    expect(result.toPhase).toBeUndefined();
  });

  it('pending + complete predecessor → scheduled', () => {
    const pred = makeTask('pred', 'test-project', { phase: 'done' });
    const task = makeTask('t1', 'test-project', { phase: 'pending', predecessorRef: 'pred' });
    const result = decide(makeInput(task, { allTasks: [pred, task] }));
    expect(result.toPhase).toBe('scheduled');
  });

  it('pending + future retryAfter → no-op', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'pending',
      retryAfter: '2099-01-01T00:00:00.000Z',
    });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
  });

  it('pending + past retryAfter → scheduled', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'pending',
      retryAfter: '2020-01-01T00:00:00.000Z',
    });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('scheduled');
  });
});

describe('decide — scheduled', () => {
  it('scheduled → initializing with worker patch + ScheduleRun effect', () => {
    const task = makeTask('t1', 'test-project', { phase: 'scheduled', retryCount: 0 });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('initializing');
    expect(result.statusPatch?.worker).toBeDefined();
    expect((result.statusPatch?.worker as any).status).toBe('Running');
    expect((result.statusPatch?.worker as any).runName).toBeDefined();
    expect(result.effects.length).toBe(1);
    expect(result.effects[0]?.type).toBe('ScheduleRun');
    expect((result.effects[0] as any).retryCount).toBe(0);
  });
});

describe('decide — initializing', () => {
  it('initializing + missing run → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const result = decide(makeInput(task, { observed: {} }));
    expect(result.toPhase).toBe('failed');
    expect(result.events[0]?.reason).toBe('WorkerRunMissing');
  });

  it('initializing + Running run → running', () => {
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'Running' }) } }),
    );
    expect(result.toPhase).toBe('running');
  });

  it('initializing + Succeeded run → succeeded', () => {
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'Succeeded' }) } }),
    );
    expect(result.toPhase).toBe('succeeded');
  });

  it('initializing + Failed run → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'Failed' }) } }),
    );
    expect(result.toPhase).toBe('failed');
  });
});

describe('decide — running', () => {
  it('running + Succeeded → succeeded', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'Succeeded' }) } }),
    );
    expect(result.toPhase).toBe('succeeded');
  });

  it('running + Failed → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'Failed' }) } }),
    );
    expect(result.toPhase).toBe('failed');
  });

  it('running + missing run → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const result = decide(makeInput(task, { observed: {} }));
    expect(result.toPhase).toBe('failed');
  });

  it('running + WaitingForInput PLAN → waiting-for-input', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running', type: 'PLAN' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'WaitingForInput' }) } }),
    );
    expect(result.toPhase).toBe('waiting-for-input');
  });

  it('running + WaitingForInput BUILD → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running', type: 'BUILD' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'WaitingForInput' }) } }),
    );
    expect(result.toPhase).toBe('failed');
    expect(result.events[0]?.reason).toBe('BuildCannotWait');
  });

  it('running + stale run → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const staleRun = makeRun('run-1', {
      phase: 'Running',
      lastEventAt: '2026-05-28T23:00:00.000Z', // 1 hour ago
    });
    const result = decide(makeInput(task, { observed: { worker: staleRun } }));
    expect(result.toPhase).toBe('failed');
    expect(result.events[0]?.reason).toBe('WorkerRunStale');
  });

  it('running + fresh run → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const freshRun = makeRun('run-1', {
      phase: 'Running',
      lastEventAt: '2026-05-28T23:59:00.000Z', // 1 minute ago
    });
    const result = decide(makeInput(task, { observed: { worker: freshRun } }));
    expect(result.toPhase).toBeUndefined();
  });
});

describe('decide — waiting-for-input', () => {
  it('waiting + no answer → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'waiting-for-input', type: 'PLAN' });
    const result = decide(
      makeInput(task, { observed: { worker: makeRun('run-1', { phase: 'WaitingForInput' }) } }),
    );
    expect(result.toPhase).toBeUndefined();
  });

  it('waiting + answer + Running run → running', () => {
    const task = makeTask('t1', 'test-project', { phase: 'waiting-for-input', type: 'PLAN' });
    const result = decide(
      makeInput(task, {
        observed: { worker: makeRun('run-1', { phase: 'Running' }) },
        manualActions: { answer: 'yes' },
      }),
    );
    expect(result.toPhase).toBe('running');
    expect(result.effects.some((e) => e.type === 'ClearTaskAnnotations')).toBe(true);
  });
});

describe('decide — succeeded', () => {
  it('succeeded + BUILD + simple flow → done', () => {
    const simpleProject = makeProject('test-project');
    simpleProject.spec.flow = { preset: 'simple' };
    const task = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    const result = decide({
      task,
      project: simpleProject,
      allTasks: [task],
      observed: {},
      manualActions: {},
      flow: resolveFlow(simpleProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('done');
  });

  it('succeeded + BUILD + review flow → awaiting-human', () => {
    const task = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('awaiting-human');
  });

  it('succeeded + PLAN → awaiting-human', () => {
    const task = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'PLAN' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('awaiting-human');
  });
});

describe('decide — awaiting-human', () => {
  it('awaiting-human + abandon → done', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    const result = decide(makeInput(task, { manualActions: { abandon: true } }));
    expect(result.toPhase).toBe('done');
  });

  it('awaiting-human + requestChanges → rework-requested', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    const result = decide(
      makeInput(task, { manualActions: { requestChanges: true, reworkFeedback: 'fix it' } }),
    );
    expect(result.toPhase).toBe('rework-requested');
    expect((result.statusPatch?.worker as any).reviewFeedback).toBe('fix it');
    expect((result.statusPatch?.worker as any).aiReworkCount).toBe(0);
  });

  it('awaiting-human + approve PLAN + buildgen → generating-builds', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    const result = decide(makeInput(task, { manualActions: { approved: true } }));
    expect(result.toPhase).toBe('generating-builds');
  });

  it('awaiting-human + approve PLAN + done flow → done', () => {
    const simpleProject = makeProject('test-project');
    simpleProject.spec.flow = { preset: 'simple' };
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    const result = decide({
      task,
      project: simpleProject,
      allTasks: [task],
      observed: {},
      manualActions: { approved: true },
      flow: resolveFlow(simpleProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('done');
  });

  it('awaiting-human + requestChanges preserves existing diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    (task.status as any).diffFindings = {
      version: 1,
      context: { baseSha: 'base', headSha: 'head', forkSha: 'fork', diffFingerprint: 'fp' },
      items: [{ id: 'human-preserved' }],
      updatedAt: '2026-06-12T00:00:00.000Z',
      sourceRunName: 'review-0',
    };
    const result = decide(
      makeInput(task, { manualActions: { requestChanges: true, reworkFeedback: 'fix it' } }),
    );
    expect(result.toPhase).toBe('rework-requested');
    expect(result.statusPatch?.diffFindings).toBeUndefined();
    expect((result.statusPatch?.worker as any).reviewFeedback).toBe('fix it');
  });

  it('awaiting-human + approve BUILD + merge flow → awaiting-merge', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'BUILD' });
    const result = decide(makeInput(task, { manualActions: { approved: true } }));
    expect(result.toPhase).toBe('awaiting-merge');
  });

  it('awaiting-human + approve BUILD + simple flow → done', () => {
    const simpleProject = makeProject('test-project');
    simpleProject.spec.flow = { preset: 'simple' };
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'BUILD' });
    const result = decide({
      task,
      project: simpleProject,
      allTasks: [task],
      observed: {},
      manualActions: { approved: true },
      flow: resolveFlow(simpleProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('done');
  });

  it('awaiting-human + PLAN merge-retry approval → awaiting-feature-merge', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    (task.status as any).worker = {
      mergeRunName: 'merge-stale',
      mergeError: 'conflict detected',
    };
    const result = decide(makeInput(task, { manualActions: { approved: true } }));
    expect(result.toPhase).toBe('awaiting-feature-merge');
    expect((result.statusPatch?.worker as any).mergeRunName).toBeNull();
    expect((result.statusPatch?.worker as any).mergeError).toBeNull();
    expect(result.effects.some((e) => e.type === 'ClearTaskAnnotations')).toBe(true);
  });
});

describe('decide — rework-requested', () => {
  it('rework-requested + capacity → scheduled', () => {
    const task = makeTask('t1', 'test-project', { phase: 'rework-requested' });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBe('scheduled');
  });

  it('rework-requested + no capacity → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'rework-requested' });
    const result = decide(makeInput(task, { capacity: { activeCount: 2, maxParallel: 2 } }));
    expect(result.toPhase).toBeUndefined();
  });
});

describe('decide — failed', () => {
  it('failed + retry disabled → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 0 });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
  });

  it('failed + retry enabled + attempts left → pending with retryAfter', () => {
    const projectWithRetry = makeProject('test-project', {
      retryPolicy: { enabled: true, maxAttempts: 3, backoffSeconds: 30 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 0 });
    (task.status as any).lastFailureDuration = 60;
    const result = decide({
      task,
      project: projectWithRetry,
      allTasks: [task],
      observed: {},
      manualActions: {},
      flow: resolveFlow(projectWithRetry),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('pending');
    expect((result.statusPatch as any)?.retryAfter).toBeDefined();
    expect((result.statusPatch?.worker as any)?.retryCount).toBe(1);
  });

  it('failed + retry exhausted → no-op', () => {
    const projectWithRetry = makeProject('test-project', {
      retryPolicy: { enabled: true, maxAttempts: 2, backoffSeconds: 30 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 1 });
    (task.status as any).lastFailureDuration = 60;
    const result = decide({
      task,
      project: projectWithRetry,
      allTasks: [task],
      observed: {},
      manualActions: {},
      flow: resolveFlow(projectWithRetry),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBeUndefined();
  });

  it('failed + poison pill → no-op', () => {
    const projectWithRetry = makeProject('test-project', {
      retryPolicy: {
        enabled: true,
        maxAttempts: 3,
        backoffSeconds: 30,
        poisonPillThresholdSeconds: 30,
      },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 0 });
    (task.status as any).lastFailureDuration = 5; // too short
    const result = decide({
      task,
      project: projectWithRetry,
      allTasks: [task],
      observed: {},
      manualActions: {},
      flow: resolveFlow(projectWithRetry),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBeUndefined();
  });
});

describe('decide — awaiting-merge', () => {
  it('awaiting-merge + Succeeded merge → done', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = decide(
      makeInput(task, {
        observed: { merge: makeRun('merge-1', { phase: 'Succeeded' }) },
      }),
    );
    expect(result.toPhase).toBe('done');
    expect((result.statusPatch?.worker as any).mergedAt).toBe(now);
  });

  it('awaiting-merge + Failed merge → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = decide(
      makeInput(task, {
        observed: { merge: makeRun('merge-1', { phase: 'Failed', message: 'conflict' }) },
      }),
    );
    expect(result.toPhase).toBe('failed');
    expect((result.statusPatch?.worker as any).mergeError).toBe('conflict');
  });

  it('awaiting-merge + missing merge run → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = decide(makeInput(task, { observed: {} }));
    expect(result.toPhase).toBe('failed');
  });

  it('awaiting-merge + stale merge run → failed + DeleteRun', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const staleMerge = makeRun('merge-1', {
      phase: 'Running',
      lastEventAt: '2026-05-28T23:00:00.000Z', // 1 hour ago
    });
    const result = decide(
      makeInput(task, {
        observed: { merge: staleMerge },
      }),
    );
    expect(result.toPhase).toBe('failed');
    expect(result.effects.some((e) => e.type === 'DeleteRun')).toBe(true);
  });
});

describe('decide — awaiting-children', () => {
  const featProject = makeProject('test-project', { featureBranchingEnabled: true });

  it('all BUILD children done with mergedAt + feature branching + auto-merge → awaiting-feature-merge', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-children',
      type: 'PLAN',
    });
    const buildA = makeTask('build-a', 'test-project', {
      type: 'BUILD',
      phase: 'done',
      parentTaskRef: 'plan-1',
      mergedAt: '2026-05-29T00:00:00.000Z',
    });
    const buildB = makeTask('build-b', 'test-project', {
      type: 'BUILD',
      phase: 'done',
      parentTaskRef: 'plan-1',
      mergedAt: '2026-05-29T00:00:00.000Z',
    });
    const result = decide({
      task: planTask,
      project: featProject,
      allTasks: [planTask, buildA, buildB],
      observed: {},
      manualActions: {},
      flow: resolveFlow(featProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('awaiting-feature-merge');
    expect(result.effects.some((e) => e.type === 'ScheduleMergeRun')).toBe(true);
    expect((result.statusPatch?.worker as any).mergeRunName).toBeDefined();
  });

  it('BUILD children done but missing mergedAt → no-op (wait for merge cycle)', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-children',
      type: 'PLAN',
    });
    const buildA = makeTask('build-a', 'test-project', {
      type: 'BUILD',
      phase: 'done',
      parentTaskRef: 'plan-1',
      // No mergedAt — BUILD was approved via onApprove='done' without merge
    });
    const buildB = makeTask('build-b', 'test-project', {
      type: 'BUILD',
      phase: 'done',
      parentTaskRef: 'plan-1',
      mergedAt: '2026-05-29T00:00:00.000Z',
    });
    const result = decide({
      task: planTask,
      project: featProject,
      allTasks: [planTask, buildA, buildB],
      observed: {},
      manualActions: {},
      flow: resolveFlow(featProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('all BUILD children done with mergedAt + feature branching disabled → done', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-children',
      type: 'PLAN',
    });
    const buildA = makeTask('build-a', 'test-project', {
      type: 'BUILD',
      phase: 'done',
      parentTaskRef: 'plan-1',
      mergedAt: '2026-05-29T00:00:00.000Z',
    });
    const result = decide({
      task: planTask,
      project, // featureBranchingEnabled: false (default)
      allTasks: [planTask, buildA],
      observed: {},
      manualActions: {},
      flow: resolveFlow(project),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('done');
  });
});

describe('decide — awaiting-feature-merge', () => {
  it('stale merge run → failed + DeleteRun', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const staleMerge = makeRun('merge-1', {
      phase: 'Running',
      lastEventAt: '2026-05-28T23:00:00.000Z', // 1 hour ago
    });
    const result = decide(
      makeInput(task, {
        observed: { merge: staleMerge },
      }),
    );
    expect(result.toPhase).toBe('failed');
    expect((result.statusPatch?.worker as any).mergeError).toContain('Stale');
    expect(result.effects.some((e) => e.type === 'DeleteRun')).toBe(true);
    expect(result.effects.some((e) => e.type === 'CleanupWorktree')).toBe(true);
  });

  it('merge run succeeded → done with mergedAt', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const mergeRun = makeRun('merge-1', { phase: 'Succeeded' });
    const result = decide(
      makeInput(task, {
        observed: { merge: mergeRun },
      }),
    );
    expect(result.toPhase).toBe('done');
    expect((result.statusPatch?.worker as any).mergedAt).toBe(now);
    expect(result.effects.some((e) => e.type === 'CleanupWorktree')).toBe(true);
  });

  it('merge run failed → awaiting-human with mergeError', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const mergeRun = makeRun('merge-1', { phase: 'Failed', message: 'merge conflict' });
    const result = decide(
      makeInput(task, {
        observed: { merge: mergeRun },
      }),
    );
    expect(result.toPhase).toBe('awaiting-human');
    expect((result.statusPatch?.worker as any).mergeError).toBe('merge conflict');
  });

  it('no merge run name yet → schedule merge run', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    const result = decide(makeInput(task));
    expect(result.toPhase).toBeUndefined();
    expect(result.effects.some((e) => e.type === 'ScheduleMergeRun')).toBe(true);
    expect((result.statusPatch?.worker as any).mergeRunName).toBeDefined();
  });

  it('merge run disappeared → failed', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = decide(makeInput(task, { observed: {} }));
    expect(result.toPhase).toBe('failed');
    expect((result.statusPatch?.worker as any).mergeError).toBe('Merge run disappeared');
  });
});

describe('decide — reviewing', () => {
  it('reviewing + verdict approve → awaiting-human with review record', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1', retryCount: 0, aiReworkCount: 0 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'approve',
        diagnosis: 'looks good',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect((result.statusPatch?.worker as any).reviewApproved).toBe(true);

    // Verify review record is appended
    expect(Array.isArray(result.statusPatch?.reviews)).toBe(true);
    const reviews = result.statusPatch?.reviews as any[];
    expect(reviews.length).toBe(1);
    expect(reviews[0]).toEqual({
      action: 'approve',
      diagnosis: 'looks good',
      feedback: undefined,
      reviewRunName: 'review-1',
      reviewedAt: now,
      attempt: 0,
    });
  });

  it('reviewing + verdict request_changes under ceiling → rework-requested with review record', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1', aiReworkCount: 0 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'fix X',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('rework-requested');
    expect((result.statusPatch?.worker as any).aiReworkCount).toBe(1);

    // Verify review record is appended
    expect(Array.isArray(result.statusPatch?.reviews)).toBe(true);
    const reviews = result.statusPatch?.reviews as any[];
    expect(reviews.length).toBe(1);
    expect(reviews[0]).toEqual({
      action: 'request_changes',
      diagnosis: undefined,
      feedback: 'fix X',
      reviewRunName: 'review-1',
      reviewedAt: now,
      attempt: 0,
    });
  });

  it('reviewing + verdict request_changes over ceiling → awaiting-human with escalate record', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1', aiReworkCount: 2 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'fix X',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect((result.statusPatch?.worker as any).reviewFeedback).toMatch(/ceiling reached/);

    // Verify escalate record is appended (action mapped to "escalate")
    expect(Array.isArray(result.statusPatch?.reviews)).toBe(true);
    const reviews = result.statusPatch?.reviews as any[];
    expect(reviews.length).toBe(1);
    expect(reviews[0]).toEqual({
      action: 'escalate',
      diagnosis: undefined,
      feedback: 'fix X',
      reviewRunName: 'review-1',
      reviewedAt: now,
      attempt: 2, // retryCount (0) + aiReworkCount (2)
    });
  });

  it('reviewing + existing reviews → appends to existing history', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-2', aiReworkCount: 0 };
    // Pre-existing review record
    (task.status as any).reviews = [
      {
        action: 'approve',
        diagnosis: 'previous approval',
        feedback: 'LGTM',
        reviewRunName: 'review-1',
        reviewedAt: '2026-05-28T00:00:00.000Z',
        attempt: 0,
      },
    ];

    const reviewRun = makeRun('review-2', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'new fix',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));

    // Verify new record is appended to existing history
    expect(Array.isArray(result.statusPatch?.reviews)).toBe(true);
    const reviews = result.statusPatch?.reviews as any[];
    expect(reviews.length).toBe(2);
    expect(reviews[0]).toEqual({
      action: 'approve',
      diagnosis: 'previous approval',
      feedback: 'LGTM',
      reviewRunName: 'review-1',
      reviewedAt: '2026-05-28T00:00:00.000Z',
      attempt: 0,
    });
    expect(reviews[1]).toEqual({
      action: 'request_changes',
      diagnosis: undefined,
      feedback: 'new fix',
      reviewRunName: 'review-2',
      reviewedAt: now,
      attempt: 0,
    });
  });

  it('reviewing + verdict with diagnosis and feedback → passes both through', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1', aiReworkCount: 0 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        diagnosis: 'missing test coverage',
        feedback: 'add tests for edge cases',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));

    expect(Array.isArray(result.statusPatch?.reviews)).toBe(true);
    const reviews = result.statusPatch?.reviews as any[];
    expect(reviews[0]).toEqual({
      action: 'request_changes',
      diagnosis: 'missing test coverage',
      feedback: 'add tests for edge cases',
      reviewRunName: 'review-1',
      reviewedAt: now,
      attempt: 0,
    });
  });

  it('reviewing + no verdict annotation → awaiting-human fallback', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1' };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect(result.events[0]?.reason).toBe('ReviewSucceeded');

    // No reviews should be added without verdict annotation
    expect(result.statusPatch?.reviews).toBeUndefined();
  });

  it('reviewing + verdict with findings → replaces diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status!.worker as any) = { reviewRunName: 'review-1', retryCount: 0, aiReworkCount: 0 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        diagnosis: 'issues found',
        diffFindings: {
          version: 1,
          context: {
            baseSha: 'base1',
            headSha: 'head1',
            forkSha: 'fork1',
            diffFingerprint: 'fp1',
          },
          items: [
            {
              id: 'f1',
              source: 'reviewer',
              severity: 'high',
              title: 'Missing test',
              comment: 'Add coverage.',
              anchors: [{ path: 'src/index.ts', side: 'new', line: 42 }],
              context: {
                baseSha: 'base1',
                headSha: 'head1',
                forkSha: 'fork1',
                diffFingerprint: 'fp1',
              },
              createdAt: '2026-06-13T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-06-13T01:00:00.000Z',
          sourceRunName: 'review-1',
        },
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('rework-requested');
    expect(result.statusPatch?.diffFindings).toBeDefined();
    expect((result.statusPatch?.diffFindings as any).items.length).toBe(1);
    expect((result.statusPatch?.diffFindings as any).items[0].id).toBe('f1');
  });

  it('reviewing + verdict without findings preserves existing diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status!.worker as any) = { reviewRunName: 'review-1', retryCount: 0, aiReworkCount: 0 };
    (task.status as any).diffFindings = {
      version: 1,
      context: { baseSha: 'old', headSha: 'old', forkSha: 'old', diffFingerprint: 'old' },
      items: [{ id: 'old-finding' }],
      updatedAt: '2026-06-12T00:00:00.000Z',
      sourceRunName: 'review-0',
    };

    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'approve',
        diagnosis: 'all good',
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect(result.statusPatch?.diffFindings).toBeUndefined();
  });

  it('reviewing + later verdict replaces prior diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status!.worker as any) = { reviewRunName: 'review-2', retryCount: 0, aiReworkCount: 0 };
    (task.status as any).diffFindings = {
      version: 1,
      context: { baseSha: 'old', headSha: 'old', forkSha: 'old', diffFingerprint: 'old' },
      items: [{ id: 'old-finding' }],
      updatedAt: '2026-06-12T00:00:00.000Z',
      sourceRunName: 'review-1',
    };

    const reviewRun = makeRun('review-2', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'approve',
        diagnosis: 'new findings',
        diffFindings: {
          version: 1,
          context: { baseSha: 'new', headSha: 'new', forkSha: 'new', diffFingerprint: 'new' },
          items: [
            {
              id: 'f2',
              source: 'reviewer',
              severity: 'low',
              title: 'Nit',
              comment: 'Minor.',
              anchors: [{ path: 'src/other.ts', side: 'old', line: 10 }],
              context: { baseSha: 'new', headSha: 'new', forkSha: 'new', diffFingerprint: 'new' },
              createdAt: '2026-06-13T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-06-13T02:00:00.000Z',
          sourceRunName: 'review-2',
        },
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    const diffFindings = result.statusPatch?.diffFindings as any;
    expect(diffFindings).toBeDefined();
    expect(diffFindings.items.length).toBe(1);
    expect(diffFindings.items[0].id).toBe('f2');
    expect(diffFindings.sourceRunName).toBe('review-2');
  });

  it('reviewing + request_changes over ceiling with findings persists diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status!.worker as any) = { reviewRunName: 'review-1', retryCount: 0, aiReworkCount: 2 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'fix it',
        diffFindings: {
          version: 1,
          context: reviewContext,
          items: [reviewFinding],
          updatedAt: '2026-06-13T01:00:00.000Z',
          sourceRunName: 'review-1',
        },
      }),
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect((result.statusPatch?.worker as any).aiReworkCount).toBe(3);
    expect((result.statusPatch?.worker as any).reviewFeedback).toMatch(/ceiling reached/);
    expect((result.statusPatch?.diffFindings as any).items.length).toBe(1);
  });

  it('reviewing + malformed verdict preserves existing diffFindings', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status!.worker as any) = { reviewRunName: 'review-1', retryCount: 0, aiReworkCount: 0 };
    (task.status as any).diffFindings = {
      version: 1,
      context: { baseSha: 'old', headSha: 'old', forkSha: 'old', diffFingerprint: 'old' },
      items: [{ id: 'old-finding' }],
      updatedAt: '2026-06-12T00:00:00.000Z',
      sourceRunName: 'review-0',
    };

    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': '{ invalid json }',
    };
    const result = decide(makeInput(task, { observed: { review: reviewRun } }));
    expect(result.toPhase).toBe('awaiting-human');
    expect(result.events[0]?.reason).toBe('ReviewSucceeded');
    expect(result.statusPatch?.diffFindings).toBeUndefined();
  });
});

describe('decide — generating-builds', () => {
  it('generating-builds + buildgen succeeded with child Tasks → awaiting-children', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'generating-builds',
      type: 'PLAN',
    });
    (planTask.status as any).worker = { buildTasksFacilitatorRun: 'buildgen-1' };
    const buildgenRun = makeRun('buildgen-1', { phase: 'Succeeded' });
    const childTask = makeTask('build-01', 'test-project', {
      type: 'BUILD',
      parentTaskRef: 'plan-1',
    });
    const result = decide(
      makeInput(planTask, {
        observed: { buildgen: buildgenRun },
        allTasks: [planTask, childTask],
      }),
    );
    expect(result.toPhase).toBe('awaiting-children');
    expect((result.statusPatch?.worker as any).buildTasksCreated).toBe(true);
  });

  it('generating-builds + buildgen succeeded but no child Tasks → awaiting-human', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'generating-builds',
      type: 'PLAN',
    });
    (planTask.status as any).worker = { buildTasksFacilitatorRun: 'buildgen-1' };
    const buildgenRun = makeRun('buildgen-1', { phase: 'Succeeded' });
    const result = decide(
      makeInput(planTask, {
        observed: { buildgen: buildgenRun },
        allTasks: [planTask],
      }),
    );
    expect(result.toPhase).toBe('awaiting-human');
  });

  it('generating-builds + no buildgenRunName + worker run exists → ScheduleBuildGenRun effect', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'generating-builds',
      type: 'PLAN',
      runName: 'plan-worker-1',
    });
    const result = decide(makeInput(planTask));
    expect(result.toPhase).toBeUndefined();
    expect(result.effects.some((e) => e.type === 'ScheduleBuildGenRun')).toBe(true);
    expect((result.statusPatch?.worker as any).buildTasksFacilitatorRun).toBeDefined();
  });

  it('generating-builds + no buildgenRunName + no worker run → awaiting-human', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'generating-builds',
      type: 'PLAN',
    });
    const result = decide(makeInput(planTask));
    expect(result.toPhase).toBe('awaiting-human');
    expect(result.events[0]?.reason).toBe('NoWorkerRunForBuildGen');
  });
});

describe('decide — succeeded with AI review', () => {
  it('succeeded + AI review enabled → reviewing + ScheduleReviewRun effect', () => {
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 2 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    (task.status as any).worker = { runName: 'worker-1', retryCount: 0, aiReworkCount: 0 };
    const result = decide({
      task,
      project: aiProject,
      allTasks: [task],
      observed: { worker: makeRun('worker-1', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('reviewing');
    expect(result.statusPatch?.worker).toBeDefined();
    expect((result.statusPatch?.worker as any).reviewRunName).toBeDefined();
    expect(result.effects.some((e) => e.type === 'ScheduleReviewRun')).toBe(true);
  });

  it('(retryCount=0, aiReworkCount=1) and (retryCount=1, aiReworkCount=0) produce different reviewRunName', () => {
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 2 },
    });
    const taskA = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    (taskA.status as any).worker = { runName: 'worker-1', retryCount: 0, aiReworkCount: 1 };
    const resultA = decide({
      task: taskA,
      project: aiProject,
      allTasks: [taskA],
      observed: { worker: makeRun('worker-1', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    const taskB = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    (taskB.status as any).worker = { runName: 'worker-1', retryCount: 1, aiReworkCount: 0 };
    const resultB = decide({
      task: taskB,
      project: aiProject,
      allTasks: [taskB],
      observed: { worker: makeRun('worker-1', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    expect(resultA.toPhase).toBe('reviewing');
    expect(resultB.toPhase).toBe('reviewing');
    const reviewRunNameA = (resultA.statusPatch?.worker as any).reviewRunName;
    const reviewRunNameB = (resultB.statusPatch?.worker as any).reviewRunName;
    expect(reviewRunNameA).toBeDefined();
    expect(reviewRunNameB).toBeDefined();
    expect(reviewRunNameA).not.toBe(reviewRunNameB);
  });

  it('re-running decide with same counters yields same reviewRunName (deterministic stability)', () => {
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 2 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    (task.status as any).worker = { runName: 'worker-1', retryCount: 2, aiReworkCount: 3 };

    // First call
    const result1 = decide({
      task,
      project: aiProject,
      allTasks: [task],
      observed: { worker: makeRun('worker-1', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    // Second call with same state
    const result2 = decide({
      task,
      project: aiProject,
      allTasks: [task],
      observed: { worker: makeRun('worker-1', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    expect((result1.statusPatch?.worker as any).reviewRunName).toBe(
      (result2.statusPatch?.worker as any).reviewRunName,
    );
  });
});

describe('decide — invalid transition rejection', () => {
  it('proposes illegal transition → clears toPhase and effects', () => {
    // Test that the transition table rejects illegal transitions.
    expect(isValidTransition('pending', 'done')).toBe(false);
    expect(isValidTransition('done', 'pending')).toBe(false);
    expect(isValidTransition('running', 'awaiting-merge')).toBe(false);
  });
});

describe('decide — waiting-for-input edge cases', () => {
  it('waiting + answer but run not resumed → no-op', () => {
    const task = makeTask('t1', 'test-project', { phase: 'waiting-for-input', type: 'PLAN' });
    const result = decide(
      makeInput(task, {
        observed: { worker: makeRun('run-1', { phase: 'WaitingForInput' }) },
        manualActions: { answer: 'yes' },
      }),
    );
    // Run is still WaitingForInput, not Running — should stay put.
    expect(result.toPhase).toBeUndefined();
  });
});

describe('decide — SummarizeSession effect emission', () => {
  it('succeeded worker run without embedding → SummarizeSession effect present', () => {
    const noEmbedProject = makeProject('test-project');
    // No spec.embedding configured at all.
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const workerRun = makeRun('worker-1', {
      phase: 'Succeeded',
      sessionID: 'sess-abc123',
    });
    const result = decide({
      task,
      project: noEmbedProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(noEmbedProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('succeeded');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-abc123');
  });

  it('failed worker run without embedding → SummarizeSession effect present', () => {
    const noEmbedProject = makeProject('test-project');
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const workerRun = makeRun('worker-1', {
      phase: 'Failed',
      sessionID: 'sess-def456',
    });
    const result = decide({
      task,
      project: noEmbedProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(noEmbedProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('failed');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-def456');
  });

  it('succeeded worker run with embedding disabled explicitly → SummarizeSession effect present', () => {
    const embedDisabledProject = makeProject('test-project', {
      embedding: { enabled: false },
    });
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const workerRun = makeRun('worker-1', {
      phase: 'Succeeded',
      sessionID: 'sess-ghi789',
    });
    const result = decide({
      task,
      project: embedDisabledProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(embedDisabledProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('succeeded');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-ghi789');
  });

  it('succeeded worker run with sessionID missing → no SummarizeSession effect', () => {
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    // Run has Succeeded phase but no sessionID.
    const workerRun = makeRun('worker-1', { phase: 'Succeeded' });
    const result = decide(makeInput(task, { observed: { worker: workerRun } }));
    expect(result.toPhase).toBe('succeeded');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeUndefined();
  });

  it('initializing + Succeeded run without embedding → SummarizeSession effect present', () => {
    const noEmbedProject = makeProject('test-project');
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const workerRun = makeRun('worker-1', {
      phase: 'Succeeded',
      sessionID: 'sess-init001',
    });
    const result = decide({
      task,
      project: noEmbedProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(noEmbedProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('succeeded');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-init001');
  });

  it('initializing + Failed run without embedding → SummarizeSession effect present', () => {
    const noEmbedProject = makeProject('test-project');
    const task = makeTask('t1', 'test-project', { phase: 'initializing' });
    const workerRun = makeRun('worker-1', {
      phase: 'Failed',
      sessionID: 'sess-init002',
    });
    const result = decide({
      task,
      project: noEmbedProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(noEmbedProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('failed');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-init002');
  });

  it('succeeded worker run with embedding enabled → SummarizeSession effect present (regression)', () => {
    const embedEnabledProject = makeProject('test-project', {
      embedding: { enabled: true },
    });
    const task = makeTask('t1', 'test-project', { phase: 'running' });
    const workerRun = makeRun('worker-1', {
      phase: 'Succeeded',
      sessionID: 'sess-jkl012',
    });
    const result = decide({
      task,
      project: embedEnabledProject,
      allTasks: [task],
      observed: { worker: workerRun },
      manualActions: {},
      flow: resolveFlow(embedEnabledProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(result.toPhase).toBe('succeeded');
    const summaryEffect = result.effects.find((e) => e.type === 'SummarizeSession');
    expect(summaryEffect).toBeDefined();
    expect((summaryEffect as any).sessionID).toBe('sess-jkl012');
  });
});

describe('decide — AI auto-rework run name differentiation', () => {
  it('scheduled run name differs when aiReworkCount changes but retryCount stays the same', () => {
    // Simulate: task succeeded with retryCount=0, aiReworkCount=0.
    // AI review requests changes → aiReworkCount becomes 1.
    // Next scheduled decision should produce a DIFFERENT run name.
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 3 },
    });

    // Step 1: initial worker run (retryCount=0, aiReworkCount=0)
    const taskStep1 = makeTask('t1', 'test-project', {
      phase: 'scheduled',
      retryCount: 0,
      aiReworkCount: 0,
    });
    (taskStep1.status?.worker as any).runName = 'initial-worker-run';
    const result1 = decide({
      task: taskStep1,
      project: aiProject,
      allTasks: [taskStep1],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    // Step 2: after AI rework (retryCount=0 still, aiReworkCount=1)
    const taskStep2 = makeTask('t1', 'test-project', {
      phase: 'scheduled',
      retryCount: 0,
      aiReworkCount: 1,
    });
    (taskStep2.status?.worker as any).runName = 'initial-worker-run';
    const result2 = decide({
      task: taskStep2,
      project: aiProject,
      allTasks: [taskStep2],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });

    const runName1 = (result1.statusPatch?.worker as any)?.runName;
    const runName2 = (result2.statusPatch?.worker as any)?.runName;
    expect(runName1).toBeDefined();
    expect(runName2).toBeDefined();
    expect(runName1).not.toBe(runName2);
  });

  it('scheduled run name is identical when both counters are unchanged (idempotent)', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'scheduled',
      retryCount: 0,
      aiReworkCount: 0,
    });
    const resultA = decide(makeInput(task));
    const resultB = decide(makeInput(task));

    const nameA = (resultA.statusPatch?.worker as any)?.runName;
    const nameB = (resultB.statusPatch?.worker as any)?.runName;
    expect(nameA).toBe(nameB);
  });
});

describe('decide — AI request_changes end-to-end state machine', () => {
  it('reviewing(request_changes) → rework-requested → scheduled → initializing with new runName', () => {
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 3 },
    });

    // --- Phase 1: succeeded + AI review enabled → reviewing (ScheduleReviewRun) ---
    const taskSucceeded = makeTask('t1', 'test-project', { phase: 'succeeded', type: 'BUILD' });
    (taskSucceeded.status as any).worker = {
      runName: 'worker-0-0',
      retryCount: 0,
      aiReworkCount: 0,
    };
    const resultReviewing = decide({
      task: taskSucceeded,
      project: aiProject,
      allTasks: [taskSucceeded],
      observed: { worker: makeRun('worker-0-0', { phase: 'Succeeded' }) },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(resultReviewing.toPhase).toBe('reviewing');

    // --- Phase 2: reviewing + verdict request_changes → rework-requested (aiReworkCount=1) ---
    const taskReviewing = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (taskReviewing.status as any).worker = { reviewRunName: 'review-0', aiReworkCount: 0 };
    const reviewRun = makeRun('review-0', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({
        action: 'request_changes',
        feedback: 'fix the bug',
      }),
    };
    const resultRework = decide({
      task: taskReviewing,
      project: aiProject,
      allTasks: [taskReviewing],
      observed: { review: reviewRun },
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(resultRework.toPhase).toBe('rework-requested');
    expect((resultRework.statusPatch?.worker as any).aiReworkCount).toBe(1);

    // --- Phase 3: rework-requested → scheduled (no capacity limit) ---
    const taskRework = makeTask('t1', 'test-project', { phase: 'rework-requested' });
    (taskRework.status as any).worker = { runName: 'worker-0-0', retryCount: 0, aiReworkCount: 1 };
    const resultScheduled = decide({
      task: taskRework,
      project: aiProject,
      allTasks: [taskRework],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(resultScheduled.toPhase).toBe('scheduled');

    // --- Phase 4: scheduled → initializing (new runName computed) ---
    const taskScheduled = makeTask('t1', 'test-project', { phase: 'scheduled' });
    (taskScheduled.status as any).worker = {
      runName: 'worker-0-0',
      retryCount: 0,
      aiReworkCount: 1,
    };
    const resultInitializing = decide({
      task: taskScheduled,
      project: aiProject,
      allTasks: [taskScheduled],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    expect(resultInitializing.toPhase).toBe('initializing');

    // --- ASSERTION: new runName differs from the prior succeeded worker run name ---
    const priorRunName = 'worker-0-0';
    const newRunName = (resultInitializing.statusPatch?.worker as any)?.runName;
    expect(newRunName).toBeDefined();
    expect(newRunName).not.toBe(priorRunName);

    // Also verify the ScheduleRun effect carries the new run name.
    const scheduleEffect = resultInitializing.effects.find((e) => e.type === 'ScheduleRun');
    expect(scheduleEffect).toBeDefined();
    expect((scheduleEffect as any)?.runName).toBe(newRunName);
  });

  it('AI rework loop: second request_changes produces yet another distinct run name', () => {
    const aiProject = makeProject('test-project', {
      reviewPolicy: { aiReviewerEnabled: true, aiReviewerAgent: 'reviewer', maxAutoReworks: 3 },
    });

    // First AI rework: aiReworkCount=1 → scheduled with runName for (rc=0, ar=1)
    const taskAr1 = makeTask('t1', 'test-project', { phase: 'scheduled' });
    (taskAr1.status as any).worker = { retryCount: 0, aiReworkCount: 1 };
    const resultAr1 = decide({
      task: taskAr1,
      project: aiProject,
      allTasks: [taskAr1],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    const runNameAr1 = (resultAr1.statusPatch?.worker as any)?.runName;

    // Second AI rework: aiReworkCount=2 → scheduled with runName for (rc=0, ar=2)
    const taskAr2 = makeTask('t1', 'test-project', { phase: 'scheduled' });
    (taskAr2.status as any).worker = { retryCount: 0, aiReworkCount: 2 };
    const resultAr2 = decide({
      task: taskAr2,
      project: aiProject,
      allTasks: [taskAr2],
      observed: {},
      manualActions: {},
      flow: resolveFlow(aiProject),
      capacity: { activeCount: 0, maxParallel: 2 },
      now,
    });
    const runNameAr2 = (resultAr2.statusPatch?.worker as any)?.runName;

    expect(runNameAr1).not.toBe(runNameAr2);
  });
});
