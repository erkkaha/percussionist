// Scheduler — determines which tasks are eligible to run.

import type { Project, Task, TaskPhase } from '@percussionist/api';
import { childMergeExpected, childSatisfiesGate } from './child-completion.js';
import type { ResolvedFlow } from './flow.js';

// Active phases that count toward WIP limit.
const ACTIVE_PHASES: readonly TaskPhase[] = [
  'scheduled',
  'initializing',
  'running',
  'reviewing',
  'waiting-for-input',
  'awaiting-merge',
  'generating-builds',
];

export function isActivePhase(phase: TaskPhase): boolean {
  return (ACTIVE_PHASES as readonly string[]).includes(phase);
}

// Check if a task can be scheduled (transitioned from pending → scheduled).
export function canSchedule(
  task: Task,
  project: Project,
  allTasks: Task[],
  activeCount: number,
  flow: ResolvedFlow,
): boolean {
  // WIP limit check.
  const maxParallel = project.spec.maxParallel ?? 2;
  if (activeCount >= maxParallel) {
    return false;
  }

  // Predecessor check (BUILD tasks with predecessorRef).
  if (task.spec.predecessorRef) {
    const pred = allTasks.find((t) => t.metadata.name === task.spec.predecessorRef);
    if (pred?.status?.phase !== 'done') {
      return false;
    }
    if (!childSatisfiesGate(pred, childMergeExpected(project, flow))) {
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
  const aP = priorityMap[a.spec.priority ?? 'medium'];
  const bP = priorityMap[b.spec.priority ?? 'medium'];
  return bP - aP;
}
