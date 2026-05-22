// Phase handler: pending → scheduled

import type { PhaseHandler, Transition } from "../types.js";
import { canSchedule } from "../scheduler.js";

export const handlePending: PhaseHandler = async (ctx) => {
  // Check if task can be scheduled (WIP limit, predecessors, backoff).
  if (!canSchedule(ctx.task, ctx.project, ctx.allTasks)) {
    return null; // Not ready yet.
  }

  // Check retry backoff.
  if (ctx.task.status?.retryAfter) {
    const retryAfter = new Date(ctx.task.status.retryAfter);
    if (retryAfter > new Date()) {
      return null; // Still in backoff.
    }
  }

  // Ready to schedule.
  return {
    targetPhase: "scheduled",
    sideEffects: [],
  };
};
