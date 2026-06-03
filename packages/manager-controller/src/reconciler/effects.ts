// Effect types and executor — applies reconciler decisions to Kubernetes.

import type { Task, TaskPhase, Run } from "@percussionist/api";
import type { AuditEvent } from "./decision.js";
import type { ResolvedFlow } from "./flow.js";
import { validateTransition } from "./transitions.js";
import { createRun, deleteRun, patchTaskStatus, getTask, patchTask, createTask, getRun, getProject, patchProject } from "@percussionist/kube";
import { buildWorkerRun, buildMergeRun, auxiliaryRunName } from "../worker-builder.js";
import { persistEvent } from "./audit.js";

export type ReconcileEffect =
  | { type: "ScheduleRun"; runName: string; retryCount: number; reworkFeedback?: string }
  | { type: "ScheduleReviewRun"; reviewRunName: string; succeededRunName: string; reviewAgent: string }
  | { type: "ScheduleBuildGenRun"; buildgenRunName: string; succeededRunName: string }
  | { type: "ScheduleMergeRun"; mergeRunName: string }
  | { type: "CreateRun"; run: Run }
  | { type: "DeleteRun"; name: string; reason: string }
  | { type: "PatchTaskStatus"; patch: Record<string, unknown> }
  | { type: "CreateTask"; task: Task }
  | { type: "ClearTaskAnnotations"; keys: string[] }
  | { type: "ClearProjectAnnotations"; keys: string[] }
  | { type: "CleanupWorktree"; runName: string }
  | { type: "SummarizeSession"; project: string; runName: string; sessionID: string };

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
  project: Task["metadata"] & { spec: Record<string, unknown> } | null,
  flow: ResolvedFlow,
  allTasks: Task[],
): Promise<ExecutionResult> {
  const taskName = task.metadata.name;
  const fromPhase = (task.status?.phase ?? "pending") as TaskPhase;
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

  const currentPhase = (currentTask.status?.phase ?? "pending") as TaskPhase;

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
        case "ScheduleRun": {
          // Resolve the ScheduleRun effect into an actual Run and create it.
          if (!project) {
            throw new Error("Project metadata required for ScheduleRun effect");
          }
          const fullProject = project as unknown as import("@percussionist/api").Project;
          const run = await buildWorkerRun(
            fullProject,
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
        case "ScheduleReviewRun": {
          // Resolve the ScheduleReviewRun effect into an actual Run and create it.
          if (!project) {
            throw new Error("Project metadata required for ScheduleReviewRun effect");
          }
          const fullProject = project as unknown as import("@percussionist/api").Project;
          const succeededRun = await getRun(effect.succeededRunName, namespace).catch(() => undefined);
          const succeededStatus = succeededRun?.status ?? {};
          const branchName = task.status?.worker?.gitBranch;

          const { buildReviewRun } = await import("../facilitator.js");
          const reviewRun = buildReviewRun(
            fullProject,
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
        case "ScheduleBuildGenRun": {
          if (!project) {
            throw new Error("Project metadata required for ScheduleBuildGenRun effect");
          }
          const fullProject = project as unknown as import("@percussionist/api").Project;
          const succeededRun = await getRun(effect.succeededRunName, namespace).catch(() => undefined);
          const succeededStatus = succeededRun?.status ?? {};

          const { buildBuildTaskGeneratorRun } = await import("../facilitator.js");
          const buildgenRun = await buildBuildTaskGeneratorRun(
            fullProject,
            task,
            effect.succeededRunName,
            effect.buildgenRunName,
            "",
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
            if (existing?.status?.phase === "Failed" || existing?.status?.phase === "Cancelled") {
              await deleteRun(effect.buildgenRunName, namespace);
              await createRun(buildgenRun, namespace);
            }
          }
          break;
        }
        case "ScheduleMergeRun": {
          if (!project) {
            throw new Error("Project metadata required for ScheduleMergeRun effect");
          }
          const fullProject = project as unknown as import("@percussionist/api").Project;
          const mergeRun = await buildMergeRun(
            fullProject,
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
          }
          break;
        }
        case "CreateRun": {
          try {
            await createRun(effect.run, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
          }
          break;
        }
        case "DeleteRun": {
          try {
            await deleteRun(effect.name, namespace);
          } catch (e: unknown) {
            if (!isNotFound(e)) throw e;
          }
          break;
        }
        case "ClearTaskAnnotations": {
          try {
            const taskPatch: Record<string, string | null> = {};
            const projectKeys: string[] = [];
            for (const key of effect.keys) {
              if (key.startsWith("percussionist.dev/action-")) {
                taskPatch[key] = null;
              } else {
                projectKeys.push(key);
              }
            }
            const taskKeys = Object.keys(taskPatch);
            if (taskKeys.length > 0) {
              await patchTask(taskName, {
                metadata: { name: taskName, annotations: taskPatch as Record<string, string> },
              }, namespace);
            }
            if (projectKeys.length > 0) {
              await clearProjectAnnotations(projectKeys, project, namespace, taskName);
            }
          } catch (e) {
            console.warn(`[effects] ClearTaskAnnotations failed for ${taskName}:`, (e as Error).message);
          }
          break;
        }
        case "ClearProjectAnnotations": {
          await clearProjectAnnotations(effect.keys, project, namespace, taskName);
          break;
        }
        case "CleanupWorktree": {
          // Best-effort.
          console.log(`[effects] CleanupWorktree ${effect.runName} (best-effort)`);
          break;
        }
        case "SummarizeSession": {
          // Fire-and-forget — never blocks the reconcile cycle.
          import("../session-summarizer.js").then(({ summarizeSession }) => {
            summarizeSession(effect.project, effect.runName, effect.sessionID, namespace);
          }).catch(() => {});
          break;
        }
        case "CreateTask": {
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
    const patch: Record<string, unknown> = {
      ...statusPatch,
      phase: toPhase ?? currentPhase,
    };
    await patchTaskStatus(taskName, patch as never, namespace);
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
    typeof e === "object" &&
    e !== null &&
    "statusCode" in e &&
    (e as { statusCode?: number }).statusCode === 409
  );
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "statusCode" in e &&
    (e as { statusCode?: number }).statusCode === 404
  );
}

async function clearProjectAnnotations(
  keys: string[],
  projectObj: Task["metadata"] & { spec: Record<string, unknown> } | null,
  namespace: string,
  taskName: string,
): Promise<void> {
  try {
    const projectName = (projectObj as { metadata?: { name?: string } } | null)?.metadata?.name;
    if (!projectName) {
      console.warn(`[effects] ClearProjectAnnotations: no project name for ${taskName}`);
      return;
    }
    const patch: Record<string, string | null> = {};
    for (const key of keys) {
      patch[key] = null;
    }
    await patchProject(projectName, {
      metadata: { name: projectName, annotations: patch as Record<string, string> },
    }, namespace);
  } catch (e) {
    console.warn(`[effects] ClearProjectAnnotations failed for ${taskName}:`, (e as Error).message);
  }
}
