// task-scheduler.ts — determines which tasks to pull from "ready" and
// schedules rework when humans move tasks back to the rework column.

import type { OpenCodeProject, WorkerStatus, BoardStatus } from "@percussionist/api";

/**
 * Returns task IDs that should be pulled from "ready" this reconcile cycle.
 * Respects the board's maxParallel WIP limit.
 */
export function getTasksToPull(
  project: OpenCodeProject,
  boardStatus: BoardStatus,
): string[] {
  const maxParallel = project.spec.board?.maxParallel ?? 2;
  const workers = boardStatus.workers ?? [];
  const backlog = boardStatus.backlog ?? {};
  const readyTasks = backlog["ready"] ?? [];

  const activeCount = workers.filter((w) => w.status === "Running").length;
  const availableSlots = maxParallel - activeCount;
  if (availableSlots <= 0) return [];

  const result: string[] = [];
  for (const taskId of readyTasks) {
    if (result.length >= availableSlots) break;
    // Skip if already being worked on (not failed/escalated).
    const existing = workers.find((w) => w.taskId === taskId);
    if (existing && existing.status !== "Failed" && existing.status !== "Escalated") {
      continue;
    }
    result.push(taskId);
  }
  return result;
}

/**
 * Returns task IDs in the "rework" column that should be re-dispatched.
 * A task is eligible if it has no worker, or its worker has finished
 * (Succeeded, Failed, or Escalated) — i.e. it is not currently Running.
 * This covers both the normal review→rework flow (worker Succeeded) and
 * human-initiated rework of failed/escalated tasks.
 */
export function getTasksToRework(
  boardStatus: BoardStatus,
): string[] {
  const workers = boardStatus.workers ?? [];
  const reworkColumn = boardStatus.backlog?.["rework"] ?? [];

  return reworkColumn.filter((taskId) => {
    const worker = workers.find((w) => w.taskId === taskId);
    // No worker yet, or worker is in a terminal/non-running state.
    return !worker || worker.status !== "Running";
  });
}

/**
 * Moves a task from one column to another in the backlog.
 * Returns a new backlog object (does not mutate input).
 */
export function moveTask(
  backlog: BoardStatus["backlog"],
  taskId: string,
  toColumn: string,
): BoardStatus["backlog"] {
  const updated = { ...backlog };
  // Remove from all columns.
  for (const col of Object.keys(updated)) {
    updated[col] = (updated[col] ?? []).filter((id) => id !== taskId);
  }
  // Add to target column.
  if (!updated[toColumn]) updated[toColumn] = [];
  updated[toColumn] = [...updated[toColumn]!, taskId];
  return updated;
}

/**
 * Updates a single worker's status in the workers array.
 * Returns a new array (does not mutate input).
 */
export function updateWorker(
  workers: WorkerStatus[],
  taskId: string,
  patch: Partial<WorkerStatus>,
): WorkerStatus[] {
  return workers.map((w) =>
    w.taskId === taskId ? { ...w, ...patch } : w,
  );
}

/**
 * Adds a new worker entry or replaces an existing one for a task.
 */
export function upsertWorker(
  workers: WorkerStatus[],
  newWorker: WorkerStatus,
): WorkerStatus[] {
  const without = workers.filter((w) => w.taskId !== newWorker.taskId);
  return [...without, newWorker];
}
