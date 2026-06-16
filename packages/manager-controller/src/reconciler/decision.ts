// Pure decision engine — no side effects, no Kubernetes calls, no clock reads.

import { createHash } from 'node:crypto';
import type { Project, Run, RunPhase, Task, TaskPhase } from '@percussionist/api';
import { resolveMergeBranch, resolveParentBranch, resolveTaskBranch } from '../branch-resolver.js';
import { auxiliaryRunName, workerRunName } from '../worker-builder.js';
import type { ReconcileEffect } from './effects.js';
import type { ResolvedFlow } from './flow.js';
import { getConsumedAnnotationKeys, getMergeVerdict, getReviewVerdict } from './observations.js';
import { isValidTransition } from './transitions.js';

function summarizeEffect(input: ReconcileInput, run: Run): ReconcileEffect | undefined {
  // ConfigMap summary generation is independent of vector-memory storage.
  // The summarizer writes `summary-{sessionID}` to the run's session ConfigMap
  // regardless of whether spec.embedding.enabled is true or false.
  const sessionID = run.status?.sessionID;
  if (!sessionID) return undefined;
  return {
    type: 'SummarizeSession',
    project: input.project.metadata.name,
    runName: run.metadata.name,
    sessionID,
  };
}

export interface ObservedRuns {
  worker?: Run;
  review?: Run;
  merge?: Run;
  buildgen?: Run;
}

export interface ManualActions {
  approved?: boolean;
  requestChanges?: boolean;
  reworkFeedback?: string;
  abandon?: boolean;
  answer?: string;
}

export interface CapacitySnapshot {
  activeCount: number;
  maxParallel: number;
}

export interface ReconcileInput {
  task: Task;
  project: Project;
  allTasks: Task[];
  observed: ObservedRuns;
  manualActions: ManualActions;
  flow: ResolvedFlow;
  capacity: CapacitySnapshot;
  now: string;
}

export interface AuditEvent {
  project: string;
  task: string;
  fromPhase: TaskPhase;
  toPhase?: TaskPhase;
  reason: string;
  message?: string;
  effects: string[];
  observedRuns?: Record<string, string | undefined>;
  at: string;
}

export interface ReconcileDecision {
  taskName: string;
  fromPhase: TaskPhase;
  toPhase?: TaskPhase;
  statusPatch?: Record<string, unknown>;
  effects: ReconcileEffect[];
  events: AuditEvent[];
}

function getEffectiveRunPhase(run: Run | undefined): RunPhase | undefined {
  const phase = run?.status?.phase;
  if (!run?.status?.podPhase) return phase;
  if (run.status.podPhase !== 'Failed') return phase;
  if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') return phase;
  return 'Failed';
}

export function decide(input: ReconcileInput): ReconcileDecision {
  const { task, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = (task.status?.phase ?? 'pending') as TaskPhase;

  // Terminal phases: no decision.
  if (fromPhase === 'done' || fromPhase === 'idea') {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  // Blocked tasks: no decision.
  if (task.status?.blocked) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  let decision: ReconcileDecision;

  switch (fromPhase) {
    case 'pending':
      decision = decidePending(input);
      break;
    case 'scheduled':
      decision = decideScheduled(input);
      break;
    case 'initializing':
      decision = decideInitializing(input);
      break;
    case 'running':
      decision = decideRunning(input);
      break;
    case 'waiting-for-input':
      decision = decideWaitingForInput(input);
      break;
    case 'succeeded':
      decision = decideSucceeded(input);
      break;
    case 'reviewing':
      decision = decideReviewing(input);
      break;
    case 'awaiting-human':
      decision = decideAwaitingHuman(input);
      break;
    case 'awaiting-merge':
      decision = decideAwaitingMerge(input);
      break;
    case 'rework-requested':
      decision = decideReworkRequested(input);
      break;
    case 'generating-builds':
      decision = decideGeneratingBuilds(input);
      break;
    case 'awaiting-children':
      decision = decideAwaitingChildren(input);
      break;
    case 'awaiting-feature-merge':
      decision = decideAwaitingFeatureMerge(input);
      break;
    case 'failed':
      decision = decideFailed(input);
      break;
    default:
      return { taskName, fromPhase, effects: [], events: [] };
  }

  // Validate transition legality.
  if (decision.toPhase && !isValidTransition(fromPhase, decision.toPhase)) {
    // Log but don't throw — the executor will reject.
    decision.events.push({
      project: input.project.metadata.name,
      task: taskName,
      fromPhase,
      toPhase: decision.toPhase,
      reason: 'InvalidTransitionBlocked',
      message: `Decision engine proposed illegal transition: ${fromPhase} → ${decision.toPhase}`,
      effects: decision.effects.map((e) => e.type),
      at: now,
    });
    decision.toPhase = undefined;
    decision.effects = [];
  }

  return decision;
}

function makeEvent(
  input: ReconcileInput,
  fromPhase: TaskPhase,
  toPhase: TaskPhase | undefined,
  reason: string,
  message?: string,
  effects?: ReconcileEffect[],
): AuditEvent {
  return {
    project: input.project.metadata.name,
    task: input.task.metadata.name,
    fromPhase,
    toPhase,
    reason,
    message,
    effects: effects?.map((e) => e.type) ?? [],
    observedRuns: {
      worker: input.observed.worker?.status?.phase,
      review: input.observed.review?.status?.phase,
      merge: input.observed.merge?.status?.phase,
      buildgen: input.observed.buildgen?.status?.phase,
    },
    at: input.now,
  };
}

function decidePending(input: ReconcileInput): ReconcileDecision {
  const { task, project, allTasks, capacity, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'pending' as TaskPhase;

  if (capacity.activeCount >= capacity.maxParallel) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  // Predecessor check.
  if (task.spec.predecessorRef) {
    const pred = allTasks.find((t) => t.metadata.name === task.spec.predecessorRef);
    if (pred?.status?.phase !== 'done') {
      return { taskName, fromPhase, effects: [], events: [] };
    }
    if (project.spec.featureBranchingEnabled && !pred.status?.worker?.mergedAt) {
      return { taskName, fromPhase, effects: [], events: [] };
    }
  }

  // Retry backoff check.
  if (task.status?.retryAfter) {
    const retryAfter = new Date(task.status.retryAfter);
    const nowDate = new Date(now);
    if (retryAfter > nowDate) {
      return { taskName, fromPhase, effects: [], events: [] };
    }
  }

  return {
    taskName,
    fromPhase,
    toPhase: 'scheduled',
    effects: [],
    events: [makeEvent(input, fromPhase, 'scheduled', 'TaskScheduled')],
  };
}

function decideScheduled(input: ReconcileInput): ReconcileDecision {
  const { task, project, now, allTasks } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'scheduled' as TaskPhase;
  const retryCount = task.status?.worker?.retryCount ?? 0;
  const aiReworkCount = task.status?.worker?.aiReworkCount ?? 0;
  const reworkFeedback = task.status?.worker?.reviewFeedback;

  // Compute deterministic run name.
  const runName = workerRunName(project.metadata.name, taskName, retryCount, aiReworkCount);

  // Resolve feature-branch metadata so the diff view and workspace-init
  // have correct refs without relying on fallback to the Run spec.
  const gitBranch = resolveTaskBranch(task, project, allTasks);
  const parentBranch = resolveParentBranch(task, project, allTasks);
  const mergeIntoBranch = resolveMergeBranch(task, project, allTasks);

  return {
    taskName,
    fromPhase,
    toPhase: 'initializing',
    statusPatch: {
      worker: {
        runName,
        status: 'Running',
        startedAt: now,
        retryCount,
        aiReworkCount: task.status?.worker?.aiReworkCount ?? 0,
        gitBranch,
        parentBranch,
        mergeIntoBranch,
      },
    },
    effects: [{ type: 'ScheduleRun', runName, retryCount, reworkFeedback }],
    events: [makeEvent(input, fromPhase, 'initializing', 'WorkerRunCreating')],
  };
}

function decideInitializing(input: ReconcileInput): ReconcileDecision {
  const { now } = input;
  const taskName = input.task.metadata.name;
  const fromPhase = 'initializing' as TaskPhase;
  const run = input.observed.worker;

  if (!run) {
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { status: 'Failed' } },
      effects: [],
      events: [
        makeEvent(
          input,
          fromPhase,
          'failed',
          'WorkerRunMissing',
          'Run disappeared during initialization',
        ),
      ],
    };
  }

  const runPhase = getEffectiveRunPhase(run);
  if (runPhase === 'Running' || runPhase === 'WaitingForInput') {
    return {
      taskName,
      fromPhase,
      toPhase: 'running',
      effects: [],
      events: [makeEvent(input, fromPhase, 'running', 'WorkerRunRunning')],
    };
  }

  if (runPhase === 'Failed') {
    const effects: ReconcileEffect[] = [];
    const summary = summarizeEffect(input, run);
    if (summary) effects.push(summary);
    const runStart = run.status?.startedAt;
    const lastFailureDuration = runStart
      ? Math.round((new Date(now).getTime() - new Date(runStart).getTime()) / 1000)
      : 0;
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { status: 'Failed', completedAt: now }, lastFailureDuration },
      effects,
      events: [
        makeEvent(
          input,
          fromPhase,
          'failed',
          'WorkerRunFailed',
          'Run failed during initialization',
        ),
      ],
    };
  }

  if (runPhase === 'Succeeded') {
    const effects: ReconcileEffect[] = [];
    const summary = summarizeEffect(input, run);
    if (summary) effects.push(summary);
    return {
      taskName,
      fromPhase,
      toPhase: 'succeeded',
      statusPatch: { worker: { status: 'Succeeded', completedAt: now } },
      effects,
      events: [
        makeEvent(
          input,
          fromPhase,
          'succeeded',
          'WorkerRunSucceeded',
          'Run completed before running transition',
        ),
      ],
    };
  }

  return { taskName, fromPhase, effects: [], events: [] };
}

function decideRunning(input: ReconcileInput): ReconcileDecision {
  const { task, flow, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'running' as TaskPhase;
  const run = input.observed.worker;

  if (!run) {
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { status: 'Failed' } },
      effects: [],
      events: [makeEvent(input, fromPhase, 'failed', 'WorkerRunMissing', 'Run pod disappeared')],
    };
  }

  const runPhase = getEffectiveRunPhase(run);

  if (runPhase === 'Succeeded') {
    const effects: ReconcileEffect[] = [];
    const summary = summarizeEffect(input, run);
    if (summary) effects.push(summary);
    return {
      taskName,
      fromPhase,
      toPhase: 'succeeded',
      statusPatch: { worker: { status: 'Succeeded', completedAt: now } },
      effects,
      events: [makeEvent(input, fromPhase, 'succeeded', 'WorkerRunSucceeded')],
    };
  }

  if (runPhase === 'Failed') {
    const effects: ReconcileEffect[] = [];
    const summary = summarizeEffect(input, run);
    if (summary) effects.push(summary);
    const runStart = run.status?.startedAt;
    const lastFailureDuration = runStart
      ? Math.round((new Date(now).getTime() - new Date(runStart).getTime()) / 1000)
      : 0;
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { status: 'Failed', completedAt: now }, lastFailureDuration },
      effects,
      events: [makeEvent(input, fromPhase, 'failed', 'WorkerRunFailed')],
    };
  }

  if (runPhase === 'WaitingForInput') {
    if (task.spec.type !== 'PLAN') {
      return {
        taskName,
        fromPhase,
        toPhase: 'failed',
        statusPatch: { worker: { status: 'Failed' } },
        effects: [],
        events: [
          makeEvent(
            input,
            fromPhase,
            'failed',
            'BuildCannotWait',
            'BUILD tasks cannot wait for input',
          ),
        ],
      };
    }
    return {
      taskName,
      fromPhase,
      toPhase: 'waiting-for-input',
      effects: [],
      events: [makeEvent(input, fromPhase, 'waiting-for-input', 'WaitingForInput')],
    };
  }

  if (runPhase === 'Running') {
    const staleThresholdMs = flow.timeouts.runningStaleSeconds * 1000;
    const lastEvent = run.status?.lastEventAt;
    if (lastEvent) {
      const elapsed = new Date(now).getTime() - new Date(lastEvent).getTime();
      if (elapsed > staleThresholdMs) {
        return {
          taskName,
          fromPhase,
          toPhase: 'failed',
          statusPatch: { worker: { status: 'Failed' } },
          effects: [],
          events: [
            makeEvent(
              input,
              fromPhase,
              'failed',
              'WorkerRunStale',
              `No activity for ${flow.timeouts.runningStaleSeconds}s`,
            ),
          ],
        };
      }
    }
  }

  return { taskName, fromPhase, effects: [], events: [] };
}

function decideWaitingForInput(input: ReconcileInput): ReconcileDecision {
  const { task, manualActions, observed } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'waiting-for-input' as TaskPhase;

  if (!manualActions.answer) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  if (observed.worker?.status?.phase === 'Running') {
    return {
      taskName,
      fromPhase,
      toPhase: 'running',
      effects: [{ type: 'ClearTaskAnnotations', keys: ['percussionist.dev/action-answer'] }],
      events: [makeEvent(input, fromPhase, 'running', 'InputAnswered')],
    };
  }

  return { taskName, fromPhase, effects: [], events: [] };
}

function decideSucceeded(input: ReconcileInput): ReconcileDecision {
  const { task, flow, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'succeeded' as TaskPhase;

  // For BUILD tasks, check flow.build.onSuccess.
  if (task.spec.type === 'BUILD') {
    if (flow.build.onSuccess === 'done') {
      const buildRunName = task.status?.worker?.runName;
      return {
        taskName,
        fromPhase,
        toPhase: 'done',
        statusPatch: { worker: { status: 'Succeeded', completedAt: now } },
        effects: buildRunName ? [{ type: 'CleanupWorktree', runName: buildRunName }] : [],
        events: [makeEvent(input, fromPhase, 'done', 'BuildSucceededAutoDone')],
      };
    }
    // human-review or ai-review: go to reviewing with a review run.
    if (flow.review.aiReviewerEnabled) {
      const workerRunName = task.status?.worker?.runName;
      if (!workerRunName) {
        // No worker run to review — fallback to human.
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-human',
          effects: [],
          events: [makeEvent(input, fromPhase, 'awaiting-human', 'NoWorkerRunToReview')],
        };
      }
      const retryCount = task.status?.worker?.retryCount ?? 0;
      const aiReworkCount = task.status?.worker?.aiReworkCount ?? 0;
      // Use both counters in suffix to avoid collisions (e.g., 2+1 vs 1+2 both equal "3")
      const reviewSuffix = createHash('sha256')
        .update(`${input.project.metadata.name}:${taskName}:review:${retryCount}:${aiReworkCount}`)
        .digest('hex')
        .slice(0, 8);
      const reviewRunName = auxiliaryRunName(
        input.project.metadata.name,
        'review',
        taskName,
        reviewSuffix,
      );

      return {
        taskName,
        fromPhase,
        toPhase: 'reviewing',
        statusPatch: {
          worker: {
            reviewRunName,
            status: 'Running',
          },
        },
        effects: [
          {
            type: 'ScheduleReviewRun',
            reviewRunName,
            succeededRunName: workerRunName,
            reviewAgent: flow.review.agent,
          },
        ],
        events: [makeEvent(input, fromPhase, 'reviewing', 'ReviewRunCreating')],
      };
    }
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [],
      events: [makeEvent(input, fromPhase, 'awaiting-human', 'AwaitingHumanReview')],
    };
  }

  // PLAN tasks: go to awaiting-human for approval.
  return {
    taskName,
    fromPhase,
    toPhase: 'awaiting-human',
    effects: [],
    events: [makeEvent(input, fromPhase, 'awaiting-human', 'PlanAwaitingApproval')],
  };
}

function decideReviewing(input: ReconcileInput): ReconcileDecision {
  const { task, flow, observed, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'reviewing' as TaskPhase;
  const reviewRunName = task.status?.worker?.reviewRunName;

  if (!reviewRunName) {
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'NoReviewRun',
          'Falling back to human review',
        ),
      ],
    };
  }

  const reviewRun = observed.review;
  if (!reviewRun) {
    // Review run doesn't exist yet — the executor may still be creating it.
    // Stay in reviewing and wait for the next reconcile cycle.
    return { taskName, fromPhase, effects: [], events: [] };
  }

  const reviewPhase = getEffectiveRunPhase(reviewRun);

  if (reviewPhase === 'Failed') {
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [],
      events: [makeEvent(input, fromPhase, 'awaiting-human', 'ReviewRunFailed')],
    };
  }

  const staleThresholdMs = flow.timeouts.reviewStaleSeconds * 1000;
  if (reviewPhase === 'Running') {
    const lastEvent = reviewRun.status?.lastEventAt;
    if (lastEvent) {
      const elapsed = new Date(now).getTime() - new Date(lastEvent).getTime();
      if (elapsed > staleThresholdMs) {
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-human',
          effects: [],
          events: [
            makeEvent(
              input,
              fromPhase,
              'awaiting-human',
              'ReviewRunStale',
              `Stale after ${flow.timeouts.reviewStaleSeconds}s`,
            ),
          ],
        };
      }
    }
    return { taskName, fromPhase, effects: [], events: [] };
  }

  if (reviewPhase !== 'Succeeded') {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  // Build a review feedback string that includes diagnosis.
  function buildReviewFeedback(diagnosis?: string, feedback?: string): string {
    let result = diagnosis ?? '';
    if (feedback) {
      result += (result ? '\n\n' : '') + feedback;
    }
    return result;
  }

  // Review succeeded — check for structured verdict annotation.
  const verdict = getReviewVerdict(reviewRun);
  if (verdict) {
    if (verdict.action === 'approve') {
      // Compute attempt number for review record
      const attempt =
        (task.status?.worker?.retryCount ?? 0) + (task.status?.worker?.aiReworkCount ?? 0);

      // Append review record to statusPatch.reviews
      const existingReviews = task.status?.reviews ?? [];
      const newRecord: {
        action: string;
        diagnosis?: string;
        feedback?: string;
        reviewRunName: string;
        reviewedAt: string;
        attempt?: number;
      } = {
        action: 'approve',
        diagnosis: verdict.diagnosis,
        feedback: verdict.feedback,
        reviewRunName: reviewRun.metadata.name,
        reviewedAt: now,
        attempt,
      };
      const feedback = buildReviewFeedback(verdict.diagnosis, verdict.feedback);

      return {
        taskName,
        fromPhase,
        toPhase: 'awaiting-human',
        statusPatch: {
          worker: {
            reviewApproved: true,
            reviewFeedback: feedback,
          },
          reviews: [...existingReviews, newRecord],
          ...(verdict.diffFindings ? { diffFindings: verdict.diffFindings } : {}),
        },
        effects: [],
        events: [makeEvent(input, fromPhase, 'awaiting-human', 'ReviewApproved', feedback)],
      };
    }
    if (verdict.action === 'request_changes') {
      const aiCount = (task.status?.worker?.aiReworkCount ?? 0) + 1;
      const ceiling = flow.review.maxAutoReworks;
      // Compute attempt number for review record
      // Attempt is the current retry count plus how many AI reworks have already been done before this one
      const attempt = (task.status?.worker?.retryCount ?? 0) + aiCount - 1;

      // Append review record to statusPatch.reviews
      const existingReviews = task.status?.reviews ?? [];
      const newRecord: {
        action: string;
        diagnosis?: string;
        feedback?: string;
        reviewRunName: string;
        reviewedAt: string;
        attempt?: number;
      } = {
        action: 'request_changes',
        diagnosis: verdict.diagnosis,
        feedback: verdict.feedback,
        reviewRunName: reviewRun.metadata.name,
        reviewedAt: now,
        attempt,
      };
      const feedback = buildReviewFeedback(verdict.diagnosis, verdict.feedback);

      if (aiCount > ceiling) {
        const escalatedRecord = { ...newRecord, action: 'escalate' };
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-human',
          statusPatch: {
            worker: {
              aiReworkCount: aiCount,
              reviewFeedback: `${feedback}\n\n(AI rework ceiling reached)`,
            },
            reviews: [...existingReviews, escalatedRecord],
            ...(verdict.diffFindings ? { diffFindings: verdict.diffFindings } : {}),
          },
          effects: [],
          events: [
            makeEvent(input, fromPhase, 'awaiting-human', 'ReviewReworkCeilingReached', feedback),
          ],
        };
      }
      return {
        taskName,
        fromPhase,
        toPhase: 'rework-requested',
        statusPatch: {
          worker: {
            aiReworkCount: aiCount,
            reviewFeedback: feedback,
          },
          reviews: [...existingReviews, newRecord],
          ...(verdict.diffFindings ? { diffFindings: verdict.diffFindings } : {}),
        },
        effects: [],
        events: [
          makeEvent(input, fromPhase, 'rework-requested', 'ReviewRequestedChanges', feedback),
        ],
      };
    }
  }

  // No verdict annotation — fallback to human review.
  return {
    taskName,
    fromPhase,
    toPhase: 'awaiting-human',
    effects: [],
    events: [
      makeEvent(
        input,
        fromPhase,
        'awaiting-human',
        'ReviewSucceeded',
        'Review complete but no structured verdict; awaiting human decision',
      ),
    ],
  };
}

function decideAwaitingHuman(input: ReconcileInput): ReconcileDecision {
  const { task, manualActions, flow, now, capacity } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'awaiting-human' as TaskPhase;

  if (manualActions.abandon) {
    const consumedKeys = getConsumedAnnotationKeys(manualActions);
    return {
      taskName,
      fromPhase,
      toPhase: 'done',
      statusPatch: { worker: { status: 'Succeeded', completedAt: now } },
      effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
      events: [makeEvent(input, fromPhase, 'done', 'TaskAbandoned')],
    };
  }

  if (manualActions.requestChanges) {
    const consumedKeys = getConsumedAnnotationKeys(manualActions);
    return {
      taskName,
      fromPhase,
      toPhase: 'rework-requested',
      statusPatch: {
        worker: {
          reviewFeedback: manualActions.reworkFeedback ?? 'No feedback provided',
          retryCount: (task.status?.worker?.retryCount ?? 0) + 1,
          aiReworkCount: 0,
        },
      },
      effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
      events: [
        makeEvent(
          input,
          fromPhase,
          'rework-requested',
          'HumanRequestedChanges',
          manualActions.reworkFeedback,
        ),
      ],
    };
  }

  if (manualActions.approved) {
    const consumedKeys = getConsumedAnnotationKeys(manualActions);
    if (task.spec.type === 'PLAN') {
      // Merge failure retry — skip buildgen cycle, retry merge directly.
      if (task.status?.worker?.mergeError) {
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-feature-merge',
          statusPatch: { worker: { mergeRunName: null, mergeError: null } },
          effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
          events: [
            makeEvent(
              input,
              fromPhase,
              'awaiting-feature-merge',
              'MergeRetryApproved',
              'Human approved retry of failed feature merge',
            ),
          ],
        };
      }
      if (flow.plan.onApprove === 'done') {
        const planRunName = task.status?.worker?.runName;
        return {
          taskName,
          fromPhase,
          toPhase: 'done',
          effects: [
            { type: 'ClearTaskAnnotations', keys: consumedKeys },
            ...(planRunName ? [{ type: 'CleanupWorktree' as const, runName: planRunName }] : []),
          ],
          events: [makeEvent(input, fromPhase, 'done', 'PlanApprovedDone')],
        };
      }
      if (capacity.activeCount >= capacity.maxParallel) {
        return { taskName, fromPhase, effects: [], events: [] };
      }
      return {
        taskName,
        fromPhase,
        toPhase: 'generating-builds',
        effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
        events: [makeEvent(input, fromPhase, 'generating-builds', 'PlanApprovedGenerateBuilds')],
      };
    }

    if (task.spec.type === 'BUILD') {
      if (flow.build.onApprove === 'done' || flow.merge.mode === 'disabled') {
        const buildRunName = task.status?.worker?.runName;
        return {
          taskName,
          fromPhase,
          toPhase: 'done',
          effects: [
            { type: 'ClearTaskAnnotations', keys: consumedKeys },
            ...(buildRunName ? [{ type: 'CleanupWorktree' as const, runName: buildRunName }] : []),
          ],
          events: [makeEvent(input, fromPhase, 'done', 'BuildApprovedDone')],
        };
      }
      const retryCount = task.status?.worker?.retryCount ?? 0;
      const mergeSeq = createHash('sha256')
        .update(`${input.project.metadata.name}:${taskName}:${retryCount}`)
        .digest('hex')
        .slice(0, 8);
      if (capacity.activeCount >= capacity.maxParallel) {
        return { taskName, fromPhase, effects: [], events: [] };
      }
      const mergeRunName = auxiliaryRunName(
        input.project.metadata.name,
        'merge',
        taskName,
        mergeSeq,
      );
      return {
        taskName,
        fromPhase,
        toPhase: 'awaiting-merge',
        statusPatch: { worker: { mergeRunName } },
        effects: [
          { type: 'ClearTaskAnnotations', keys: consumedKeys },
          { type: 'ScheduleMergeRun', mergeRunName },
        ],
        events: [makeEvent(input, fromPhase, 'awaiting-merge', 'BuildApprovedMerge')],
      };
    }
  }

  return { taskName, fromPhase, effects: [], events: [] };
}

function decideAwaitingMerge(input: ReconcileInput): ReconcileDecision {
  const { task, flow, observed, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'awaiting-merge' as TaskPhase;
  let mergeRunName = task.status?.worker?.mergeRunName;

  if (!mergeRunName) {
    const retSuffix = createHash('sha256')
      .update(
        `${input.project.metadata.name}:${taskName}:merge:${task.status?.worker?.retryCount ?? 0}`,
      )
      .digest('hex')
      .slice(0, 10);
    mergeRunName = auxiliaryRunName(input.project.metadata.name, 'merge', taskName, retSuffix);
    return {
      taskName,
      fromPhase,
      toPhase: undefined,
      statusPatch: { worker: { mergeRunName } },
      effects: [{ type: 'ScheduleMergeRun', mergeRunName }],
      events: [makeEvent(input, fromPhase, 'awaiting-merge', 'MergeRunScheduled')],
    };
  }

  const mergeRun = observed.merge;
  if (!mergeRun) {
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { status: 'Failed', mergeError: 'Merge run disappeared' } },
      effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
      events: [makeEvent(input, fromPhase, 'failed', 'MergeRunMissing')],
    };
  }

  const mergePhase = getEffectiveRunPhase(mergeRun);

  if (mergePhase === 'Succeeded') {
    const verdict = getMergeVerdict(mergeRun);
    const verdictMessage = [verdict?.diagnosis, verdict?.details].filter(Boolean).join('\n\n');

    if (verdict) {
      if (
        (verdict.outcome === 'merged' || verdict.outcome === 'already-merged') &&
        !verdict.requiresHuman
      ) {
        const buildRunName = task.status?.worker?.runName;
        const cleanupEffects: ReconcileEffect[] = [
          { type: 'CleanupWorktree', runName: mergeRunName },
        ];
        if (buildRunName) {
          cleanupEffects.push({ type: 'CleanupWorktree', runName: buildRunName });
        }
        return {
          taskName,
          fromPhase,
          toPhase: 'done',
          statusPatch: {
            worker: { status: 'Succeeded', mergedAt: now, completedAt: now },
          },
          effects: cleanupEffects,
          events: [makeEvent(input, fromPhase, 'done', 'MergeSucceeded')],
        };
      }

      if (verdict.outcome === 'push-failed' || verdict.outcome === 'transient-failure') {
        return {
          taskName,
          fromPhase,
          toPhase: 'failed',
          statusPatch: {
            worker: {
              status: 'Failed',
              mergeError: verdictMessage || `Merge outcome: ${verdict.outcome}`,
            },
          },
          effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
          events: [
            makeEvent(
              input,
              fromPhase,
              'failed',
              'MergeStructuredFailure',
              verdictMessage || `Merge outcome: ${verdict.outcome}`,
            ),
          ],
        };
      }

      if (verdict.requiresHuman || verdict.outcome === 'conflict') {
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-human',
          statusPatch: {
            worker: {
              mergeError: verdictMessage || 'Merge requires human intervention',
            },
          },
          effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
          events: [
            makeEvent(
              input,
              fromPhase,
              'awaiting-human',
              'MergeNeedsHumanIntervention',
              verdictMessage || `Merge outcome: ${verdict.outcome}`,
            ),
          ],
        };
      }
    }

    const buildRunName = task.status?.worker?.runName;
    const cleanupEffects: ReconcileEffect[] = [{ type: 'CleanupWorktree', runName: mergeRunName }];
    if (buildRunName) {
      cleanupEffects.push({ type: 'CleanupWorktree', runName: buildRunName });
    }
    return {
      taskName,
      fromPhase,
      toPhase: 'done',
      statusPatch: {
        worker: { status: 'Succeeded', mergedAt: now, completedAt: now },
      },
      effects: cleanupEffects,
      events: [
        makeEvent(
          input,
          fromPhase,
          'done',
          'MergeSucceededUnstructured',
          'Merge run succeeded without structured merge verdict; falling back to legacy success behavior',
        ),
      ],
    };
  }

  if (mergePhase === 'Failed') {
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: {
        worker: { status: 'Failed', mergeError: mergeRun.status?.message ?? 'Merge failed' },
      },
      effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
      events: [makeEvent(input, fromPhase, 'failed', 'MergeFailed')],
    };
  }

  if (mergePhase === 'Running') {
    const staleThresholdMs = flow.timeouts.mergeStaleSeconds * 1000;
    const lastEvent = mergeRun.status?.lastEventAt;
    if (lastEvent) {
      const elapsed = new Date(now).getTime() - new Date(lastEvent).getTime();
      if (elapsed > staleThresholdMs) {
        return {
          taskName,
          fromPhase,
          toPhase: 'failed',
          statusPatch: {
            worker: {
              status: 'Failed',
              mergeError: `Stale after ${flow.timeouts.mergeStaleSeconds}s`,
            },
          },
          effects: [
            { type: 'DeleteRun', name: mergeRunName, reason: 'MergeRunStale' },
            { type: 'CleanupWorktree', runName: mergeRunName },
          ],
          events: [makeEvent(input, fromPhase, 'failed', 'MergeRunStale')],
        };
      }
    }
  }

  return { taskName, fromPhase, effects: [], events: [] };
}

function decideReworkRequested(input: ReconcileInput): ReconcileDecision {
  const { task, capacity } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'rework-requested' as TaskPhase;

  if (capacity.activeCount >= capacity.maxParallel) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  return {
    taskName,
    fromPhase,
    toPhase: 'scheduled',
    effects: [],
    events: [makeEvent(input, fromPhase, 'scheduled', 'ReworkRescheduled')],
  };
}

function decideGeneratingBuilds(input: ReconcileInput): ReconcileDecision {
  const { task, project, observed } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'generating-builds' as TaskPhase;
  const buildgenRunName = task.status?.worker?.buildTasksFacilitatorRun;

  if (!buildgenRunName) {
    const succeededRunName = task.status?.worker?.runName;
    if (!succeededRunName) {
      return {
        taskName,
        fromPhase,
        toPhase: 'awaiting-human',
        effects: [],
        events: [makeEvent(input, fromPhase, 'awaiting-human', 'NoWorkerRunForBuildGen')],
      };
    }
    const suffix = createHash('sha256')
      .update(`${input.project.metadata.name}:${taskName}:buildgen`)
      .digest('hex')
      .slice(0, 10);
    const name = auxiliaryRunName(input.project.metadata.name, 'buildgen', taskName, suffix);
    return {
      taskName,
      fromPhase,
      toPhase: undefined,
      statusPatch: { worker: { buildTasksFacilitatorRun: name } },
      effects: [{ type: 'ScheduleBuildGenRun', buildgenRunName: name, succeededRunName }],
      events: [makeEvent(input, fromPhase, 'generating-builds', 'BuildGenRunCreating')],
    };
  }

  const buildgenRun = observed.buildgen;
  if (!buildgenRun) {
    // Run name is set but the run doesn't exist yet (still being created).
    // Wait for the next reconcile cycle instead of bouncing back.
    return { taskName, fromPhase, effects: [], events: [] };
  }

  const buildgenPhase = getEffectiveRunPhase(buildgenRun);

  if (buildgenPhase === 'Failed') {
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      statusPatch: { worker: { buildTasksFacilitatorRun: null } },
      effects: [],
      events: [makeEvent(input, fromPhase, 'awaiting-human', 'BuildGenFailed')],
    };
  }

  if (buildgenPhase !== 'Succeeded') {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  // Buildgen succeeded — check if child BUILD Task CRs exist.
  // The buildgen agent creates BUILD Task CRs directly via MCP tools.
  const childTasks = input.allTasks.filter(
    (t) => t.spec.type === 'BUILD' && t.spec.parentTaskRef === taskName,
  );

  if (childTasks.length === 0) {
    // Buildgen succeeded but created 0 child BUILD tasks. The agent either
    // decided no tasks are needed or failed to generate them. Escalate to human.
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      statusPatch: { worker: { buildTasksFacilitatorRun: null } },
      effects: [],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'NoBuildTasksCreated',
          `Buildgen "${buildgenRunName}" finished without creating any BUILD tasks`,
        ),
      ],
    };
  }

  // Child tasks exist — wait for them to complete.
  return {
    taskName,
    fromPhase,
    toPhase: 'awaiting-children',
    statusPatch: {
      worker: {
        buildTasksCreated: true,
        createdBuildTaskRefs: childTasks.map((t) => t.metadata.name),
      },
    },
    effects: [],
    events: [
      makeEvent(
        input,
        fromPhase,
        'awaiting-children',
        'BuildGenSucceeded',
        `Created ${childTasks.length} BUILD task(s)` +
          (project.spec.featureBranchingEnabled
            ? ', waiting for children before feature branch merge'
            : ''),
      ),
    ],
  };
}

function decideAwaitingChildren(input: ReconcileInput): ReconcileDecision {
  const { task, project, allTasks, flow } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'awaiting-children' as TaskPhase;

  const childTasks = allTasks.filter(
    (t) => t.spec.type === 'BUILD' && t.spec.parentTaskRef === taskName,
  );
  const hasChildren = childTasks.length > 0;
  const allDone =
    hasChildren &&
    childTasks.every((t) => t.status?.phase === 'done' && t.status?.worker?.mergedAt);

  if (!hasChildren) {
    // No child BUILD tasks exist — escalate to awaiting-human with explicit reason.
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'ChildTasksMissing',
          'No child BUILD tasks found while in awaiting-children phase',
        ),
      ],
    };
  }

  if (!allDone) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  // All children done — decide next step based on integration config.
  if (!project.spec.featureBranchingEnabled || flow.integration.mode === 'disabled') {
    return {
      taskName,
      fromPhase,
      toPhase: 'done',
      effects: [],
      events: [makeEvent(input, fromPhase, 'done', 'AllChildrenDoneNoIntegration')],
    };
  }

  if (flow.integration.mode === 'manual') {
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'AllChildrenDoneManualMerge',
          'All BUILD tasks complete. Merge feature branch to target manually.',
        ),
      ],
    };
  }

  // auto-merge mode — schedule merge run for feature branch → target.
  const mergeSuffix = createHash('sha256')
    .update(`${input.project.metadata.name}:${taskName}:merge`)
    .digest('hex')
    .slice(0, 10);
  const mergeRunName = auxiliaryRunName(
    input.project.metadata.name,
    'merge',
    taskName,
    mergeSuffix,
  );

  return {
    taskName,
    fromPhase,
    toPhase: 'awaiting-feature-merge',
    statusPatch: { worker: { mergeRunName } },
    effects: [{ type: 'ScheduleMergeRun', mergeRunName }],
    events: [
      makeEvent(
        input,
        fromPhase,
        'awaiting-feature-merge',
        'AutoMergingFeatureBranch',
        `Scheduled merge run for feature branch merge to target`,
      ),
    ],
  };
}

function decideAwaitingFeatureMerge(input: ReconcileInput): ReconcileDecision {
  const { task, flow, observed, now } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'awaiting-feature-merge' as TaskPhase;
  const mergeRunName = task.status?.worker?.mergeRunName;

  if (!mergeRunName) {
    // Create merge run if not yet assigned.
    const suffix = createHash('sha256')
      .update(`${input.project.metadata.name}:${taskName}:merge`)
      .digest('hex')
      .slice(0, 10);
    const name = auxiliaryRunName(input.project.metadata.name, 'merge', taskName, suffix);
    return {
      taskName,
      fromPhase,
      toPhase: undefined,
      statusPatch: { worker: { mergeRunName: name } },
      effects: [{ type: 'ScheduleMergeRun', mergeRunName: name }],
      events: [makeEvent(input, fromPhase, 'awaiting-feature-merge', 'MergeRunScheduled')],
    };
  }

  const mergeRun = observed.merge;
  if (!mergeRun) {
    return {
      taskName,
      fromPhase,
      toPhase: 'failed',
      statusPatch: { worker: { mergeError: 'Merge run disappeared' } },
      effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
      events: [makeEvent(input, fromPhase, 'failed', 'MergeRunMissing')],
    };
  }

  const mergePhase = getEffectiveRunPhase(mergeRun);

  if (mergePhase === 'Succeeded') {
    const verdict = getMergeVerdict(mergeRun);
    const verdictMessage = [verdict?.diagnosis, verdict?.details].filter(Boolean).join('\n\n');

    if (verdict) {
      if (
        (verdict.outcome === 'merged' || verdict.outcome === 'already-merged') &&
        !verdict.requiresHuman
      ) {
        return {
          taskName,
          fromPhase,
          toPhase: 'done',
          statusPatch: { worker: { mergedAt: now } },
          effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
          events: [makeEvent(input, fromPhase, 'done', 'FeatureBranchMerged')],
        };
      }

      if (verdict.outcome === 'push-failed' || verdict.outcome === 'transient-failure') {
        return {
          taskName,
          fromPhase,
          toPhase: 'failed',
          statusPatch: {
            worker: {
              status: 'Failed',
              mergeError: verdictMessage || `Merge outcome: ${verdict.outcome}`,
            },
          },
          effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
          events: [
            makeEvent(
              input,
              fromPhase,
              'failed',
              'FeatureBranchMergeStructuredFailure',
              verdictMessage || `Merge outcome: ${verdict.outcome}`,
            ),
          ],
        };
      }

      if (verdict.requiresHuman || verdict.outcome === 'conflict') {
        return {
          taskName,
          fromPhase,
          toPhase: 'awaiting-human',
          statusPatch: {
            worker: {
              mergeError: verdictMessage || 'Feature branch merge requires human intervention',
            },
          },
          effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
          events: [
            makeEvent(
              input,
              fromPhase,
              'awaiting-human',
              'FeatureBranchMergeNeedsHumanIntervention',
              verdictMessage || `Merge outcome: ${verdict.outcome}`,
            ),
          ],
        };
      }
    }

    return {
      taskName,
      fromPhase,
      toPhase: 'done',
      statusPatch: { worker: { mergedAt: now } },
      effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
      events: [
        makeEvent(
          input,
          fromPhase,
          'done',
          'FeatureBranchMergedUnstructured',
          'Merge run succeeded without structured merge verdict; falling back to legacy success behavior',
        ),
      ],
    };
  }

  if (mergePhase === 'Failed') {
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      statusPatch: { worker: { mergeError: mergeRun.status?.message } },
      effects: [{ type: 'CleanupWorktree', runName: mergeRunName }],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'FeatureBranchMergeFailed',
          mergeRun.status?.message ?? 'Merge run failed',
        ),
      ],
    };
  }

  // Staleness check for running merge runs.
  if (mergePhase === 'Running') {
    const staleThresholdMs = flow.timeouts.mergeStaleSeconds * 1000;
    const lastEvent = mergeRun.status?.lastEventAt;
    if (lastEvent) {
      const elapsed = new Date(now).getTime() - new Date(lastEvent).getTime();
      if (elapsed > staleThresholdMs) {
        return {
          taskName,
          fromPhase,
          toPhase: 'failed',
          statusPatch: {
            worker: {
              status: 'Failed',
              mergeError: `Stale after ${flow.timeouts.mergeStaleSeconds}s`,
            },
          },
          effects: [
            { type: 'DeleteRun', name: mergeRunName, reason: 'MergeRunStale' },
            { type: 'CleanupWorktree', runName: mergeRunName },
          ],
          events: [makeEvent(input, fromPhase, 'failed', 'FeatureMergeRunStale')],
        };
      }
    }
  }

  // Still running or unknown — wait.
  return { taskName, fromPhase, effects: [], events: [] };
}

function decideFailed(input: ReconcileInput): ReconcileDecision {
  const { task, flow, manualActions, now, capacity } = input;
  const taskName = task.metadata.name;
  const fromPhase = 'failed' as TaskPhase;

  // Handle human-triggered actions (via approve/request-changes annotations).
  if (manualActions.approved) {
    const consumedKeys = getConsumedAnnotationKeys(manualActions);
    const worker = task.status?.worker;

    if (worker?.mergeError || worker?.mergeRunName) {
      // Merge failure — clear old mergeRunName so decideAwaitingMerge()
      // generates a fresh, uniquely-named merge run.
      if (capacity.activeCount >= capacity.maxParallel) {
        return { taskName, fromPhase, effects: [], events: [] };
      }
      return {
        taskName,
        fromPhase,
        toPhase: 'awaiting-merge',
        statusPatch: { worker: { mergeRunName: null, mergeError: null } },
        effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
        events: [
          makeEvent(
            input,
            fromPhase,
            'awaiting-merge',
            'MergeRetryApproved',
            'Human approved retry of failed merge',
          ),
        ],
      };
    }

    // Other failure — escalate to human.
    return {
      taskName,
      fromPhase,
      toPhase: 'awaiting-human',
      effects: [{ type: 'ClearTaskAnnotations', keys: consumedKeys }],
      events: [
        makeEvent(
          input,
          fromPhase,
          'awaiting-human',
          'FailureEscalated',
          'Human reviewed failed task',
        ),
      ],
    };
  }

  if (!flow.retry.enabled) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  const duration = task.status?.lastFailureDuration ?? 0;
  if (duration < flow.retry.poisonPillThresholdSeconds) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  const retryCount = task.status?.worker?.retryCount ?? 0;
  if (retryCount >= flow.retry.maxAttempts - 1) {
    return { taskName, fromPhase, effects: [], events: [] };
  }

  const backoff = Math.min(
    flow.retry.backoffSeconds * flow.retry.backoffMultiplier ** retryCount,
    flow.retry.maxBackoffSeconds,
  );
  const retryAfter = new Date(new Date(now).getTime() + backoff * 1000).toISOString();

  return {
    taskName,
    fromPhase,
    toPhase: 'pending',
    statusPatch: {
      worker: { retryCount: retryCount + 1 },
      retryAfter,
    },
    effects: [],
    events: [
      makeEvent(
        input,
        fromPhase,
        'pending',
        'RetryScheduled',
        `Retry ${retryCount + 1}/${flow.retry.maxAttempts} after ${backoff}s`,
      ),
    ],
  };
}
