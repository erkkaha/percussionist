// Phase handler: scheduled → initializing

import type { PhaseHandler, Transition } from "../types.js";
import { buildWorkerRun, workerRunName } from "../../worker-builder.js";
import { API_GROUP_VERSION, KIND_RUN } from "@percussionist/api";

export const handleScheduled: PhaseHandler = async (ctx) => {
  const retryCount = ctx.task.status?.worker?.retryCount ?? 0;
  const runName = workerRunName(ctx.project.metadata.name, ctx.task.metadata.name, retryCount);
  
  // Check for rework feedback annotation on Project (written by web API).
  const feedbackKey = `percussionist.dev/rework-${ctx.task.metadata.name}`;
  const reworkFeedback = ctx.project.metadata.annotations?.[feedbackKey];

  // Build the worker run spec.
  const run = await buildWorkerRun(
    ctx.project,
    ctx.task,
    runName,
    retryCount,
    reworkFeedback,
    ctx.allTasks,
  );

  return {
    targetPhase: "initializing",
    sideEffects: [
      {
        type: "createRun",
        run,
      },
      {
        type: "patchWorker",
        patch: {
          runName,
          status: "Running",
          startedAt: new Date().toISOString(),
        },
      },
    ],
  };
};
