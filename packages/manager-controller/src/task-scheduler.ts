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
  const blockingBuildId = getBlockingBuildSequenceTask(project, boardStatus);

  const activeCount = workers.filter((w) => w.status === "Running").length;
  const availableSlots = maxParallel - activeCount;
  if (availableSlots <= 0) return [];

  const result: string[] = [];
  for (const taskId of readyTasks) {
    if (result.length >= availableSlots) break;

    // If there is an incomplete BUILD-N chain, only the next required BUILD-N
    // task is allowed to be pulled. Everything else stays queued.
    if (blockingBuildId && taskId !== blockingBuildId) {
      continue;
    }

    // BUILD-N tasks are sequence-gated: BUILD-(n+1) cannot start until all
    // existing BUILD-<n tasks are in "done". This prevents overlapping
    // implementation tasks that should be merged in order.
    if (isBlockedByBuildSequence(taskId, project, boardStatus)) {
      continue;
    }

    // Skip if already being worked on (not failed/escalated).
    const existing = workers.find((w) => w.taskId === taskId);
    if (existing && existing.status !== "Failed" && existing.status !== "Escalated") {
      continue;
    }
    result.push(taskId);
  }
  return result;
}

function getBlockingBuildSequenceTask(
  project: OpenCodeProject,
  boardStatus: BoardStatus,
): string | null {
  const done = new Set(boardStatus.backlog?.["done"] ?? []);
  const tasks = project.spec.board?.tasks ?? [];
  const buildNumbers = tasks
    .map((t) => {
      const m = /^BUILD-(\d+)$/.exec(t.id);
      if (!m) return null;
      const n = Number.parseInt(m[1] ?? "", 10);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  for (const n of buildNumbers) {
    const id = `BUILD-${n}`;
    if (!done.has(id)) {
      return id;
    }
  }
  return null;
}

function isBlockedByBuildSequence(
  taskId: string,
  project: OpenCodeProject,
  boardStatus: BoardStatus,
): boolean {
  const m = /^BUILD-(\d+)$/.exec(taskId);
  if (!m) return false;

  const current = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(current) || current <= 1) return false;

  const done = new Set(boardStatus.backlog?.["done"] ?? []);
  const allTaskIds = new Set((project.spec.board?.tasks ?? []).map((t) => t.id));

  for (let i = 1; i < current; i++) {
    const prev = `BUILD-${i}`;
    if (!allTaskIds.has(prev)) continue;
    if (!done.has(prev)) return true;
  }
  return false;
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
