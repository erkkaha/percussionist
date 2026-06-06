// Manager reconciler — phase-driven architecture with pure decision engine.

import type { Project, Task, TaskPhase } from "@percussionist/api";
import { observe, getConsumedAnnotationKeys } from "./observations.js";
import { decide } from "./decision.js";
import { executeEffects } from "./effects.js";
import { persistEvent } from "./audit.js";
import { emitEvent } from "../events.js";
import { resolveFlow } from "./flow.js";
import { byPriority, isActivePhase } from "./scheduler.js";

// Reconcile a single project's tasks.
export async function reconcileProject(
  project: Project,
  namespace: string,
): Promise<void> {
  const projectName = project.metadata.name;
  console.log(`[reconcile] ${projectName} starting`);

  // Fetch all tasks for this project.
  const { listTasks, patchTaskStatus } = await import("@percussionist/kube");
  const tasks = await listTasks(projectName, namespace);

  // Auto-heal: detect tasks missing status.phase and repair them to pending.
  // This catches legacy/manual Task CRs that were created without a phase,
  // which would otherwise be invisible to scheduling logic.
  for (const task of tasks) {
    if (!task.status?.phase) {
      console.log(
        `[reconcile] ${task.metadata.name}: missing status.phase — healing to "pending"`,
      );
      await patchTaskStatus(task.metadata.name!, { phase: "pending" }, namespace).catch(() => {
        // Best-effort heal; reconciler will retry on next cycle.
      });
    }
  }

  // Re-fetch tasks after healing (to get fresh data with patched phases).
  const refreshedTasks = await listTasks(projectName, namespace);

  // Filter to active tasks (not idea or done).
  const activeTasks = refreshedTasks.filter((t) => {
    const phase = t.status?.phase;
    return phase !== "idea" && phase !== "done";
  });

  // Sort by priority for fairness.
  activeTasks.sort(byPriority);

  // Track active count across transitions in this cycle to respect maxParallel.
  let activeCount = refreshedTasks.filter((t) => isActivePhase(t.status?.phase ?? "pending")).length;

  // Reconcile each active task.
  for (const task of activeTasks) {
    if (task.status?.blocked) {
      continue; // Skip blocked tasks.
    }

    const phase = (task.status?.phase ?? "pending") as TaskPhase;
    const wasActive = isActivePhase(phase);

    try {
      // Observe: normalize K8s resources into decision input.
      const input = await observe(task, project, refreshedTasks, namespace, activeCount);

      // Decide: pure function returns next phase, effects, and audit events.
      const decision = decide(input);

      if (!decision.toPhase && !decision.effects.length && !decision.statusPatch) {
        // No decision — task stays in current phase with no side effects.
        continue;
      }

      if (decision.toPhase) {
        console.log(
          `[reconcile] ${task.metadata.name} transitioning: ${phase} → ${decision.toPhase}`,
        );
      }

      // Execute: apply effects and patch status.
      const result = await executeEffects(
        task,
        decision.toPhase,
        decision.effects,
        decision.statusPatch,
        namespace,
        project as never,
        input.flow,
        refreshedTasks,
      );

      if (!result.applied) {
        console.warn(
          `[reconcile] ${task.metadata.name} execution failed:`,
          result.error,
        );
        continue;
      }

      // Persist audit events to K8s Events and SQLite (via web service).
      const taskUid = task.metadata.uid ?? "";
      for (const event of decision.events) {
        await persistEvent(event, namespace, task.metadata.name, taskUid);
        emitEvent(
          event.project,
          event.task,
          task.spec.type,
          event.reason,
          { fromPhase: event.fromPhase, toPhase: event.toPhase, message: event.message, effects: event.effects },
        );
      }

      // Adjust active count only when membership changes.
      const newPhase = decision.toPhase ?? phase;
      const nowActive = isActivePhase(newPhase);
      if (wasActive && !nowActive) {
        activeCount--;
      } else if (!wasActive && nowActive) {
        activeCount++;
      }
      // active-to-active or inactive-to-inactive: no change to activeCount.
    } catch (e) {
      console.error(`[reconcile] ${task.metadata.name} handler error:`, e);
      throw e;
    }
  }

  console.log(`[reconcile] ${projectName} complete`);
}
