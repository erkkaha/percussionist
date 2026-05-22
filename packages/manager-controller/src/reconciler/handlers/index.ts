// Phase handler registry.

import type { PhaseHandler } from "../types.js";
import type { TaskPhase } from "@percussionist/api";
import { handlePending } from "./pending.js";
import { handleScheduled } from "./scheduled.js";
import { handleInitializing } from "./initializing.js";
import { handleRunning } from "./running.js";
import { handleWaitingForInput } from "./waiting-for-input.js";
import { handleSucceeded } from "./succeeded.js";
import { handleReviewing } from "./reviewing.js";
import { handleAwaitingHuman } from "./awaiting-human.js";
import { handleAwaitingMerge } from "./awaiting-merge.js";
import { handleReworkRequested } from "./rework-requested.js";
import { handleGeneratingBuilds } from "./generating-builds.js";
import { handleFailed } from "./failed.js";

// Map of TaskPhase → PhaseHandler.
// Terminal phases (idea, done) have no handler.
export const handlers: Partial<Record<TaskPhase, PhaseHandler>> = {
  pending: handlePending,
  scheduled: handleScheduled,
  initializing: handleInitializing,
  running: handleRunning,
  "waiting-for-input": handleWaitingForInput,
  succeeded: handleSucceeded,
  reviewing: handleReviewing,
  "awaiting-human": handleAwaitingHuman,
  "awaiting-merge": handleAwaitingMerge,
  "rework-requested": handleReworkRequested,
  "generating-builds": handleGeneratingBuilds,
  failed: handleFailed,
};
