// Phase handler: rework-requested → scheduled

import type { PhaseHandler, Transition } from "../types.js";
import { canSchedule } from "../scheduler.js";

export const handleReworkRequested: PhaseHandler = async (ctx) => {
  // Guard: if the existing run is already terminal, don't re-schedule
  // into an idempotent createRun loop. The task stays in rework-requested
  // until handleAwaitingHuman picks up human feedback again.
  if (ctx.run && (ctx.run.status?.phase === "Succeeded" || ctx.run.status?.phase === "Failed")) {
    return null;
  }

  // Check if a scheduling slot is available.
  if (!canSchedule(ctx.task, ctx.project, ctx.allTasks, ctx.activeCount)) {
    return null; // Wait for slot.
  }

  // Reschedule the task.
  return {
    targetPhase: "scheduled",
    sideEffects: [],
  };
};
