// Phase handler: initializing → running

import type { PhaseHandler, Transition } from "../types.js";
import { RunPhase } from "@percussionist/api";

export const handleInitializing: PhaseHandler = async (ctx) => {
  if (!ctx.run) {
    // Run disappeared — transition to failed.
    return {
      targetPhase: "failed",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { status: "Failed" },
        },
        {
          type: "emitEvent",
          event: { reason: "RunMissing", message: "Run pod disappeared during initialization" },
        },
      ],
    };
  }

  // Wait for run to reach Running phase.
  if (ctx.run.status?.phase === "Running" || ctx.run.status?.phase === "WaitingForInput") {
    return {
      targetPhase: "running",
      sideEffects: [],
    };
  }

  // Check for early failure.
  if (ctx.run.status?.phase === "Failed") {
    return {
      targetPhase: "failed",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { status: "Failed", completedAt: new Date().toISOString() },
        },
      ],
    };
  }

  // Run completed before we transitioned to running — skip straight to succeeded.
  if (ctx.run.status?.phase === "Succeeded") {
    return {
      targetPhase: "succeeded",
      sideEffects: [
        {
          type: "patchWorker",
          patch: { status: "Succeeded", completedAt: new Date().toISOString() },
        },
      ],
    };
  }

  // Still initializing.
  return null;
};
