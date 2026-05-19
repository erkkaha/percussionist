// task-scheduler.ts — determines which tasks to pull from "ready" and
// schedules rework when humans move tasks back to the rework column.
//
// Now operates on Task CRs instead of embedded board status.

import type { Project, Task, WorkerStatus } from "@percussionist/api";

/**
 * Returns tasks that should be pulled from "ready" this reconcile cycle.
 * Respects the project's maxParallel WIP limit.
 * BUILD tasks with a predecessorRef not yet "done" are skipped (blocked).
 * When featureBranchingEnabled: true, BUILD predecessors must also be merged.
 */
export function getTasksToPull(
  project: Project,
  tasks: Task[],
): Task[] {
  const maxParallel = project.spec.maxParallel ?? 2;

  const taskByName = new Map(tasks.map((t) => [t.metadata.name, t]));
  const inProgressTasks = tasks.filter((t) => t.status?.column === "in-progress");
  const activeCount = inProgressTasks.filter(
    (t) => t.status?.worker?.status === "Running" && !!t.status.worker.runName,
  ).length;
  const availableSlots = maxParallel - activeCount;
  if (availableSlots <= 0) return [];

  const readyTasks = tasks
    .filter((t) => (t.status?.column ?? "ready") === "ready")
    .sort((a, b) => {
      // Priority order: high > medium > low
      const p = { high: 0, medium: 1, low: 2 };
      const pa = p[a.spec.priority ?? "medium"] ?? 1;
      const pb = p[b.spec.priority ?? "medium"] ?? 1;
      return pa - pb;
    });

  const result: Task[] = [];
  for (const task of readyTasks) {
    if (result.length >= availableSlots) break;

    // BUILD tasks: check predecessorRef — must be "done" before we can pull.
    // When feature branching is enabled, predecessor must also be merged.
    if (task.spec.type === "BUILD" && task.spec.predecessorRef) {
      const predecessor = taskByName.get(task.spec.predecessorRef);
      if (!predecessor || (predecessor.status?.column ?? "ready") !== "done") {
        // Not ready yet — skip (leave as "ready", will be picked up after predecessor finishes).
        continue;
      }
      
      // Feature branching: predecessor must be merged before dependent task can start.
      if (project.spec.featureBranchingEnabled) {
        if (!predecessor.status?.worker?.mergedAt) {
          // Predecessor done but not merged yet — skip.
          continue;
        }
      }
    }

    // Skip if already being worked on (not failed/escalated).
    const worker = task.status?.worker;
    const isStaleRunning = worker?.status === "Running" && !worker.runName;
    if (isStaleRunning) {
      result.push(task);
      continue;
    }
    if (worker && worker.status !== "Failed" && worker.status !== "Escalated") {
      continue;
    }
    result.push(task);
  }
  return result;
}

/**
 * Returns tasks in the "rework" column that should be re-dispatched.
 */
export function getTasksToRework(tasks: Task[]): Task[] {
  return tasks.filter((t) => {
    if (t.status?.column !== "rework") return false;
    const worker = t.status?.worker;
    return !worker || worker.status !== "Running";
  });
}

/**
 * Moves a task from one column to another in the backlog (in-memory only).
 * Returns a new backlog object (does not mutate input).
 * @deprecated Use patchTaskStatus directly for K8s writes. This helper remains
 * for legacy in-memory bookkeeping during the reconcile cycle before the final
 * patchTaskStatus calls are made.
 */
export function moveTask(
  backlog: Record<string, string[]>,
  taskId: string,
  toColumn: string,
): Record<string, string[]> {
  const updated = { ...backlog };
  for (const col of Object.keys(updated)) {
    updated[col] = (updated[col] ?? []).filter((id) => id !== taskId);
  }
  if (!updated[toColumn]) updated[toColumn] = [];
  updated[toColumn] = [...updated[toColumn]!, taskId];
  return updated;
}

/**
 * Updates a single worker's status in the workers array.
 * Returns a new array (does not mutate input).
 * @deprecated Use patchTaskStatus directly for K8s writes.
 */
export function updateWorker(
  workers: WorkerStatus[],
  taskName: string,
  patch: Partial<WorkerStatus>,
): WorkerStatus[] {
  return workers.map((w) =>
    w.runName === taskName || (w as WorkerStatus & { _taskName?: string })._taskName === taskName
      ? { ...w, ...patch }
      : w,
  );
}

/**
 * Adds a new worker entry or replaces an existing one for a task.
 * @deprecated Use patchTaskStatus directly for K8s writes.
 */
export function upsertWorker(
  workers: WorkerStatus[],
  newWorker: WorkerStatus,
): WorkerStatus[] {
  const without = workers.filter(
    (w) => (w as WorkerStatus & { _taskName?: string })._taskName !== (newWorker as WorkerStatus & { _taskName?: string })._taskName,
  );
  return [...without, newWorker];
}
