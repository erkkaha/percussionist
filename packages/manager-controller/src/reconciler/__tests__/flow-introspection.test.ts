import { describe, expect, it } from 'bun:test';
import { resolveFlow } from '../flow.js';
import { inspectTaskFlow } from '../flow-introspection.js';
import { TRANSITION_TABLE } from '../transitions.js';
import { makeProject, makeRun, makeTask } from './fixtures.js';

const project = makeProject('test-project');
const flow = resolveFlow(project);

describe('inspectTaskFlow — core envelope', () => {
  it('returns project, task, type, phase, valid transitions, and resolved flow', () => {
    const task = makeTask('t1', 'test-project', { phase: 'pending' });
    const result = inspectTaskFlow(task, project, [task]);

    expect(result.project).toBe('test-project');
    expect(result.task).toBe('t1');
    expect(result.taskType).toBe('BUILD');
    expect(result.currentPhase).toBe('pending');
    expect(result.validTargetPhases).toEqual(TRANSITION_TABLE.pending);
    expect(result.resolvedFlow.preset).toBe(flow.preset);
  });

  it('defaults phase to pending when status is missing', () => {
    const task = makeTask('t1', 'test-project', { noStatus: true });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.currentPhase).toBe('pending');
    expect(result.validTargetPhases).toEqual(TRANSITION_TABLE.pending);
  });

  it('exposes worker status context', () => {
    const task = makeTask('t1', 'test-project', {
      phase: 'awaiting-merge',
      runName: 'worker-1',
    });
    (task.status as any).worker = {
      ...(task.status as any).worker,
      mergeRunName: 'merge-1',
      mergeError: 'conflict',
      reviewApproved: true,
      reviewFeedback: 'LGTM',
      mergedAt: '2026-05-29T00:00:00.000Z',
    };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.statusSummary.worker.runName).toBe('worker-1');
    expect(result.statusSummary.worker.mergeRunName).toBe('merge-1');
    expect(result.statusSummary.worker.mergeError).toBe('conflict');
    expect(result.statusSummary.worker.reviewApproved).toBe(true);
    expect(result.statusSummary.worker.mergedAt).toBe('2026-05-29T00:00:00.000Z');
  });

  it('detects manual action annotations', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    (task.metadata as any).annotations = {
      'percussionist.dev/action-approved': 'true',
      'percussionist.dev/action-rework-feedback': 'fix typo',
    };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.statusSummary.manualActionFlagsPresent).toContain('approved');
    expect(result.statusSummary.manualActionFlagsPresent).toContain('reworkFeedback');
  });
});

describe('inspectTaskFlow — awaiting-human', () => {
  it('BUILD + merge flow → awaiting-merge', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'BUILD' });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('awaiting-merge');
    expect(result.expectedNext.reason).toContain('build.onApprove=merge');
  });

  it('BUILD + simple flow → done', () => {
    const simpleProject = makeProject('test-project');
    simpleProject.spec.flow = { preset: 'simple' };
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'BUILD' });
    const result = inspectTaskFlow(task, simpleProject, [task]);
    expect(result.expectedNext.primary).toContain('done');
    expect(result.expectedNext.reason).toContain('build.onApprove=done');
  });

  it('PLAN + generate-builds flow → generating-builds', () => {
    const task = makeTask('plan-1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('generating-builds');
    expect(result.expectedNext.reason).toContain('plan.onApprove=generate-builds');
  });

  it('PLAN + simple flow → done', () => {
    const simpleProject = makeProject('test-project');
    simpleProject.spec.flow = { preset: 'simple' };
    const task = makeTask('plan-1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    const result = inspectTaskFlow(task, simpleProject, [task]);
    expect(result.expectedNext.primary).toContain('done');
    expect(result.expectedNext.reason).toContain('plan.onApprove=done');
  });

  it('PLAN + mergeError + approved → awaiting-feature-merge retry', () => {
    const task = makeTask('plan-1', 'test-project', { phase: 'awaiting-human', type: 'PLAN' });
    (task.metadata as any).annotations = { 'percussionist.dev/action-approved': 'true' };
    (task.status as any).worker = { mergeRunName: 'merge-1', mergeError: 'conflict' };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('feature-branch merge');
    expect(result.expectedNext.reason).toContain('mergeError');
  });

  it('approved annotation changes expected next', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human', type: 'BUILD' });
    (task.metadata as any).annotations = { 'percussionist.dev/action-approved': 'true' };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('awaiting-merge');
    expect(result.expectedNext.reason).toContain('approval annotation is set');
  });

  it('request-changes annotation → rework-requested', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    (task.metadata as any).annotations = { 'percussionist.dev/action-request-changes': 'true' };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('rework-requested');
  });

  it('abandon annotation → done', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-human' });
    (task.metadata as any).annotations = { 'percussionist.dev/action-abandon': 'true' };
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('done');
    expect(result.expectedNext.reason).toContain('abandon');
  });
});

describe('inspectTaskFlow — reviewing', () => {
  it('no reviewRunName → fallback to human review', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing', type: 'BUILD' });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('fall back to human review');
  });

  it('review run Succeeded + approve verdict → awaiting-human', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing', type: 'BUILD' });
    (task.status as any).worker = { reviewRunName: 'review-1' };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({ action: 'approve' }),
    };
    const result = inspectTaskFlow(task, project, [task], { review: reviewRun });
    expect(result.expectedNext.primary).toContain('awaiting-human');
    expect(result.expectedNext.reason).toContain('approve');
  });

  it('review run Succeeded + request_changes under ceiling → rework-requested', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing', type: 'BUILD' });
    (task.status as any).worker = { reviewRunName: 'review-1', aiReworkCount: 0 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({ action: 'request_changes' }),
    };
    const result = inspectTaskFlow(task, project, [task], { review: reviewRun });
    expect(result.expectedNext.primary).toContain('rework-requested');
  });

  it('review run Succeeded + request_changes over ceiling → awaiting-human escalate', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing', type: 'BUILD' });
    (task.status as any).worker = { reviewRunName: 'review-1', aiReworkCount: 2 };
    const reviewRun = makeRun('review-1', { phase: 'Succeeded' });
    (reviewRun.metadata as any).annotations = {
      'percussionist.dev/review-verdict': JSON.stringify({ action: 'request_changes' }),
    };
    const result = inspectTaskFlow(task, project, [task], { review: reviewRun });
    expect(result.expectedNext.primary).toContain('escalate');
    expect(result.expectedNext.primary).toContain('awaiting-human');
  });

  it('review run Running → wait', () => {
    const task = makeTask('t1', 'test-project', { phase: 'reviewing' });
    (task.status as any).worker = { reviewRunName: 'review-1' };
    const result = inspectTaskFlow(task, project, [task], {
      review: makeRun('review-1', { phase: 'Running' }),
    });
    expect(result.expectedNext.primary).toContain('in progress');
  });
});

describe('inspectTaskFlow — awaiting-merge', () => {
  it('merge Succeeded → done', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = inspectTaskFlow(task, project, [task], {
      merge: makeRun('merge-1', { phase: 'Succeeded' }),
    });
    expect(result.expectedNext.primary).toContain('done');
  });

  it('merge Failed → failed', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = inspectTaskFlow(task, project, [task], {
      merge: makeRun('merge-1', { phase: 'Failed', message: 'conflict' }),
    });
    expect(result.expectedNext.primary).toContain('failed');
    expect(result.expectedNext.blockingConditions[0]).toContain('conflict');
  });

  it('no mergeRunName → schedule merge run', () => {
    const task = makeTask('t1', 'test-project', { phase: 'awaiting-merge' });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('Merge run will be scheduled');
  });
});

describe('inspectTaskFlow — awaiting-feature-merge', () => {
  it('merge Succeeded → done', () => {
    const task = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = inspectTaskFlow(task, project, [task], {
      merge: makeRun('merge-1', { phase: 'Succeeded' }),
    });
    expect(result.expectedNext.primary).toContain('done');
  });

  it('merge Failed → awaiting-human with mergeError', () => {
    const task = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-feature-merge',
      type: 'PLAN',
    });
    (task.status as any).worker = { mergeRunName: 'merge-1' };
    const result = inspectTaskFlow(task, project, [task], {
      merge: makeRun('merge-1', { phase: 'Failed', message: 'merge conflict' }),
    });
    expect(result.expectedNext.primary).toContain('awaiting-human');
    expect(result.expectedNext.blockingConditions[0]).toContain('merge conflict');
  });
});

describe('inspectTaskFlow — awaiting-children', () => {
  const featProject = makeProject('test-project', { featureBranchingEnabled: true });

  it('all BUILD children done + auto-merge → awaiting-feature-merge', () => {
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
    const result = inspectTaskFlow(planTask, featProject, [planTask, buildA]);
    expect(result.expectedNext.primary).toContain('awaiting-feature-merge');
  });

  it('BUILD children not all done → wait', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-children',
      type: 'PLAN',
    });
    const buildA = makeTask('build-a', 'test-project', {
      type: 'BUILD',
      phase: 'running',
      parentTaskRef: 'plan-1',
    });
    const result = inspectTaskFlow(planTask, featProject, [planTask, buildA]);
    expect(result.expectedNext.primary).toContain('Waiting');
    expect(result.expectedNext.blockingConditions.length).toBeGreaterThan(0);
  });

  it('no child BUILD tasks → escalate to awaiting-human', () => {
    const planTask = makeTask('plan-1', 'test-project', {
      phase: 'awaiting-children',
      type: 'PLAN',
    });
    const result = inspectTaskFlow(planTask, featProject, [planTask]);
    expect(result.expectedNext.primary).toContain('awaiting-human');
  });

  it('all children done + integration manual → awaiting-human', () => {
    const manualProject = makeProject('test-project', { featureBranchingEnabled: true });
    manualProject.spec.flow = {
      preset: 'plan-build-review-merge',
      integration: { mode: 'manual' },
    };
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
    const result = inspectTaskFlow(planTask, manualProject, [planTask, buildA]);
    expect(result.expectedNext.primary).toContain('manual');
    expect(result.expectedNext.primary).toContain('awaiting-human');
  });

  it('all children done + feature branching disabled → done', () => {
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
    const result = inspectTaskFlow(planTask, project, [planTask, buildA]);
    expect(result.expectedNext.primary).toContain('done');
  });
});

describe('inspectTaskFlow — failed', () => {
  it('retry disabled → human action required', () => {
    const task = makeTask('t1', 'test-project', { phase: 'failed' });
    const result = inspectTaskFlow(task, project, [task]);
    expect(result.expectedNext.primary).toContain('human action');
    expect(result.expectedNext.reason).toContain('flow.retry.enabled=false');
  });

  it('retry enabled + attempts left → retry after backoff', () => {
    const retryProject = makeProject('test-project', {
      retryPolicy: { enabled: true, maxAttempts: 3, backoffSeconds: 30 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 0 });
    (task.status as any).lastFailureDuration = 60;
    const result = inspectTaskFlow(task, retryProject, [task]);
    expect(result.expectedNext.primary).toContain('retried');
  });

  it('retry enabled + exhausted → human action required', () => {
    const retryProject = makeProject('test-project', {
      retryPolicy: { enabled: true, maxAttempts: 2, backoffSeconds: 30 },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 1 });
    (task.status as any).lastFailureDuration = 60;
    const result = inspectTaskFlow(task, retryProject, [task]);
    expect(result.expectedNext.primary).toContain('Maximum retry');
  });

  it('poison pill (fast failure) → no automatic retry', () => {
    const retryProject = makeProject('test-project', {
      retryPolicy: {
        enabled: true,
        maxAttempts: 3,
        backoffSeconds: 30,
        poisonPillThresholdSeconds: 30,
      },
    });
    const task = makeTask('t1', 'test-project', { phase: 'failed', retryCount: 0 });
    (task.status as any).lastFailureDuration = 5;
    const result = inspectTaskFlow(task, retryProject, [task]);
    expect(result.expectedNext.primary).toContain('poison-pill');
  });
});
