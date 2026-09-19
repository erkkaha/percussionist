// lib/attention.ts — server-authoritative selection for the HITL inbox.
//
// Web Push (lib/push-triggers.ts) fires on transitions into the human-gate
// phases, but the in-app notification history is in-memory and page-load
// scoped, and the board's review column mixes human-gated tasks with ones that
// are progressing automatically. This module is the pure selection layer behind
// a pull-based "Needs attention" inbox: given the Task CRs (and, optionally, a
// run-name → Run.phase map for reconciler lag) it decides which tasks are
// waiting on a human and why.
//
// Deliberately free of Hono/Kube imports so it can be unit-tested directly,
// mirroring the shape of push-triggers.ts. The core phase set matches the push
// policy's PUSHED_TASK_PHASES so the two can never drift.
//
// One deliberate exception: an `awaiting-feature-merge` task with an open PR
// (worker.prNumber set, worker.mergedAt unset) is genuinely parked on a human —
// the PR must be merged on GitHub — but Web Push stays quiet for that phase by
// design. It is included here as an opt-in extension, so the in-app inbox count
// can exceed the number of push notifications the operator received. See
// lib/push-triggers.ts for the push-side rationale.

import type { Task, TaskType } from '@percussionist/api';

export const ATTENTION_PHASES = ['awaiting-human', 'waiting-for-input', 'failed'] as const;
export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

/** The one phase outside the push-parity set that the inbox still surfaces. */
export const OPEN_PR_PHASE = 'awaiting-feature-merge' as const;

/**
 * Phase an inbox item can carry: the push-parity set, plus the open-PR
 * extension. Kept separate from {@link AttentionPhase} so the push-parity
 * contract stays explicit.
 */
export type AttentionItemPhase = AttentionPhase | typeof OPEN_PR_PHASE;

const ATTENTION_PHASE_SET: ReadonlySet<string> = new Set(ATTENTION_PHASES);

/**
 * True for the phases that park a task on a human decision *and* are pushed.
 * `awaiting-feature-merge` is intentionally false — use
 * {@link isOpenPrAttention} for the opt-in extension.
 */
export function isAttentionPhase(phase: string | undefined): boolean {
  return phase !== undefined && ATTENTION_PHASE_SET.has(phase);
}

/**
 * True when an `awaiting-feature-merge` task has an open PR that only a human
 * can merge (pr-mode integration). A task with no PR number (auto/manual merge)
 * or one already merged is excluded.
 */
export function isOpenPrAttention(task: AttentionSourceTask): boolean {
  if (task.status?.phase !== OPEN_PR_PHASE) return false;
  const worker = task.status.worker;
  return worker?.prNumber !== undefined && worker.mergedAt === undefined;
}

/** Task status plus the board's computed worker-run message, when present. */
type TaskStatusWithRunMessage = NonNullable<Task['status']> & { workerRunMessage?: string };

/**
 * The task shape the inbox reads.
 *
 * The board route enriches each task with the worker run's message at the top
 * level (`workerRunMessage`), not under `status`; accept it in both places so
 * this pure filter works against either the raw CR or a board-enriched task.
 */
export type AttentionSourceTask = Omit<Task, 'status'> & {
  status?: TaskStatusWithRunMessage;
  workerRunMessage?: string;
};

/** Lookup of run name → Run phase, either as a Map or a plain record. */
export type RunPhaseLookup =
  | ReadonlyMap<string, string | undefined>
  | Readonly<Record<string, string | undefined>>;

function runPhaseOf(
  lookup: RunPhaseLookup | undefined,
  runName: string | undefined,
): string | undefined {
  if (!lookup || !runName) return undefined;
  const maybeMap = lookup as { get?: (key: string) => string | undefined };
  if (typeof maybeMap.get === 'function') return maybeMap.get(runName);
  return (lookup as Readonly<Record<string, string | undefined>>)[runName];
}

/** Human-readable reason this task is waiting on someone. */
export function attentionReason(task: AttentionSourceTask): string {
  const phase = task.status?.phase;
  if (phase === 'waiting-for-input') return 'Answer agent question';
  if (phase === 'awaiting-human') {
    return task.spec.type === 'PLAN' ? 'Review plan and approve' : 'Review and approve';
  }
  if (phase === 'failed') return 'Failed — retry or abandon';
  if (phase === OPEN_PR_PHASE) {
    const prNumber = task.status?.worker?.prNumber;
    return prNumber !== undefined ? `Merge PR #${prNumber} on GitHub` : 'Merge feature branch';
  }
  return 'Needs attention';
}

/**
 * Best-effort detail line for the inbox. Never throws: the Task CR is not
 * guaranteed to carry any of these fields (and merged/failed variants differ),
 * so a missing or malformed shape simply yields `undefined`.
 */
export function attentionDetail(task: AttentionSourceTask): string | undefined {
  try {
    const phase = task.status?.phase;
    if (phase === 'waiting-for-input') {
      // The board computes this at the top level; keep a `status` fallback for
      // callers that pass status-shaped fixtures.
      return task.status?.workerRunMessage ?? task.workerRunMessage;
    }
    if (phase === 'failed') {
      return task.status?.lastFailureReason ?? task.status?.worker?.mergeError;
    }
    if (phase === OPEN_PR_PHASE) {
      // The merge run records why a previous push/merge attempt failed; surface
      // it so the operator knows GitHub is blocked on something specific.
      return task.status?.worker?.mergeError;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** When the task first started waiting — newest fallback wins. */
export function attentionSince(task: AttentionSourceTask): string | undefined {
  const worker = task.status?.worker;
  return worker?.completedAt ?? worker?.startedAt ?? task.metadata?.creationTimestamp;
}

export interface AttentionItem {
  project: string;
  taskName: string;
  title: string;
  /** PLAN vs BUILD — drives the row's type icon on the client. */
  type: TaskType;
  /** Agent the task is assigned to, shown on the row. */
  agent: string;
  phase: AttentionItemPhase;
  reason: string;
  detail?: string;
  /**
   * Worker run backing this task, when it has one. The client's inline answer
   * action forwards the human's reply into this run's session (`replyToRun`)
   * before writing the answer annotation, so the parked agent actually sees it.
   */
  workerRunName?: string;
  since: string;
  url: string;
}

/**
 * Board parity: a run can be `WaitingForInput` while the Task phase is still
 * `running` during reconciler lag. Treat such a task as `waiting-for-input` so
 * the inbox surfaces it instead of dropping it.
 */
function withEffectivePhase(
  task: AttentionSourceTask,
  lookup: RunPhaseLookup | undefined,
): AttentionSourceTask {
  if (task.status?.phase !== 'running') return task;
  const runName = task.status.worker?.runName;
  if (runPhaseOf(lookup, runName) !== 'WaitingForInput') return task;
  return {
    ...task,
    status: { ...(task.status ?? {}), phase: 'waiting-for-input' },
  };
}

/**
 * Select and map the tasks that need a human, oldest-waiting first.
 *
 * `runPhaseByRun` is optional; pass the namespace's run phases to match the
 * board's `workerRunPhase` treatment of `WaitingForInput` runs.
 */
export function collectAttention(
  tasks: readonly AttentionSourceTask[],
  runPhaseByRun?: RunPhaseLookup,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const raw of tasks) {
    const task = withEffectivePhase(raw, runPhaseByRun);
    const phase = task.status?.phase;
    // Core push-parity gates, plus the opt-in open-PR extension (which push
    // deliberately does not cover — hence the differing count).
    if (!isAttentionPhase(phase) && !isOpenPrAttention(task)) continue;

    const project = task.spec.projectRef;
    const taskName = task.metadata.name;
    const detail = attentionDetail(task);
    const workerRunName = task.status?.worker?.runName;
    items.push({
      project,
      taskName,
      title: task.spec.title || taskName,
      type: task.spec.type,
      agent: task.spec.agent,
      phase: phase as AttentionItemPhase,
      reason: attentionReason(task),
      ...(detail !== undefined ? { detail } : {}),
      ...(workerRunName !== undefined ? { workerRunName } : {}),
      since: attentionSince(task) ?? '',
      // Identical shape to the push deep link so a click lands on the same task.
      url: `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(taskName)}`,
    });
  }

  items.sort((a, b) => {
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    if (a.taskName !== b.taskName) return a.taskName < b.taskName ? -1 : 1;
    return 0;
  });

  return items;
}
