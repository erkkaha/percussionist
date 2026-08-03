// Effect types and executor — applies reconciler decisions to Kubernetes.

import type { Project, Run, Task, TaskPhase } from '@percussionist/api';
import { LABELS } from '@percussionist/api';
import {
  createRun,
  createTask,
  deleteRun,
  getRun,
  getTask,
  listRuns,
  patchProject,
  patchTask,
  patchTaskStatus,
} from '@percussionist/kube';
import { isKubeConflictError, isKubeNotFoundError } from '../kube-errors.js';
import { buildMergeRun, buildPrOpenRun, buildWorkerRun } from '../worker-builder.js';
import type { AuditEvent } from './decision.js';
import type { ResolvedFlow } from './flow.js';
import { validateTransition } from './transitions.js';

export type ReconcileEffect =
  | { type: 'ScheduleRun'; runName: string; retryCount: number; reworkFeedback?: string }
  | {
      type: 'ScheduleReviewRun';
      reviewRunName: string;
      succeededRunName: string;
      reviewAgent: string;
    }
  | { type: 'ScheduleBuildGenRun'; buildgenRunName: string; succeededRunName: string }
  | { type: 'ScheduleMergeRun'; mergeRunName: string }
  | { type: 'SchedulePrOpenRun'; prOpenRunName: string }
  | { type: 'CreateRun'; run: Run }
  | { type: 'DeleteRun'; name: string; reason: string }
  | { type: 'PatchTaskStatus'; patch: Record<string, unknown> }
  | { type: 'CreateTask'; task: Task }
  | { type: 'ClearTaskAnnotations'; keys: string[] }
  | { type: 'ClearProjectAnnotations'; keys: string[] }
  | { type: 'CleanupWorktree'; runName: string }
  | { type: 'SummarizeSession'; project: string; runName: string; sessionID: string };

export interface ExecutionResult {
  applied: boolean;
  transition: { from: TaskPhase; to?: TaskPhase };
  effectsApplied: string[];
  events: AuditEvent[];
  error?: string;
}

export async function executeEffects(
  task: Task,
  toPhase: TaskPhase | undefined,
  effects: ReconcileEffect[],
  statusPatch: Record<string, unknown> | undefined,
  namespace: string,
  project: Project | null,
  flow: ResolvedFlow,
  allTasks: Task[],
): Promise<ExecutionResult> {
  const taskName = task.metadata.name;
  const fromPhase = (task.status?.phase ?? 'pending') as TaskPhase;
  const effectsApplied: string[] = [];

  // Re-fetch task to get current state.
  let currentTask: Task;
  try {
    currentTask = await getTask(taskName, namespace);
  } catch {
    return {
      applied: false,
      transition: { from: fromPhase, to: toPhase },
      effectsApplied: [],
      events: [],
      error: `Task ${taskName} not found during execution`,
    };
  }

  const currentPhase = (currentTask.status?.phase ?? 'pending') as TaskPhase;

  // Verify source phase hasn't changed.
  if (currentPhase !== fromPhase) {
    return {
      applied: false,
      transition: { from: fromPhase, to: toPhase },
      effectsApplied: [],
      events: [],
      error: `Task ${taskName} phase changed from ${fromPhase} to ${currentPhase} since decision`,
    };
  }

  // Validate transition.
  if (toPhase) {
    const validationError = validateTransition(fromPhase, toPhase);
    if (validationError) {
      return {
        applied: false,
        transition: { from: fromPhase, to: toPhase },
        effectsApplied: [],
        events: [],
        error: validationError,
      };
    }
  }

  // Apply effects.
  for (const effect of effects) {
    try {
      switch (effect.type) {
        case 'ScheduleRun': {
          // Resolve the ScheduleRun effect into an actual Run and create it.
          if (!project) {
            throw new Error('Project metadata required for ScheduleRun effect');
          }
          const run = await buildWorkerRun(
            project,
            task,
            effect.runName,
            effect.retryCount,
            effect.reworkFeedback,
            allTasks,
          );
          try {
            await createRun(run, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
          }
          break;
        }
        case 'ScheduleReviewRun': {
          // Resolve the ScheduleReviewRun effect into an actual Run and create it.
          if (!project) {
            throw new Error('Project metadata required for ScheduleReviewRun effect');
          }
          const succeededRun = await getRun(effect.succeededRunName, namespace).catch(
            () => undefined,
          );
          const succeededStatus = succeededRun?.status ?? {};
          const branchName = task.status?.worker?.gitBranch;

          const { buildReviewRun } = await import('../facilitator.js');
          const reviewRun = await buildReviewRun(
            project,
            task,
            effect.succeededRunName,
            succeededStatus,
            effect.reviewRunName,
            branchName,
            effect.reviewAgent,
            allTasks,
          );
          try {
            await createRun(reviewRun, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
          }
          break;
        }
        case 'ScheduleBuildGenRun': {
          if (!project) {
            throw new Error('Project metadata required for ScheduleBuildGenRun effect');
          }
          const { buildBuildTaskGeneratorRun } = await import('../facilitator.js');
          const buildgenRun = await buildBuildTaskGeneratorRun(
            project,
            task,
            effect.succeededRunName,
            effect.buildgenRunName,
            '',
            flow.plan.buildGenerationAgent,
            allTasks,
            flow.build.defaultAgent,
          );
          try {
            await createRun(buildgenRun, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
            const existing = await getRun(effect.buildgenRunName, namespace).catch(() => undefined);
            if (existing?.status?.phase === 'Failed' || existing?.status?.phase === 'Cancelled') {
              await deleteRun(effect.buildgenRunName, namespace);
              await createRun(buildgenRun, namespace);
            }
          }
          break;
        }
        case 'ScheduleMergeRun': {
          if (!project) {
            throw new Error('Project metadata required for ScheduleMergeRun effect');
          }
          const mergeRun = await buildMergeRun(
            project,
            task,
            effect.mergeRunName,
            allTasks,
            flow.merge.agent,
          );
          try {
            await createRun(mergeRun, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
            // Merge run names are deterministic and merge retries do not bump
            // retryCount, so a retry regenerates the name of the previous
            // attempt. Unlike buildgen, a terminal leftover must be replaced
            // even when Succeeded: merge agents signal completion (phase
            // Succeeded) for failure verdicts too, and the stale verdict would
            // be re-observed as this attempt's outcome, wedging the task in a
            // retry loop. A Pending/Running run is adopted as-is.
            const existing = await getRun(effect.mergeRunName, namespace).catch(() => undefined);
            const phase = existing?.status?.phase;
            if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') {
              await deleteRun(effect.mergeRunName, namespace);
              await createRun(mergeRun, namespace);
            }
          }
          break;
        }
        case 'SchedulePrOpenRun': {
          if (!project) {
            throw new Error('Project metadata required for SchedulePrOpenRun effect');
          }
          const prRun = await buildPrOpenRun(
            project,
            task,
            effect.prOpenRunName,
            allTasks,
            flow.integration.agent,
          );
          try {
            await createRun(prRun, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
            // Same hazard as ScheduleMergeRun: the pr-open name is static per
            // task, so a retry collides with the previous attempt's run.
            const existing = await getRun(effect.prOpenRunName, namespace).catch(() => undefined);
            const phase = existing?.status?.phase;
            if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') {
              await deleteRun(effect.prOpenRunName, namespace);
              await createRun(prRun, namespace);
            }
          }
          break;
        }
        case 'CreateRun': {
          try {
            await createRun(effect.run, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
          }
          break;
        }
        case 'DeleteRun': {
          try {
            await deleteRun(effect.name, namespace);
          } catch (e: unknown) {
            if (!isKubeNotFoundError(e)) throw e;
          }
          break;
        }
        case 'ClearTaskAnnotations': {
          try {
            const taskPatch: Record<string, string | null> = {};
            const projectKeys: string[] = [];
            for (const key of effect.keys) {
              if (key.startsWith('percussionist.dev/action-')) {
                taskPatch[key] = null;
              } else {
                projectKeys.push(key);
              }
            }
            const taskKeys = Object.keys(taskPatch);
            if (taskKeys.length > 0) {
              await patchTask(
                taskName,
                {
                  metadata: { name: taskName, annotations: taskPatch as Record<string, string> },
                },
                namespace,
              );
            }
            if (projectKeys.length > 0) {
              await clearProjectAnnotations(projectKeys, project, namespace, taskName);
            }
          } catch (e) {
            console.warn(
              `[effects] ClearTaskAnnotations failed for ${taskName}:`,
              (e as Error).message,
            );
          }
          break;
        }
        case 'ClearProjectAnnotations': {
          await clearProjectAnnotations(effect.keys, project, namespace, taskName);
          break;
        }
        case 'CleanupWorktree': {
          if (!project) {
            console.warn(
              `[effects] CleanupWorktree: no project context for ${effect.runName}, skipping`,
            );
            break;
          }
          const projectName = project.metadata.name;
          const gitUrl = (project.spec.source as { git?: { url?: string } } | undefined)?.git?.url;
          const runnerImage = (project.spec.runner as { image?: string } | undefined)?.image;
          const image = runnerImage ?? project.spec.image ?? 'alpine/git';
          const { spawnWorktreeCleanupPod } = await import('../worktree-cleanup.js');
          spawnWorktreeCleanupPod({
            task: currentTask,
            runName: effect.runName,
            projectName,
            namespace,
            image,
            gitUrl,
          }).catch((e: Error) => console.warn(`[effects] CleanupWorktree pod failed:`, e.message));
          break;
        }
        case 'SummarizeSession': {
          // Fire-and-forget — never blocks the reconcile cycle.
          console.log(
            `[effects] SummarizeSession dispatch: project=${effect.project} runName=${effect.runName} sessionID=${effect.sessionID}`,
          );
          import('../session-summarizer.js')
            .then(({ summarizeSession }) => {
              summarizeSession(effect.project, effect.runName, effect.sessionID, namespace).catch(
                (e: Error) =>
                  console.warn(
                    `[effects] SummarizeSession failed: project=${effect.project} runName=${effect.runName} sessionID=${effect.sessionID}:`,
                    e.message,
                  ),
              );
            })
            .catch((e: Error) =>
              console.warn(
                `[effects] SummarizeSession import failed: project=${effect.project} runName=${effect.runName} sessionID=${effect.sessionID}:`,
                e.message,
              ),
            );
          break;
        }
        case 'CreateTask': {
          try {
            await createTask(effect.task, namespace);
          } catch (e: unknown) {
            if (!isAlreadyExists(e)) throw e;
          }
          break;
        }
      }
      effectsApplied.push(effect.type);
    } catch (e) {
      return {
        applied: false,
        transition: { from: fromPhase, to: toPhase },
        effectsApplied,
        events: [],
        error: `Effect ${effect.type} failed: ${(e as Error).message}`,
      };
    }
  }

  // Apply final status patch (phase + worker + other fields in one patch).
  if (toPhase || statusPatch) {
    // The phase guard above ran before the effects, which take seconds
    // (creating runs, spawning cleanup pods). An MCP tool or a human annotation
    // can move the task during that window, and this patch would silently
    // revert it. Re-read immediately before writing, and make the write
    // conditional on that read so anything landing in the remaining gap is a
    // conflict rather than a lost update.
    //
    // The re-read also picks up our own metadata writes from the effects above
    // (ClearTaskAnnotations), so those don't false-conflict.
    let latest: Task;
    try {
      latest = await getTask(taskName, namespace);
    } catch {
      return {
        applied: false,
        transition: { from: fromPhase, to: toPhase },
        effectsApplied,
        events: [],
        error: `Task ${taskName} not found when applying status`,
      };
    }

    const latestPhase = (latest.status?.phase ?? 'pending') as TaskPhase;
    if (latestPhase !== currentPhase) {
      return {
        applied: false,
        transition: { from: fromPhase, to: toPhase },
        effectsApplied,
        events: [],
        error: `Task ${taskName} moved to ${latestPhase} while effects were running; not overwriting with ${toPhase ?? currentPhase}`,
      };
    }

    const patch: Record<string, unknown> = {
      ...statusPatch,
      phase: toPhase ?? currentPhase,
    };
    try {
      await patchTaskStatus(taskName, patch, namespace, 3, latest.metadata.resourceVersion);
    } catch (e) {
      if (isKubeConflictError(e)) {
        return {
          applied: false,
          transition: { from: fromPhase, to: toPhase },
          effectsApplied,
          events: [],
          error: `Task ${taskName} changed concurrently while applying status; will re-reconcile`,
        };
      }
      throw e;
    }
  }

  // Task-level worktree cleanup, wired centrally rather than as a per-site
  // effect: on a transition to "done", clean up the worker worktree plus any
  // review/buildgen/merge auxiliary worktrees whose Run CRs still exist.
  // Fire-and-forget — never blocks the reconcile cycle.
  if (toPhase === 'done' && project) {
    const projectName = project.metadata.name;
    const gitUrl = (project.spec.source as { git?: { url?: string } } | undefined)?.git?.url;
    const runnerImage = (project.spec.runner as { image?: string } | undefined)?.image;
    const image = runnerImage ?? project.spec.image ?? 'alpine/git';
    (async () => {
      const runs = await listRuns(namespace, undefined, `${LABELS.taskId}=${taskName}`);
      const runNames = runs.map((r) => r.metadata.name);
      const { spawnTaskWorktreeCleanupPod } = await import('../worktree-cleanup.js');
      await spawnTaskWorktreeCleanupPod({
        task: currentTask,
        projectName,
        namespace,
        image,
        gitUrl,
        dataPvcName: project.spec.data?.pvcName,
        runNames,
      });
    })().catch((e: Error) =>
      console.warn(`[effects] task-done worktree cleanup failed for ${taskName}:`, e.message),
    );
  }

  return {
    applied: true,
    transition: { from: fromPhase, to: toPhase },
    effectsApplied,
    events: [],
  };
}

function isAlreadyExists(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'statusCode' in e &&
    (e as { statusCode?: number }).statusCode === 409
  );
}

async function clearProjectAnnotations(
  keys: string[],
  projectObj: Project | null,
  namespace: string,
  taskName: string,
): Promise<void> {
  try {
    const projectName = projectObj?.metadata?.name;
    if (!projectName) {
      console.warn(`[effects] ClearProjectAnnotations: no project name for ${taskName}`);
      return;
    }
    const patch: Record<string, string | null> = {};
    for (const key of keys) {
      patch[key] = null;
    }
    await patchProject(
      projectName,
      {
        metadata: { name: projectName, annotations: patch as Record<string, string> },
      },
      namespace,
    );
  } catch (e) {
    console.warn(`[effects] ClearProjectAnnotations failed for ${taskName}:`, (e as Error).message);
  }
}
