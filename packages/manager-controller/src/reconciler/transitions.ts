// Transition table — single source of truth for allowed phase transitions.

import type { TaskPhase } from "@percussionist/api";

export const TRANSITION_TABLE: Record<TaskPhase, TaskPhase[]> = {
  idea: ["pending"],
  pending: ["scheduled"],
  scheduled: ["initializing", "failed"],
  initializing: ["running", "succeeded", "failed"],
  running: ["waiting-for-input", "succeeded", "failed"],
  "waiting-for-input": ["running", "failed"],
  succeeded: ["reviewing", "awaiting-human", "done"],
  reviewing: ["awaiting-human", "rework-requested"],
  "awaiting-human": ["awaiting-merge", "generating-builds", "rework-requested", "done", "failed"],
  "awaiting-merge": ["done", "failed"],
  "rework-requested": ["scheduled"],
  "generating-builds": ["awaiting-children", "awaiting-human", "failed"],
  "awaiting-children": ["awaiting-feature-merge", "awaiting-human", "done", "failed"],
  "awaiting-feature-merge": ["done", "awaiting-human", "failed"],
  failed: ["pending", "awaiting-human"],
  done: [],
};

export function isValidTransition(from: TaskPhase, to: TaskPhase): boolean {
  return TRANSITION_TABLE[from]?.includes(to) ?? false;
}

export function validateTransition(from: TaskPhase, to: TaskPhase): string | null {
  const allowed = TRANSITION_TABLE[from];
  if (!allowed) return `Unknown source phase: ${from}`;
  if (allowed.includes(to)) return null;
  return `Invalid transition: ${from} → ${to}. Allowed: ${allowed.join(", ") || "(none, terminal)"}`;
}
