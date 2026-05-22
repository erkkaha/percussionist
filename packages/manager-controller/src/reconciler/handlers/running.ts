// Phase handler: running → succeeded | failed | waiting-for-input

import type { PhaseHandler, Transition } from "../types.js";
import { RunPhase } from "@percussionist/api";

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const handleRunning: PhaseHandler = async (ctx) => {
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
          event: { reason: "RunMissing", message: "Run pod disappeared" },
        },
      ],
    };
  }

  const runPhase = ctx.run.status?.phase;

  switch (runPhase) {
    case "Succeeded": {
      // Compute duration for lastFailureDuration (used by retry policy).
      const duration = computeDuration(ctx.run);
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

    case "Failed": {
      const duration = computeDuration(ctx.run);
      return {
        targetPhase: "failed",
        sideEffects: [
          {
            type: "patchWorker",
            patch: { status: "Failed", completedAt: new Date().toISOString() },
          },
          {
            type: "patchTaskStatus",
            patch: { lastFailureDuration: duration },
          },
        ],
      };
    }

    case "Running": {
      // Staleness check: if no activity for 5 minutes, mark as failed.
      const lastEvent = ctx.run.status?.lastEventAt;
      if (lastEvent) {
        const elapsed = Date.now() - new Date(lastEvent).getTime();
        if (elapsed > STALENESS_THRESHOLD_MS) {
          return {
            targetPhase: "failed",
            sideEffects: [
              {
                type: "patchWorker",
                patch: { status: "Failed" },
              },
              {
                type: "emitEvent",
                event: { reason: "Stale", message: "No activity for 5 minutes" },
              },
            ],
          };
        }
      }
      return null; // Still running.
    }

    case "WaitingForInput": {
      // Only PLAN tasks can wait for input.
      if (ctx.task.spec.type !== "PLAN") {
        return {
          targetPhase: "failed",
          sideEffects: [
            {
              type: "patchWorker",
              patch: { status: "Failed" },
            },
            {
              type: "emitEvent",
              event: {
                reason: "BuildCannotWait",
                message: "BUILD tasks cannot wait for input",
              },
            },
          ],
        };
      }
      return {
        targetPhase: "waiting-for-input",
        sideEffects: [],
      };
    }

    default:
      return null; // Pending or Initializing — wait.
  }
};

// Compute run duration in seconds.
function computeDuration(run: { status?: { startedAt?: string; completedAt?: string } }): number {
  const start = run.status?.startedAt;
  const end = run.status?.completedAt;
  if (!start || !end) return 0;
  return (new Date(end).getTime() - new Date(start).getTime()) / 1000;
}
