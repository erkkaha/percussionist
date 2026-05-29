// Reconciler types — phase handler architecture.

import type { Task, Project, Run, TaskPhase } from "@percussionist/api";
import type { RunSpec, TaskSpec } from "@percussionist/api";

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
  model?: string;
  image: string;
  timeoutSeconds: number;
}

// Context passed to every phase handler.
export interface PhaseContext {
  task: Task;
  project: Project;
  allTasks: Task[];
  run?: Run;
  config: ResolvedConfig;
  namespace: string;
  /** Running count of active tasks (updated after each transition in this reconcile cycle). */
  activeCount: number;
}

// Side effects emitted by phase handlers.
export type SideEffect =
  | { type: "createRun"; run: Run }
  | { type: "deleteRun"; name: string }
  | { type: "patchWorker"; patch: Partial<NonNullable<Task["status"]>["worker"]> }
  | { type: "cleanupWorktree"; runName: string }
  | { type: "emitEvent"; event: { reason: string; message: string } }
  | { type: "createTasks"; tasks: Task[] }
  | { type: "patchTaskStatus"; patch: Partial<Task["status"]> }
  | { type: "clearProjectAnnotations"; keys: string[] }
  | { type: "clearTaskAnnotations"; keys: string[] };

// Transition result from a phase handler.
export interface Transition {
  targetPhase: TaskPhase;
  sideEffects: SideEffect[];
}

// Phase handler function signature.
export type PhaseHandler = (ctx: PhaseContext) => Promise<Transition | null>;
