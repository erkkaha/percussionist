// Transition application — idempotent side effect execution.

import type { Task, TaskPhase, Project } from "@percussionist/api";
import type { Transition } from "./types.js";
import { createRun, deleteRun } from "@percussionist/kube";
import { patchTaskStatus, patchProject, getProject, getTask, patchTask } from "@percussionist/kube";
import { createTask } from "@percussionist/kube";

// Apply a transition: side effects first (idempotent), then phase patch.
export async function applyTransition(
  task: Task,
  transition: Transition,
  namespace: string,
  projectName?: string,
): Promise<void> {
  const taskName = task.metadata.name;

  // Side effects — idempotent operations.
  for (const effect of transition.sideEffects) {
    try {
      switch (effect.type) {
        case "createRun": {
          try {
            await createRun(effect.run, namespace);
          } catch (e: unknown) {
            const msg = (e as Error).message;
            if (!/already exists/i.test(msg)) throw e;
            // Already exists — idempotent (or replace if terminal).
          }
          break;
        }
        case "deleteRun": {
          try {
            await deleteRun(effect.name, namespace);
          } catch (e: unknown) {
            if (!isNotFound(e)) throw e;
            // Already deleted — idempotent.
          }
          break;
        }
        case "patchWorker": {
          // Merge patch with existing worker state to avoid destroying fields.
          // Keys explicitly set to undefined in the patch are set to null in the
          // JSON body so the merge patch removes them from the stored object.
          const currentWorker = task.status?.worker ?? {};
          const mergedWorker = { ...currentWorker, ...effect.patch } as Record<string, unknown>;
          for (const key of Object.keys(effect.patch as Record<string, unknown>)) {
            if ((effect.patch as Record<string, unknown>)[key] === undefined) {
              mergedWorker[key] = null; // null in merge-patch removes the field
            }
          }
          await patchTaskStatus(taskName, { worker: mergedWorker as never }, namespace);
          break;
        }
        case "cleanupWorktree": {
          // Best-effort cleanup — errors are logged but don't block transition.
          try {
            // TODO: implement worktree cleanup (delete /data/worktrees/{runName}).
            console.log(`[cleanupWorktree] ${effect.runName} (best-effort, not blocking)`);
          } catch (e) {
            console.warn(`[cleanupWorktree] ${effect.runName} failed:`, e);
          }
          break;
        }
        case "emitEvent": {
          // TODO: emit K8s event for the task.
          console.log(`[event] ${taskName}: ${effect.event.reason} - ${effect.event.message}`);
          break;
        }
        case "createTasks": {
          for (const t of effect.tasks) {
            try {
              await createTask(t, namespace);
            } catch (e: unknown) {
              if (!isAlreadyExists(e)) throw e;
              // Already exists — idempotent.
            }
          }
          break;
        }
        case "patchTaskStatus": {
          await patchTaskStatus(taskName, effect.patch as never, namespace);
          break;
        }
        case "clearProjectAnnotations": {
          if (!projectName) {
            console.warn(`[clearProjectAnnotations] No projectName provided, skipping`);
            break;
          }
          try {
            const project = await getProject(projectName, namespace);
            const currentAnnotations = project.metadata.annotations ?? {};
            const newAnnotations = { ...currentAnnotations };
            for (const key of effect.keys) {
              delete newAnnotations[key];
            }
            await patchProject(projectName, {
              metadata: { annotations: newAnnotations },
            }, namespace);
          } catch (e: unknown) {
            // Annotation clearing is best-effort — don't block transition.
            console.warn(`[clearProjectAnnotations] Failed to clear annotations:`, e);
          }
          break;
        }
        case "clearTaskAnnotations": {
          try {
            const currentTask = await getTask(taskName, namespace);
            const currentAnnotations = currentTask.metadata.annotations ?? {};
            const newAnnotations = { ...currentAnnotations };
            for (const key of effect.keys) {
              delete newAnnotations[key];
            }
            await patchTask(taskName, {
              metadata: {
                ...currentTask.metadata,
                annotations: newAnnotations,
              },
            }, namespace);
          } catch (e: unknown) {
            // Annotation clearing is best-effort — don't block transition.
            console.warn(`[clearTaskAnnotations] Failed to clear annotations:`, e);
          }
          break;
        }
      }
    } catch (e) {
      console.error(`[applyTransition] ${taskName} side effect failed:`, effect, e);
      throw e;
    }
  }

  // Phase patch — authoritative state change.
  await patchTaskStatus(taskName, { phase: transition.targetPhase }, namespace);
}

// Helper: check if error is AlreadyExists (409).
function isAlreadyExists(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    ("statusCode" in e && (e as { statusCode?: number }).statusCode === 409)
  );
}

// Helper: check if error is NotFound (404).
function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    ("statusCode" in e && (e as { statusCode?: number }).statusCode === 404)
  );
}
