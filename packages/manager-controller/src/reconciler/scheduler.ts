// Scheduler — determines which tasks are eligible to run.

import type { Task, TaskPhase } from '@percussionist/api';

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

// Sort tasks by priority (high > medium > low).
export function byPriority(a: Task, b: Task): number {
  const priorityMap = { high: 3, medium: 2, low: 1 };
  const aP = priorityMap[a.spec.priority ?? 'medium'];
  const bP = priorityMap[b.spec.priority ?? 'medium'];
  return bP - aP;
}
