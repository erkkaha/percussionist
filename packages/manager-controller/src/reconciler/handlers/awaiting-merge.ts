// Phase handler: awaiting-merge → done | failed

import type { PhaseHandler, Transition } from "../types.js";
import { getRun } from "@percussionist/kube";
import { buildMergeRun, auxiliaryRunName } from "../../worker-builder.js";

const MERGE_STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const handleAwaitingMerge: PhaseHandler = async (ctx) => {
  const mergeRunName = ctx.task.status?.worker?.mergeRunName;
  
  if (!mergeRunName) {
    // No merge run yet — this shouldn't happen (awaiting-human creates it).
    // Create merge run as fallback.
    const newMergeRunName = auxiliaryRunName(
      ctx.project.metadata.name,
      "merge",
      ctx.task.metadata.name,
      "0",
    );

    const mergeRun = await buildMergeRun(
      ctx.project,
      ctx.task,
      newMergeRunName,
      ctx.allTasks,
    );

    return {
      targetPhase: "awaiting-merge",
      sideEffects: [
        {
          type: "createRun",
          run: mergeRun,
        },
        {
          type: "patchWorker",
          patch: { mergeRunName: newMergeRunName },
        },
      ],
    };
  }

  // Fetch merge run.
  const mergeRun = await getRun(mergeRunName, ctx.namespace).catch(() => undefined);
  
  if (!mergeRun) {
    // Merge run disappeared — transition to failed.
    return {
      targetPhase: "failed",
      sideEffects: [
        {
          type: "patchWorker",
          patch: {
            status: "Failed",
            mergeError: "Merge run disappeared",
          },
        },
        {
          type: "emitEvent",
          event: { reason: "MergeRunMissing", message: "Merge run pod disappeared" },
        },
      ],
    };
  }

  const mergePhase = mergeRun.status?.phase;

  if (mergePhase === "Succeeded") {
    // Merge succeeded → done.
    return {
      targetPhase: "done",
      sideEffects: [
        {
          type: "patchWorker",
          patch: {
            status: "Succeeded",
            mergedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        },
      ],
    };
  }

  if (mergePhase === "Failed") {
    // Merge failed → failed.
    const errorMsg = mergeRun.status?.message ?? "Merge failed";
    return {
      targetPhase: "failed",
      sideEffects: [
        {
          type: "patchWorker",
          patch: {
            status: "Failed",
            mergeError: errorMsg,
          },
        },
      ],
    };
  }

  // Check staleness (5min).
  if (mergePhase === "Running") {
    const lastEvent = mergeRun.status?.lastEventAt;
    if (lastEvent && Date.now() - new Date(lastEvent).getTime() > MERGE_STALENESS_THRESHOLD_MS) {
      return {
        targetPhase: "failed",
        sideEffects: [
          {
            type: "deleteRun",
            name: mergeRunName,
          },
          {
            type: "patchWorker",
            patch: {
              status: "Failed",
              mergeError: "Merge run stale after 5 minutes",
            },
          },
          {
            type: "emitEvent",
            event: { reason: "MergeStale", message: "Merge run stale after 5 minutes" },
          },
        ],
      };
    }
  }

  // Still running or initializing.
  return null;
};
