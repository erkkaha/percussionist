// Observations — normalize K8s resources into ReconcileInput.

import type {
  NormalizedMergeVerdict,
  NormalizedReviewVerdict,
  Project,
  Run,
  Task,
} from '@percussionist/api';
import {
  MERGE_VERDICT_ANNOTATION,
  normalizeMergeVerdict,
  normalizeReviewVerdict,
} from '@percussionist/api';
import { getRun } from '@percussionist/kube';
import { isKubeNotFoundError } from '../kube-errors.js';
import type { ManualActions, ObservedRuns, ReconcileInput } from './decision.js';
import { resolveFlow } from './flow.js';
import {
  getPrComments,
  getPrState,
  parseGitHubUrl,
  readProjectGithubToken,
} from './github-client.js';

const TASK_ANNOTATION_KEYS = {
  approved: 'percussionist.dev/action-approved',
  requestChanges: 'percussionist.dev/action-request-changes',
  reworkFeedback: 'percussionist.dev/action-rework-feedback',
  abandon: 'percussionist.dev/action-abandon',
  answer: 'percussionist.dev/action-answer',
} as const;

// Review verdict annotation on the review Run.
const REVIEW_VERDICT_KEY = 'percussionist.dev/review-verdict';

// Merge verdict annotation on merge Run.
const MERGE_VERDICT_KEY = MERGE_VERDICT_ANNOTATION;

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
  const prFeedbackRunName = task.status?.worker?.prFeedbackRunName;

  // Fetch observed runs in parallel.
  // Distinguish 404 (run legitimately gone) from transient errors
  // (network blip, API server 503) — the latter should propagate so the
  // reconciler retries instead of incorrectly flipping the task to failed.
  const maybeRun = async (name: string) =>
    getRun(name, namespace).catch((err: unknown) => {
      if (isKubeNotFoundError(err)) return undefined;
      throw err;
    });
  const [worker, review, merge, buildgen, prFeedbackRun] = await Promise.all([
    workerRunName ? maybeRun(workerRunName) : undefined,
    reviewRunName ? maybeRun(reviewRunName) : undefined,
    mergeRunName ? maybeRun(mergeRunName) : undefined,
    buildgenRunName ? maybeRun(buildgenRunName) : undefined,
    prFeedbackRunName ? maybeRun(prFeedbackRunName) : undefined,
  ]);

  const observed: ObservedRuns = { worker, review, merge, buildgen, prFeedbackRun };

  // PR-mode integration: when a PR has been opened (worker.prNumber set) and
  // the PR-open run has completed (no active mergeRunName), poll GitHub for the
  // PR state. The github-client caches per-PR for 15 min, so this is cheap
  // even though observe() runs every reconcile cycle.
  const prNumber = task.status?.worker?.prNumber;
  if (prNumber && !mergeRunName) {
    const gitUrl = project.spec.source?.git?.url;
    const parsed = gitUrl ? parseGitHubUrl(gitUrl) : undefined;
    if (parsed) {
      const token = await readProjectGithubToken(project);
      if (token) {
        const prState = await getPrState(parsed.owner, parsed.repo, prNumber, token);
        if (prState) observed.prState = prState;

        // Feedback detection: while the PR is open and no evaluation round is
        // in flight, surface human comments newer than the consumed watermark.
        // An unset watermark means the whole comment history is unevaluated
        // (PRs opened before this feature shipped) — evaluate all of it.
        if (prState?.state === 'open' && !prFeedbackRunName) {
          const watermark = task.status?.worker?.prFeedbackLastCommentAt;
          const comments = await getPrComments(
            parsed.owner,
            parsed.repo,
            prNumber,
            token,
            prState.authorLogin,
          );
          const fresh = (comments ?? []).filter((c) => !watermark || c.createdAt > watermark);
          if (fresh.length > 0) {
            const newest = fresh[fresh.length - 1];
            const first = fresh[0];
            observed.prFeedback = {
              count: fresh.length,
              newestCommentAt: newest?.createdAt ?? '',
              preview: first ? `${first.author}: ${first.body.slice(0, 160)}` : '',
            };
          }
        }
      }
    }
  }

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

function normalizeManualActions(task: Task): ManualActions {
  const taskAnnotations = task.metadata.annotations ?? {};

  return {
    approved: taskAnnotations[TASK_ANNOTATION_KEYS.approved] === 'true' || undefined,
    requestChanges: taskAnnotations[TASK_ANNOTATION_KEYS.requestChanges] === 'true' || undefined,
    reworkFeedback: taskAnnotations[TASK_ANNOTATION_KEYS.reworkFeedback] || undefined,
    abandon: taskAnnotations[TASK_ANNOTATION_KEYS.abandon] === 'true' || undefined,
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

export function getMergeVerdict(run: Run | undefined): NormalizedMergeVerdict | undefined {
  if (!run) return undefined;
  const verdict = run.metadata.annotations?.[MERGE_VERDICT_KEY];
  if (!verdict) return undefined;
  try {
    const parsed = JSON.parse(verdict) as unknown;
    return normalizeMergeVerdict(parsed);
  } catch {
    return undefined;
  }
}
