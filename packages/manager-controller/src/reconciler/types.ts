// Reconciler types — phase handler architecture.

import type { Task, Project, Run, TaskPhase } from "@percussionist/api";
import type { RunSpec, TaskSpec } from "@percussionist/api";
import type { ResolvedFlow } from "./flow.js";

// Configuration resolved from project + task + cluster settings.
export interface ResolvedConfig {
  retryPolicy: {
    enabled: boolean;
    maxAttempts: number;
    backoffSeconds: number;
    backoffMultiplier: number;
    maxBackoffSeconds: number;
    poisonPillThresholdSeconds: number;
  };
  reviewPolicy: {
    aiReviewerEnabled: boolean;
    aiReviewerAgent: string;
    maxAutoReworks: number;
  };
  flow: ResolvedFlow;
  model?: string;
  image: string;
  timeoutSeconds: number;
}
