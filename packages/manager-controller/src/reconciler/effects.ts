// Effect types and executor — applies reconciler decisions to Kubernetes.

import type { Project, Run, Task, TaskPhase } from '@percussionist/api';
import { LABELS } from '@percussionist/api';
import {
  createRun,
  createTask,
  deleteRun,
  fetchSessionMessages,
  getRun,
  getTask,
  listRuns,
  patchProject,
  patchTask,
  patchTaskStatus,
  postSessionMessage,
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
  | { type: 'SummarizeSession'; project: string; runName: string; sessionID: string }
  | { type: 'DeliverAnswer'; runName: string; text: string };

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

  // Deferred annotation-clear effects: consumed only AFTER a successful status
  // patch so a failed/conflicted status write never deletes a human's intent
  // (approve/abandon/answer). See the deferred section below the status patch.
  const deferredClears: Extract<ReconcileEffect, { type: 'ClearTaskAnnotations' }>[] = [];

  // Apply effects.
  for (const effect of effects) {
    try {
      // Defer ClearTaskAnnotations — it must run only after the guarded status
      // write so a conflicting/aborted status patch keeps the annotation intact.
      // All other effect types run exactly as before.
      if (effect.type === 'ClearTaskAnnotations') {
        deferredClears.push(effect);
        continue;
      }
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
          if (toPhase === 'done') {
            // The task-level cleanup pod spawned on the "done" transition
            // removes every run worktree of the task, including this one.
            // Spawning both makes the two pods race rm -rf on the same tree.
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
        case 'DeliverAnswer': {
          // Post a human answer into the run's live opencode session. Delivery
          // is NON-FATAL: a missing/unreachable run must not stall the
          // reconcile cycle — the dead-run exit in decideWaitingForInput fails
          // the task on the next cycle instead. Dedupe against the session tail
          // so the common UI path (client already posted via /reply before
          // writing the annotation) does not deliver twice.
          try {
            const run = await getRun(effect.runName, namespace);
            const serviceName = run.status?.serviceName;
            const sessionID = run.status?.sessionID;
            if (!serviceName || !sessionID) {
              console.warn(
                `[effects] DeliverAnswer: run ${effect.runName} has no serviceName/sessionID, skipping`,
              );
              break;
            }
            const raw = await fetchSessionMessages(serviceName, sessionID, namespace);
            const messages = Array.isArray(raw) ? raw : [];
            const answer = effect.text.trim();
            // Walk backwards for the last user message; its combined text is
            // compared trimmed so minor whitespace drift cannot defeat the dedupe.
            let alreadyDelivered = false;
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i] as {
                info?: { role?: string };
                parts?: Array<{ type?: string; text?: string }>;
              };
              if (m?.info?.role !== 'user') continue;
              const text = (m.parts ?? [])
                .filter((p) => p?.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text as string)
                .join('')
                .trim();
              alreadyDelivered = text === answer;
              break;
            }
            if (alreadyDelivered) {
              console.log(
                `[effects] DeliverAnswer: answer already in session tail for ${effect.runName}, skipping`,
              );
              break;
            }
            await postSessionMessage(serviceName, sessionID, effect.text, namespace);
            console.log(
              `[effects] DeliverAnswer: posted answer to ${effect.runName} (session ${sessionID})`,
            );
          } catch (e) {
            console.warn(
              `[effects] DeliverAnswer failed for ${effect.runName}:`,
              (e as Error).message,
            );
          }
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
  // Captures the updated task so we can pass its resourceVersion into the
  // deferred annotation-clear below (making that write conditional on the one
  // we just made, avoiding a spurious self-409).
  let patched: Task | undefined;
  if (toPhase || statusPatch) {
    // The phase guard above ran before the effects, which take seconds
    // (creating runs, spawning cleanup pods). An MCP tool or a human annotation
    // can move the task during that window, and this patch would silently
    // revert it. Re-read immediately before writing, and make the write
    // conditional on that read so anything landing in the remaining gap is a
    // conflict rather than a lost update.
    //
    // The re-read guards the phase and supplies the resource version for the
    // conditional status write. Annotation consumption (ClearTaskAnnotations)
    // is deferred until after this successful status write (see below), so a
    // failed/conflicted status patch never loses the human's intent.
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
      patched = await patchTaskStatus(
        taskName,
        patch,
        namespace,
        3,
        latest.metadata.resourceVersion,
      );
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

  // Deferred annotation clears: only reached when the function has NOT
  // early-returned, i.e. the status patch succeeded (or was skipped because
  // there was no toPhase/statusPatch). We pass the post-status resource version
  // so the annotation delete is conditional on the write we just made, avoiding
  // a spurious self-409. When the status patch was skipped, resourceVersion is
  // undefined and the helper calls patchTask without it (unchanged behavior).
  // Each cleared effect is reported exactly as the loop would have.
  for (const effect of deferredClears) {
    await applyClearTaskAnnotations(
      effect,
      taskName,
      project,
      namespace,
      patched?.metadata?.resourceVersion,
    );
    effectsApplied.push(effect.type);
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

/**
 * Consume (clear) a set of task annotation keys. `percussionist.dev/action-*`
 * keys are cleared on the Task CR via patchTask (metadata `annotations` set to
 * `null`); everything else is cleared on the Project via
 * clearProjectAnnotations. When `resourceVersion` is provided it is included in
 * the patchTask metadata so the clear is conditional on the status write that
 * preceded it. A failed annotation clear is non-fatal: it is logged and the
 * reconcile cycle continues, leaving the annotation as a harmless leftover
 * (the intent is preserved, merely not cleaned up).
 */
async function applyClearTaskAnnotations(
  effect: Extract<ReconcileEffect, { type: 'ClearTaskAnnotations' }>,
  taskName: string,
  projectObj: Project | null,
  namespace: string,
  resourceVersion?: string,
): Promise<void> {
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
      const metadata: {
        name: string;
        annotations: Record<string, string>;
        resourceVersion?: string;
      } = {
        name: taskName,
        annotations: taskPatch as Record<string, string>,
      };
      if (resourceVersion) {
        metadata.resourceVersion = resourceVersion;
      }
      await patchTask(taskName, { metadata }, namespace);
    }
    if (projectKeys.length > 0) {
      await clearProjectAnnotations(projectKeys, projectObj, namespace, taskName);
    }
  } catch (e) {
    console.warn(`[effects] ClearTaskAnnotations failed for ${taskName}:`, (e as Error).message);
  }
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
