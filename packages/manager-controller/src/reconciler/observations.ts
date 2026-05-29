// Observations — normalize K8s resources into ReconcileInput.

import type { Task, Project, Run } from "@percussionist/api";
import { getRun } from "@percussionist/kube";
import type { ReconcileInput, ObservedRuns, ManualActions } from "./decision.js";
import { resolveFlow } from "./flow.js";
import { isActivePhase } from "./scheduler.js";

// Annotation keys for manual actions (Task annotations — new).
const TASK_ANNOTATION_KEYS = {
  approved: "percussionist.dev/action-approved",
  requestChanges: "percussionist.dev/action-request-changes",
  reworkFeedback: "percussionist.dev/action-rework-feedback",
  abandon: "percussionist.dev/action-abandon",
  answer: "percussionist.dev/action-answer",
} as const;

// Annotation keys for manual actions (Project annotations — legacy fallback).
const PROJECT_ANNOTATION_KEYS = {
  approved: (taskName: string) => `percussionist.dev/approved-${taskName}`,
  requestChanges: (taskName: string) => `percussionist.dev/request-changes-${taskName}`,
  reworkFeedback: (taskName: string) => `percussionist.dev/rework-${taskName}`,
  abandon: (taskName: string) => `percussionist.dev/abandon-${taskName}`,
} as const;

// Review verdict annotation on the review Run.
const REVIEW_VERDICT_KEY = "percussionist.dev/review-verdict";

export async function observe(
  task: Task,
  project: Project,
  allTasks: Task[],
  namespace: string,
  activeCount: number,
  now?: string,
): Promise<ReconcileInput> {
  const taskName = task.metadata.name;
  const workerRunName = task.status?.worker?.runName;
  const reviewRunName = task.status?.worker?.reviewRunName;
  const mergeRunName = task.status?.worker?.mergeRunName;
  const buildgenRunName = task.status?.worker?.buildTasksFacilitatorRun;

  // Fetch observed runs in parallel.
  const [worker, review, merge, buildgen] = await Promise.all([
    workerRunName ? getRun(workerRunName, namespace).catch(() => undefined) : undefined,
    reviewRunName ? getRun(reviewRunName, namespace).catch(() => undefined) : undefined,
    mergeRunName ? getRun(mergeRunName, namespace).catch(() => undefined) : undefined,
    buildgenRunName ? getRun(buildgenRunName, namespace).catch(() => undefined) : undefined,
  ]);

  const observed: ObservedRuns = { worker, review, merge, buildgen };

  // Normalize manual actions from annotations.
  const manualActions = normalizeManualActions(task, project, taskName);

  const flow = resolveFlow(project);
  const maxParallel = project.spec.maxParallel ?? 2;

  return {
    task,
    project,
    allTasks,
    observed,
    manualActions,
    flow,
    capacity: { activeCount, maxParallel },
    now: now ?? new Date().toISOString(),
  };
}

function normalizeManualActions(
  task: Task,
  project: Project,
  taskName: string,
): ManualActions {
  const taskAnnotations = task.metadata.annotations ?? {};
  const projectAnnotations = project.metadata.annotations ?? {};

  // Read from Task annotations first (new), then Project annotations (legacy fallback).
  const approved =
    taskAnnotations[TASK_ANNOTATION_KEYS.approved] === "true" ||
    projectAnnotations[PROJECT_ANNOTATION_KEYS.approved(taskName)] === "true";

  const requestChanges =
    taskAnnotations[TASK_ANNOTATION_KEYS.requestChanges] === "true" ||
    projectAnnotations[PROJECT_ANNOTATION_KEYS.requestChanges(taskName)] === "true";

  const reworkFeedback =
    taskAnnotations[TASK_ANNOTATION_KEYS.reworkFeedback] ||
    projectAnnotations[PROJECT_ANNOTATION_KEYS.reworkFeedback(taskName)];

  const abandon =
    taskAnnotations[TASK_ANNOTATION_KEYS.abandon] === "true" ||
    projectAnnotations[PROJECT_ANNOTATION_KEYS.abandon(taskName)] === "true";

  const answer = taskAnnotations[TASK_ANNOTATION_KEYS.answer];

  return {
    approved: approved || undefined,
    requestChanges: requestChanges || undefined,
    reworkFeedback: reworkFeedback || undefined,
    abandon: abandon || undefined,
    answer: answer || undefined,
  };
}

export function getConsumedAnnotationKeys(taskName: string, actions: ManualActions): string[] {
  const keys: string[] = [];
  if (actions.approved) {
    keys.push(TASK_ANNOTATION_KEYS.approved);
    keys.push(PROJECT_ANNOTATION_KEYS.approved(taskName));
  }
  if (actions.requestChanges) {
    keys.push(TASK_ANNOTATION_KEYS.requestChanges);
    keys.push(PROJECT_ANNOTATION_KEYS.requestChanges(taskName));
    keys.push(TASK_ANNOTATION_KEYS.reworkFeedback);
    keys.push(PROJECT_ANNOTATION_KEYS.reworkFeedback(taskName));
  }
  if (actions.abandon) {
    keys.push(TASK_ANNOTATION_KEYS.abandon);
    keys.push(PROJECT_ANNOTATION_KEYS.abandon(taskName));
  }
  if (actions.answer) {
    keys.push(TASK_ANNOTATION_KEYS.answer);
  }
  return keys;
}

export function getReviewVerdict(run: Run | undefined): { action: string; feedback?: string } | undefined {
  if (!run) return undefined;
  const verdict = run.metadata.annotations?.[REVIEW_VERDICT_KEY];
  if (!verdict) return undefined;
  try {
    return JSON.parse(verdict) as { action: string; feedback?: string };
  } catch {
    return undefined;
  }
}
