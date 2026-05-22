// Phase handler: failed → pending (with backoff) | stay failed

import type { PhaseHandler, Transition } from "../types.js";

export const handleFailed: PhaseHandler = async (ctx) => {
  // If auto-retry is disabled, stay failed (human decides).
  if (!ctx.config.retryPolicy.enabled) {
    return null;
  }

  // Poison pill check: if run failed too quickly, don't retry.
  const duration = ctx.task.status?.lastFailureDuration ?? 0;
  if (duration < ctx.config.retryPolicy.poisonPillThresholdSeconds) {
    console.log(
      `[failed] ${ctx.task.metadata.name} poison pill detected (${duration}s < ${ctx.config.retryPolicy.poisonPillThresholdSeconds}s)`,
    );
    return null; // Stay failed.
  }

  // Attempt limit check.
  const retryCount = ctx.task.status?.worker?.retryCount ?? 0;
  if (retryCount >= ctx.config.retryPolicy.maxAttempts - 1) {
    console.log(
      `[failed] ${ctx.task.metadata.name} retry attempts exhausted (${retryCount + 1}/${ctx.config.retryPolicy.maxAttempts})`,
    );
    return null; // Stay failed.
  }

  // Compute backoff.
  const backoff = Math.min(
    ctx.config.retryPolicy.backoffSeconds *
      Math.pow(ctx.config.retryPolicy.backoffMultiplier, retryCount),
    ctx.config.retryPolicy.maxBackoffSeconds,
  );
  const retryAfter = new Date(Date.now() + backoff * 1000).toISOString();

  console.log(
    `[failed] ${ctx.task.metadata.name} scheduling retry ${retryCount + 1}/${ctx.config.retryPolicy.maxAttempts} after ${backoff}s backoff`,
  );

  return {
    targetPhase: "pending",
    sideEffects: [
      {
        type: "patchWorker",
        patch: { retryCount: retryCount + 1 },
      },
      {
        type: "patchTaskStatus",
        patch: { retryAfter },
      },
    ],
  };
};
