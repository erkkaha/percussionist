// Scheduler — determines which tasks are eligible to run.

import type { Task, Project, TaskPhase } from "@percussionist/api";

// Active phases that count toward WIP limit.
const ACTIVE_PHASES: readonly TaskPhase[] = [
  "scheduled",
  "initializing",
  "running",
  "waiting-for-input",
  "awaiting-merge",
  "generating-builds",
];

export function isActivePhase(phase: TaskPhase): boolean {
  return (ACTIVE_PHASES as readonly string[]).includes(phase);
}

// Check if a task can be scheduled (transitioned from pending → scheduled).
export function canSchedule(task: Task, project: Project, allTasks: Task[]): boolean {
  // WIP limit check.
  const activeCount = allTasks.filter((t) => isActivePhase(t.status?.phase ?? "pending")).length;
  const maxParallel = project.spec.maxParallel ?? 2;
  if (activeCount >= maxParallel) {
    return false;
  }

  // Predecessor check (BUILD tasks with predecessorRef).
  if (task.spec.predecessorRef) {
    const pred = allTasks.find((t) => t.metadata.name === task.spec.predecessorRef);
    if (!pred || pred.status?.phase !== "done") {
      return false;
    }
    // Feature branching: predecessor must be merged.
    if (project.spec.featureBranchingEnabled && !pred.status?.worker?.mergedAt) {
      return false;
    }
  }

  // Retry backoff check.
  if (task.status?.retryAfter) {
    const retryAfter = new Date(task.status.retryAfter);
    if (retryAfter > new Date()) {
      return false;
    }
  }

  return true;
}

// Sort tasks by priority (high > medium > low).
export function byPriority(a: Task, b: Task): number {
  const priorityMap = { high: 3, medium: 2, low: 1 };
  const aP = priorityMap[a.spec.priority ?? "medium"];
  const bP = priorityMap[b.spec.priority ?? "medium"];
  return bP - aP;
}
