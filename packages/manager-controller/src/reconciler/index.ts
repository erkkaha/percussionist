// Manager reconciler — phase-driven architecture.

import type { Project, Task, Run } from "@percussionist/api";
import { listTasks, getRun, patchTaskStatus } from "@percussionist/kube";
import type { PhaseContext } from "./types.js";
import { resolveConfig } from "./config-resolver.js";
import { byPriority } from "./scheduler.js";
import { handlers } from "./handlers/index.js";
import { applyTransition } from "./transitions.js";

// Reconcile a single project's tasks.
export async function reconcileProject(
  project: Project,
  namespace: string,
): Promise<void> {
  const projectName = project.metadata.name;
  console.log(`[reconcile] ${projectName} starting`);

  // Fetch all tasks for this project.
  const tasks = await listTasks(projectName, namespace);

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
      throw e;
    }
  }

  console.log(`[reconcile] ${projectName} complete`);
}
