// Flow introspection — read-only, side-effect-free helper for explaining a
// task's current lifecycle state, allowed transitions, resolved flow, and the
// most likely next action given the project's configuration.

import type { Project, Run, Task, TaskPhase } from '@percussionist/api';
import { type ResolvedFlow, resolveFlow } from './flow.js';
import { TRANSITION_TABLE } from './transitions.js';

export interface ObservedRuns {
  worker?: Run;
  review?: Run;
  merge?: Run;
  buildgen?: Run;
}

export interface ManualActionFlags {
  approved?: boolean;
  requestChanges?: boolean;
  reworkFeedback?: string;
  abandon?: boolean;
  answer?: string;
}

export interface ExpectedNext {
  primary: string;
  reason: string;
  blockingConditions: string[];
  suggestedActions: string[];
}

export interface TaskFlowInspection {
  project: string;
  task: string;
  taskType: 'PLAN' | 'BUILD';
  currentPhase: TaskPhase;
  validTargetPhases: TaskPhase[];
  resolvedFlow: ResolvedFlow;
  statusSummary: {
    worker: {
      runName?: string;
      reviewRunName?: string;
      mergeRunName?: string;
      buildTasksFacilitatorRun?: string;
      reviewApproved?: boolean;
      reviewFeedback?: string;
      mergeError?: string;
      mergedAt?: string;
      retryCount?: number;
      aiReworkCount?: number;
    };
    manualActionFlagsPresent: string[];
    blocked?: boolean;
    blockedReason?: string;
    retryAfter?: string;
  };
  expectedNext: ExpectedNext;
}

const ACTION_ANNOTATION_KEYS: Record<keyof ManualActionFlags, string> = {
  approved: 'percussionist.dev/action-approved',
  requestChanges: 'percussionist.dev/action-request-changes',
  reworkFeedback: 'percussionist.dev/action-rework-feedback',
  abandon: 'percussionist.dev/action-abandon',
  answer: 'percussionist.dev/action-answer',
};

function extractManualActions(task: Task): ManualActionFlags {
  const annotations = task.metadata.annotations ?? {};
  return {
    approved: annotations[ACTION_ANNOTATION_KEYS.approved] === 'true' || undefined,
    requestChanges: annotations[ACTION_ANNOTATION_KEYS.requestChanges] === 'true' || undefined,
    reworkFeedback: annotations[ACTION_ANNOTATION_KEYS.reworkFeedback] || undefined,
    abandon: annotations[ACTION_ANNOTATION_KEYS.abandon] === 'true' || undefined,
    answer: annotations[ACTION_ANNOTATION_KEYS.answer] || undefined,
  };
}

function presentManualActionFlags(actions: ManualActionFlags): string[] {
  const present: string[] = [];
  if (actions.approved) present.push('approved');
  if (actions.requestChanges) present.push('requestChanges');
  if (actions.reworkFeedback) present.push('reworkFeedback');
  if (actions.abandon) present.push('abandon');
  if (actions.answer) present.push('answer');
  return present;
}

function childBuildTasks(task: Task, allTasks: Task[]): Task[] {
  const taskName = task.metadata.name;
  return allTasks.filter((t) => t.spec.type === 'BUILD' && t.spec.parentTaskRef === taskName);
}

function explainAwaitingHuman(
  task: Task,
  flow: ResolvedFlow,
  actions: ManualActionFlags,
): ExpectedNext {
  const taskType = task.spec.type;
  const worker = task.status?.worker;

  if (actions.abandon) {
    return {
      primary: 'Task will be marked done (abandon)',
      reason: 'action-abandon annotation is set',
      blockingConditions: [],
      suggestedActions: ['Remove action-abandon annotation to cancel'],
    };
  }

  if (actions.requestChanges) {
    return {
      primary: 'Task will move to rework-requested',
      reason: 'action-request-changes annotation is set',
      blockingConditions: [],
      suggestedActions: [
        'Provide action-rework-feedback annotation for clarity',
        'Remove action-request-changes to cancel',
      ],
    };
  }

  if (actions.approved) {
    if (taskType === 'PLAN') {
      if (worker?.mergeError) {
        return {
          primary: 'Retry failed feature-branch merge',
          reason: 'PLAN task has mergeError and approval annotation is set',
          blockingConditions: [],
          suggestedActions: ['Ensure merge conflict is resolved before retry'],
        };
      }
      if (flow.plan.onApprove === 'done') {
        return {
          primary: 'Plan will be marked done',
          reason: 'PLAN task + approval annotation is set + plan.onApprove=done',
          blockingConditions: [],
          suggestedActions: ['Remove action-approved to cancel'],
        };
      }
      return {
        primary: 'Plan will move to generating-builds',
        reason: 'PLAN task + approval annotation is set + plan.onApprove=generate-builds',
        blockingConditions: [],
        suggestedActions: ['Remove action-approved to cancel'],
      };
    }

    // BUILD
    if (flow.build.onApprove === 'done' || flow.merge.mode === 'disabled') {
      return {
        primary: 'Build will be marked done',
        reason: 'BUILD task + approval annotation is set + build.onApprove=done',
        blockingConditions: [],
        suggestedActions: ['Remove action-approved to cancel'],
      };
    }
    return {
      primary: 'Build will move to awaiting-merge',
      reason: 'BUILD task + approval annotation is set + build.onApprove=merge',
      blockingConditions: [],
      suggestedActions: ['Remove action-approved to cancel'],
    };
  }

  // No manual action set yet.
  if (taskType === 'PLAN') {
    const next = worker?.mergeError
      ? 'awaiting-feature-merge (retry merge)'
      : flow.plan.onApprove === 'done'
        ? 'done'
        : 'generating-builds';
    return {
      primary: `Awaiting human approval; on approve transitions to ${next}`,
      reason:
        `PLAN task + plan.onApprove=${flow.plan.onApprove}` +
        (worker?.mergeError ? ' + mergeError present' : ''),
      blockingConditions: [],
      suggestedActions: [
        'Set action-approved annotation to approve',
        'Set action-request-changes + action-rework-feedback to request changes',
        'Set action-abandon to skip the plan',
      ],
    };
  }

  const next =
    flow.build.onApprove === 'done' || flow.merge.mode === 'disabled' ? 'done' : 'awaiting-merge';
  return {
    primary: `Awaiting human approval; on approve transitions to ${next}`,
    reason: `BUILD task + build.onApprove=${flow.build.onApprove} + merge.mode=${flow.merge.mode}`,
    blockingConditions: [],
    suggestedActions: [
      'Set action-approved annotation to approve',
      'Set action-request-changes + action-rework-feedback to request changes',
      'Set action-abandon to skip the build',
    ],
  };
}

function explainReviewing(task: Task, flow: ResolvedFlow, observed: ObservedRuns): ExpectedNext {
  const reviewRunName = task.status?.worker?.reviewRunName;
  if (!reviewRunName) {
    return {
      primary: 'Review run not yet assigned; will fall back to human review',
      reason: 'reviewing phase without worker.reviewRunName',
      blockingConditions: ['reviewRunName missing'],
      suggestedActions: [
        'Wait for reconciler to create review run or manually set_task_state to awaiting-human',
      ],
    };
  }

  const reviewRun = observed.review;
  if (!reviewRun) {
    return {
      primary: 'Review run is being created',
      reason: 'reviewRunName set but run object not yet observed',
      blockingConditions: ['Review run not yet visible'],
      suggestedActions: ['Wait for next reconcile cycle'],
    };
  }

  const phase = reviewRun.status?.phase;
  if (phase === 'Failed') {
    return {
      primary: 'Review run failed; task will fall back to awaiting-human',
      reason: 'review run phase is Failed',
      blockingConditions: [],
      suggestedActions: ['Inspect review run logs with read_logs'],
    };
  }

  if (phase === 'Running') {
    return {
      primary: 'Review run in progress',
      reason: 'review run phase is Running',
      blockingConditions: ['Review run not complete'],
      suggestedActions: ['Wait for review run to finish or check logs'],
    };
  }

  if (phase !== 'Succeeded') {
    return {
      primary: 'Review run not yet succeeded',
      reason: `review run phase is ${phase ?? 'unknown'}`,
      blockingConditions: ['Review run not complete'],
      suggestedActions: ['Wait for review run to finish'],
    };
  }

  const verdictRaw = reviewRun.metadata.annotations?.['percussionist.dev/review-verdict'];
  let verdict: { action?: string } | undefined;
  try {
    verdict = verdictRaw ? (JSON.parse(verdictRaw) as { action?: string }) : undefined;
  } catch {
    verdict = undefined;
  }

  if (!verdict) {
    return {
      primary: 'Review succeeded without verdict; task will fall back to awaiting-human',
      reason: 'review run Succeeded but no percussionist.dev/review-verdict annotation',
      blockingConditions: [],
      suggestedActions: ['Manually review and set_task_state to awaiting-human or done'],
    };
  }

  if (verdict.action === 'approve') {
    return {
      primary: 'Review approved; task will move to awaiting-human for final approval',
      reason: 'review verdict action=approve',
      blockingConditions: [],
      suggestedActions: ['Wait for human approval or set action-approved'],
    };
  }

  if (verdict.action === 'request_changes') {
    const aiCount = (task.status?.worker?.aiReworkCount ?? 0) + 1;
    const ceiling = flow.review.maxAutoReworks;
    if (aiCount > ceiling) {
      return {
        primary: 'AI rework ceiling reached; task will escalate to awaiting-human',
        reason: `aiReworkCount would become ${aiCount} > maxAutoReworks=${ceiling}`,
        blockingConditions: [],
        suggestedActions: ['Human must decide whether to rework, approve, or abandon'],
      };
    }
    return {
      primary: 'Changes requested; task will move to rework-requested',
      reason: `review verdict action=request_changes and under maxAutoReworks=${ceiling}`,
      blockingConditions: [],
      suggestedActions: ['Wait for automatic retry or set_task_state to rework-requested'],
    };
  }

  return {
    primary: 'Unknown review verdict; task will fall back to awaiting-human',
    reason: `review verdict action=${verdict.action}`,
    blockingConditions: ['Unrecognized verdict action'],
    suggestedActions: ['Inspect review verdict annotation and review run logs'],
  };
}

function explainAwaitingMerge(
  task: Task,
  flow: ResolvedFlow,
  observed: ObservedRuns,
): ExpectedNext {
  const mergeRunName = task.status?.worker?.mergeRunName;
  if (!mergeRunName) {
    return {
      primary: 'Merge run will be scheduled',
      reason: 'awaiting-merge phase without mergeRunName',
      blockingConditions: [],
      suggestedActions: ['Wait for reconciler to schedule merge run'],
    };
  }

  const mergeRun = observed.merge;
  if (!mergeRun) {
    return {
      primary: 'Merge run is being created',
      reason: 'mergeRunName set but run object not yet observed',
      blockingConditions: ['Merge run not yet visible'],
      suggestedActions: ['Wait for next reconcile cycle'],
    };
  }

  const phase = mergeRun.status?.phase;
  if (phase === 'Succeeded') {
    return {
      primary: 'Merge succeeded; task will move to done',
      reason: 'merge run phase is Succeeded',
      blockingConditions: [],
      suggestedActions: ['Verify branch merged and worktree cleaned'],
    };
  }

  if (phase === 'Failed') {
    return {
      primary: 'Merge failed; task will move to failed',
      reason: `merge run phase is Failed: ${mergeRun.status?.message ?? 'no message'}`,
      blockingConditions: [mergeRun.status?.message ?? 'merge failed'],
      suggestedActions: [
        'Inspect merge run logs with read_logs',
        'After fixing cause, set action-approved to retry merge',
      ],
    };
  }

  if (phase === 'Running') {
    const stale = mergeRun.status?.lastEventAt
      ? Math.round((Date.now() - new Date(mergeRun.status.lastEventAt).getTime()) / 1000)
      : 0;
    const blocking: string[] = [];
    if (stale > flow.timeouts.mergeStaleSeconds) {
      blocking.push(
        `Merge run stale for ${stale}s (threshold ${flow.timeouts.mergeStaleSeconds}s)`,
      );
    }
    return {
      primary: 'Merge run in progress',
      reason: 'merge run phase is Running',
      blockingConditions: blocking,
      suggestedActions: ['Wait for merge run to finish or check logs'],
    };
  }

  return {
    primary: 'Awaiting merge run outcome',
    reason: `merge run phase is ${phase ?? 'unknown'}`,
    blockingConditions: ['Merge run not complete'],
    suggestedActions: ['Wait for next reconcile cycle'],
  };
}

function explainAwaitingFeatureMerge(
  task: Task,
  flow: ResolvedFlow,
  observed: ObservedRuns,
): ExpectedNext {
  const mergeRunName = task.status?.worker?.mergeRunName;
  if (!mergeRunName) {
    return {
      primary: 'Feature-branch merge run will be scheduled',
      reason: 'awaiting-feature-merge phase without mergeRunName',
      blockingConditions: [],
      suggestedActions: ['Wait for reconciler to schedule merge run'],
    };
  }

  const mergeRun = observed.merge;
  if (!mergeRun) {
    return {
      primary: 'Feature-branch merge run is being created',
      reason: 'mergeRunName set but run object not yet observed',
      blockingConditions: ['Merge run not yet visible'],
      suggestedActions: ['Wait for next reconcile cycle'],
    };
  }

  const phase = mergeRun.status?.phase;
  if (phase === 'Succeeded') {
    return {
      primary: 'Feature branch merged; task will move to done',
      reason: 'merge run phase is Succeeded',
      blockingConditions: [],
      suggestedActions: ['Verify feature branch merged to target'],
    };
  }

  if (phase === 'Failed') {
    return {
      primary: 'Feature-branch merge failed; task will return to awaiting-human',
      reason: `merge run phase is Failed: ${mergeRun.status?.message ?? 'no message'}`,
      blockingConditions: [mergeRun.status?.message ?? 'merge failed'],
      suggestedActions: [
        'Inspect merge run logs with read_logs',
        'After fixing cause, set action-approved to retry',
      ],
    };
  }

  if (phase === 'Running') {
    const stale = mergeRun.status?.lastEventAt
      ? Math.round((Date.now() - new Date(mergeRun.status.lastEventAt).getTime()) / 1000)
      : 0;
    const blocking: string[] = [];
    if (stale > flow.timeouts.mergeStaleSeconds) {
      blocking.push(
        `Merge run stale for ${stale}s (threshold ${flow.timeouts.mergeStaleSeconds}s)`,
      );
    }
    return {
      primary: 'Feature-branch merge run in progress',
      reason: 'merge run phase is Running',
      blockingConditions: blocking,
      suggestedActions: ['Wait for merge run to finish or check logs'],
    };
  }

  return {
    primary: 'Awaiting feature-branch merge outcome',
    reason: `merge run phase is ${phase ?? 'unknown'}`,
    blockingConditions: ['Merge run not complete'],
    suggestedActions: ['Wait for next reconcile cycle'],
  };
}

function explainAwaitingChildren(
  task: Task,
  project: Project,
  allTasks: Task[],
  flow: ResolvedFlow,
): ExpectedNext {
  const children = childBuildTasks(task, allTasks);
  if (children.length === 0) {
    return {
      primary: 'No child BUILD tasks found; task will escalate to awaiting-human',
      reason: 'awaiting-children phase with zero child BUILD tasks',
      blockingConditions: ['Child BUILD tasks missing'],
      suggestedActions: ['Verify buildgen run created BUILD tasks or create them manually'],
    };
  }

  const incomplete = children.filter(
    (t) => !(t.status?.phase === 'done' && t.status?.worker?.mergedAt),
  );
  if (incomplete.length > 0) {
    return {
      primary: `Waiting for ${incomplete.length} child BUILD task(s) to complete and merge`,
      reason: 'not all child BUILD tasks are done with mergedAt',
      blockingConditions: incomplete.map(
        (t) => `Child ${t.metadata.name} is ${t.status?.phase ?? 'unknown'}`,
      ),
      suggestedActions: ['Wait for children to finish or inspect child task flows'],
    };
  }

  if (!project.spec.featureBranchingEnabled || flow.integration.mode === 'disabled') {
    return {
      primary: 'All children complete; task will move to done',
      reason: 'featureBranching disabled or integration.mode=disabled',
      blockingConditions: [],
      suggestedActions: ['No action needed'],
    };
  }

  if (flow.integration.mode === 'manual') {
    return {
      primary:
        'All children complete; task will move to awaiting-human for manual feature-branch merge',
      reason: 'integration.mode=manual',
      blockingConditions: ['Awaiting human merge'],
      suggestedActions: [
        'Merge feature branch to target manually or set integration.mode=auto-merge',
      ],
    };
  }

  return {
    primary:
      'All children complete; task will move to awaiting-feature-merge and schedule merge run',
    reason: 'integration.mode=auto-merge',
    blockingConditions: [],
    suggestedActions: ['Wait for merge run to schedule'],
  };
}

function explainFailed(task: Task, flow: ResolvedFlow): ExpectedNext {
  const retryCount = task.status?.worker?.retryCount ?? 0;
  const duration = task.status?.lastFailureDuration ?? 0;

  if (!flow.retry.enabled) {
    return {
      primary: 'Task failed and retries are disabled; awaiting human action',
      reason: 'flow.retry.enabled=false',
      blockingConditions: ['Retries disabled'],
      suggestedActions: [
        'Set action-approved to escalate to awaiting-human or retry merge',
        'Use force_retry to restart the task',
      ],
    };
  }

  if (duration < flow.retry.poisonPillThresholdSeconds) {
    return {
      primary: 'Task failed quickly; likely poison-pill — no automatic retry',
      reason: `lastFailureDuration=${duration}s < poisonPillThresholdSeconds=${flow.retry.poisonPillThresholdSeconds}s`,
      blockingConditions: ['Failure too fast (possible poison pill)'],
      suggestedActions: ['Inspect logs, then force_retry or set_task_state to awaiting-human'],
    };
  }

  if (retryCount >= flow.retry.maxAttempts - 1) {
    return {
      primary: 'Maximum retry attempts reached; awaiting human action',
      reason: `retryCount=${retryCount} >= maxAttempts-1=${flow.retry.maxAttempts - 1}`,
      blockingConditions: ['Retry attempts exhausted'],
      suggestedActions: ['Inspect logs and force_retry or set_task_state to awaiting-human'],
    };
  }

  return {
    primary: 'Task will be retried after backoff',
    reason: `retryCount=${retryCount} < maxAttempts=${flow.retry.maxAttempts} and failure duration exceeds poison-pill threshold`,
    blockingConditions: [
      `retryAfter may be set (backoff ${Math.min(
        flow.retry.backoffSeconds * flow.retry.backoffMultiplier ** retryCount,
        flow.retry.maxBackoffSeconds,
      )}s)`,
    ],
    suggestedActions: ['Wait for automatic retry or force_retry to skip backoff'],
  };
}

function explainDefault(phase: TaskPhase, taskType: 'PLAN' | 'BUILD'): ExpectedNext {
  return {
    primary: `Task is in ${phase}; monitor state for transition opportunities`,
    reason: `No high-risk interpretation for ${taskType} ${phase}`,
    blockingConditions: [],
    suggestedActions: ['Inspect runs/logs and use set_task_state for valid transitions'],
  };
}

function buildExpectedNext(
  task: Task,
  project: Project,
  allTasks: Task[],
  flow: ResolvedFlow,
  observed: ObservedRuns,
): ExpectedNext {
  const phase = task.status?.phase ?? 'pending';
  const actions = extractManualActions(task);

  switch (phase) {
    case 'awaiting-human':
      return explainAwaitingHuman(task, flow, actions);
    case 'reviewing':
      return explainReviewing(task, flow, observed);
    case 'awaiting-merge':
      return explainAwaitingMerge(task, flow, observed);
    case 'awaiting-feature-merge':
      return explainAwaitingFeatureMerge(task, flow, observed);
    case 'awaiting-children':
      return explainAwaitingChildren(task, project, allTasks, flow);
    case 'failed':
      return explainFailed(task, flow);
    default:
      return explainDefault(phase, task.spec.type);
  }
}

/**
 * Inspect a task's flow context in a read-only, side-effect-free way.
 *
 * Returns the current phase, allowed transitions, fully resolved project flow,
 * a summary of worker/manual-action status, and an explanatory "expected next"
 * block derived from the same rules used by the reconciler.
 */
export function inspectTaskFlow(
  task: Task,
  project: Project,
  allTasks: Task[],
  observedRuns?: ObservedRuns,
): TaskFlowInspection {
  const currentPhase = task.status?.phase ?? 'pending';
  const flow = resolveFlow(project);
  const actions = extractManualActions(task);
  const worker = task.status?.worker;

  return {
    project: project.metadata.name,
    task: task.metadata.name,
    taskType: task.spec.type,
    currentPhase,
    validTargetPhases: TRANSITION_TABLE[currentPhase] ?? [],
    resolvedFlow: flow,
    statusSummary: {
      worker: {
        runName: worker?.runName,
        reviewRunName: worker?.reviewRunName,
        mergeRunName: worker?.mergeRunName,
        buildTasksFacilitatorRun: worker?.buildTasksFacilitatorRun,
        reviewApproved: worker?.reviewApproved,
        reviewFeedback: worker?.reviewFeedback,
        mergeError: worker?.mergeError,
        mergedAt: worker?.mergedAt,
        retryCount: worker?.retryCount,
        aiReworkCount: worker?.aiReworkCount,
      },
      manualActionFlagsPresent: presentManualActionFlags(actions),
      blocked: task.status?.blocked,
      blockedReason: task.status?.blockedReason,
      retryAfter: task.status?.retryAfter,
    },
    expectedNext: buildExpectedNext(task, project, allTasks, flow, observedRuns ?? {}),
  };
}
