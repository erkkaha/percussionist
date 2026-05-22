// Manager reconciler — phase-driven architecture.

import type { Project, Task, Run, TaskPhase } from "@percussionist/api";
import { listTasks, getRun, patchTaskStatus } from "@percussionist/kube";
import type { PhaseContext } from "./types.js";
import { resolveConfig } from "./config-resolver.js";
import { byPriority } from "./scheduler.js";
import { handlers } from "./handlers/index.js";
import { applyTransition } from "./transitions.js";

// Backfill old tasks with phase from legacy column field.
function backfillPhase(task: Task): TaskPhase {
  const column = task.status?.column;
  const worker = task.status?.worker;

  switch (column) {
    case "backlog":
    case "ready":
      return "pending";
    case "in-progress":
      if (!worker?.runName) return "scheduled";
      return "running";
    case "review":
      if (worker?.status === "Failed") return "failed";
      return "awaiting-human";
    case "rework":
      return "rework-requested";
    case "done":
      return "done";
    case "blocked":
      return "pending"; // + blocked flag set separately
    default:
      return "pending";
  }
}

// Reconcile a single project's tasks.
export async function reconcileProject(
  project: Project,
  namespace: string,
): Promise<void> {
  const projectName = project.metadata.name;
  console.log(`[reconcile] ${projectName} starting`);

  // Fetch all tasks for this project.
  const tasks = await listTasks(projectName, namespace);

  // Backfill phase for tasks that don't have one yet.
  for (const task of tasks) {
    if (!task.status?.phase) {
      const phase = backfillPhase(task);
      await patchTaskStatus(task.metadata.name, { phase }, namespace);
      task.status = task.status ?? {};
      task.status.phase = phase;
      console.log(`[reconcile] ${task.metadata.name} backfilled phase: ${phase}`);
    }

    // Backfill blocked flag from legacy column.
    if (task.status?.column === "blocked" && !task.status?.blocked) {
      await patchTaskStatus(task.metadata.name, { blocked: true }, namespace);
      task.status.blocked = true;
      console.log(`[reconcile] ${task.metadata.name} backfilled blocked: true`);
    }
  }

  // Filter to active tasks (not idea or done).
  const activeTasks = tasks.filter((t) => {
    const phase = t.status?.phase;
    return phase !== "idea" && phase !== "done";
  });

  // Sort by priority for fairness.
  activeTasks.sort(byPriority);

  // Reconcile each active task.
  for (const task of activeTasks) {
    if (task.status?.blocked) {
      continue; // Skip blocked tasks.
    }

    const phase = task.status?.phase ?? "pending";
    const handler = handlers[phase];
    if (!handler) {
      continue; // No handler for this phase (terminal or invalid).
    }

    try {
      // Build context.
      const ctx: PhaseContext = {
        task,
        project,
        allTasks: tasks,
        run: task.status?.worker?.runName
          ? await getRun(task.status.worker.runName, namespace).catch(() => undefined)
          : undefined,
        config: resolveConfig(project, task),
        namespace,
      };

      // Invoke handler.
      const transition = await handler(ctx);
      if (transition) {
        console.log(
          `[reconcile] ${task.metadata.name} transitioning: ${phase} → ${transition.targetPhase}`,
        );
        await applyTransition(task, transition, namespace, projectName);
      }
    } catch (e) {
      console.error(`[reconcile] ${task.metadata.name} handler error:`, e);
    }
  }

  console.log(`[reconcile] ${projectName} complete`);
}
