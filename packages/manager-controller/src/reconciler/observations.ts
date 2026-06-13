// Observations — normalize K8s resources into ReconcileInput.

import type { Task, Project, Run, NormalizedReviewVerdict } from "@percussionist/api";
import { normalizeReviewVerdict } from "@percussionist/api";
import { getRun } from "@percussionist/kube";
import type { ReconcileInput, ObservedRuns, ManualActions } from "./decision.js";
import { resolveFlow } from "./flow.js";
import { isKubeNotFoundError } from "../kube-errors.js";

const TASK_ANNOTATION_KEYS = {
  approved: "percussionist.dev/action-approved",
  requestChanges: "percussionist.dev/action-request-changes",
  reworkFeedback: "percussionist.dev/action-rework-feedback",
  abandon: "percussionist.dev/action-abandon",
  answer: "percussionist.dev/action-answer",
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
  const workerRunName = task.status?.worker?.runName;
  const reviewRunName = task.status?.worker?.reviewRunName;
  const mergeRunName = task.status?.worker?.mergeRunName;
  const buildgenRunName = task.status?.worker?.buildTasksFacilitatorRun;

  // Fetch observed runs in parallel.
  // Distinguish 404 (run legitimately gone) from transient errors
  // (network blip, API server 503) — the latter should propagate so the
  // reconciler retries instead of incorrectly flipping the task to failed.
  const maybeRun = async (name: string) => getRun(name, namespace).catch((err: unknown) => {
    if (isKubeNotFoundError(err)) return undefined;
    throw err;
  });
  const [worker, review, merge, buildgen] = await Promise.all([
    workerRunName ? maybeRun(workerRunName) : undefined,
    reviewRunName ? maybeRun(reviewRunName) : undefined,
    mergeRunName ? maybeRun(mergeRunName) : undefined,
    buildgenRunName ? maybeRun(buildgenRunName) : undefined,
  ]);

  const observed: ObservedRuns = { worker, review, merge, buildgen };

  // Normalize manual actions from annotations.
  const manualActions = normalizeManualActions(task);

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
): ManualActions {
  const taskAnnotations = task.metadata.annotations ?? {};

  return {
    approved: taskAnnotations[TASK_ANNOTATION_KEYS.approved] === "true" || undefined,
    requestChanges: taskAnnotations[TASK_ANNOTATION_KEYS.requestChanges] === "true" || undefined,
    reworkFeedback: taskAnnotations[TASK_ANNOTATION_KEYS.reworkFeedback] || undefined,
    abandon: taskAnnotations[TASK_ANNOTATION_KEYS.abandon] === "true" || undefined,
    answer: taskAnnotations[TASK_ANNOTATION_KEYS.answer] || undefined,
  };
}

export function getConsumedAnnotationKeys(actions: ManualActions): string[] {
  const keys: string[] = [];
  if (actions.approved) {
    keys.push(TASK_ANNOTATION_KEYS.approved);
  }
  if (actions.requestChanges) {
    keys.push(TASK_ANNOTATION_KEYS.requestChanges);
    keys.push(TASK_ANNOTATION_KEYS.reworkFeedback);
  }
  if (actions.abandon) {
    keys.push(TASK_ANNOTATION_KEYS.abandon);
  }
  if (actions.answer) {
    keys.push(TASK_ANNOTATION_KEYS.answer);
  }
  return keys;
}

export function getReviewVerdict(run: Run | undefined): NormalizedReviewVerdict | undefined {
  if (!run) return undefined;
  const verdict = run.metadata.annotations?.[REVIEW_VERDICT_KEY];
  if (!verdict) return undefined;
  try {
    const parsed = JSON.parse(verdict) as unknown;
    return normalizeReviewVerdict(parsed, {
      sourceRunName: run.metadata.name,
      updatedAt: run.status?.completedAt ?? new Date().toISOString(),
    });
  } catch {
    return undefined;
  }
}
