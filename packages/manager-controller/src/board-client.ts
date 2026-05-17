// board-client.ts — HTTP client for the web server's SQLite-backed board API.
//
// The manager calls these functions instead of patching CR status.board
// directly, removing the merge-patch race condition.
//
// All functions throw on non-2xx so callers can propagate errors normally.

import type { WorkerStatus } from "@percussionist/api";

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? "percussionist";

// Default to the in-cluster DNS name of the web service. Can be overridden
// for local development via WEB_SERVICE_URL env var.
const WEB_URL =
  process.env.WEB_SERVICE_URL ??
  `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;

const log = (...args: unknown[]) =>
  console.log(`[board-client ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[board-client ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// Types (mirror the web API shapes)

export interface BoardTaskRow {
  taskId: string;
  column: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardWorkerRow {
  taskId: string;
  runName: string;
  retryCount: number;
  status: string;
  branch: string | null;
  facilitated: boolean;
  reviewRunName: string | null;
  reworkRunName: string | null;
  facilitationRunName: string | null;
  // JSON blob of extra WorkerStatus fields not in the main schema columns.
  extra: Record<string, unknown> | null;
  assignedAt: string;
  updatedAt: string;
}

export interface FullBoard {
  // column name → taskId array
  columns: Record<string, string[]>;
  // taskId → worker row
  workers: Record<string, BoardWorkerRow>;
  activeWorkers: number;
}

export interface WorkerUpsertBody {
  runName: string;
  retryCount?: number;
  status: string;
  branch?: string;
  facilitated?: boolean;
  reviewRunName?: string;
  reworkRunName?: string;
  facilitationRunName?: string;
  // Extra fields serialised from WorkerStatus (reviewApproved, escalation, etc.)
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// WorkerStatus ↔ BoardWorkerRow conversions
//
// The main DB columns cover the most-queried fields; everything else lives in
// the `extra` JSON blob.

const EXTRA_WORKER_KEYS: ReadonlyArray<keyof WorkerStatus> = [
  "startedAt",
  "completedAt",
  "escalation",
  "facilitationResult",
  "buildTasksFacilitatorRun",
  "buildTasksCreated",
  "createdBuildTasks",
  "reviewApproved",
  "reviewFeedback",
  "reworkAgent",
  "mergeRunName",
  "mergedAt",
  "mergeError",
  "prNumber",
];

export function workerStatusToUpsertBody(w: WorkerStatus): WorkerUpsertBody & { taskId: string } {
  const extra: Record<string, unknown> = {};
  for (const k of EXTRA_WORKER_KEYS) {
    if (w[k] !== undefined) extra[k] = w[k];
  }
  return {
    taskId: w.taskId,
    runName: w.runName ?? "",
    retryCount: w.retryCount ?? 0,
    status: w.status,
    branch: w.branch,
    facilitated: w.facilitated,
    reviewRunName: w.reviewRunName,
    reworkRunName: undefined,
    facilitationRunName: w.facilitationRunName,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

export function boardWorkerRowToWorkerStatus(row: BoardWorkerRow): WorkerStatus {
  const extra = (row.extra ?? {}) as Partial<WorkerStatus>;
  return {
    taskId: row.taskId,
    runName: row.runName || undefined,
    status: row.status as WorkerStatus["status"],
    branch: row.branch ?? undefined,
    retryCount: row.retryCount,
    facilitated: row.facilitated,
    reviewRunName: row.reviewRunName ?? undefined,
    facilitationRunName: row.facilitationRunName ?? undefined,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Helpers

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${WEB_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`board API ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Board read

export async function getBoard(project: string): Promise<FullBoard> {
  return (await request("GET", `/api/board/${encodeURIComponent(project)}`)) as FullBoard;
}

export async function getBoardTask(
  project: string,
  taskId: string,
): Promise<{ task: BoardTaskRow; worker: BoardWorkerRow | null }> {
  return (await request(
    "GET",
    `/api/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
  )) as { task: BoardTaskRow; worker: BoardWorkerRow | null };
}

// ---------------------------------------------------------------------------
// Board mutations

export async function moveTask(
  project: string,
  taskId: string,
  column: string,
): Promise<void> {
  await request(
    "POST",
    `/api/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/move`,
    { column },
  );
}

export async function upsertWorker(
  project: string,
  taskId: string,
  worker: WorkerUpsertBody,
): Promise<void> {
  await request(
    "PUT",
    `/api/board/${encodeURIComponent(project)}/workers/${encodeURIComponent(taskId)}`,
    worker,
  );
}

export async function removeWorker(project: string, taskId: string): Promise<void> {
  await request(
    "DELETE",
    `/api/board/${encodeURIComponent(project)}/workers/${encodeURIComponent(taskId)}`,
  );
}

// ---------------------------------------------------------------------------
// Seed — idempotent bulk-load.  Called on first reconcile to ensure all tasks
// from spec.board.tasks are present in the DB with their initial column.

export async function seedBoard(
  project: string,
  tasks: Array<{ taskId: string; column: string; seq?: number }>,
): Promise<{ inserted: number; skipped: number }> {
  const result = (await request("POST", `/api/board/${encodeURIComponent(project)}/seed`, {
    tasks,
  })) as { inserted: number; skipped: number };
  log(`seeded board for ${project}: ${result.inserted} inserted, ${result.skipped} skipped`);
  return result;
}

// ---------------------------------------------------------------------------
// Sync — atomic end-of-cycle board state replace.
//
// Converts the reconciler's in-memory backlog + workers arrays to the DB
// shape and POSTs them to the web server's sync endpoint.

export async function syncBoard(
  project: string,
  backlog: Record<string, string[]>,
  workers: WorkerStatus[],
): Promise<void> {
  const tasks: Array<{ taskId: string; column: string }> = [];
  for (const [column, ids] of Object.entries(backlog)) {
    for (const taskId of ids) {
      tasks.push({ taskId, column });
    }
  }

  const workerPayload = workers.map(workerStatusToUpsertBody);

  try {
    await request("POST", `/api/board/${encodeURIComponent(project)}/sync`, {
      tasks,
      workers: workerPayload,
    });
  } catch (e) {
    err(`syncBoard failed for ${project}:`, (e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Convenience: ensure all spec tasks exist in SQLite with a safe default
// column ("ready"), then return the full board.
// Used at the top of each reconcile cycle instead of reading status.board.

export async function ensureAndGetBoard(
  project: string,
  specTaskIds: string[],
): Promise<FullBoard> {
  if (specTaskIds.length > 0) {
    try {
      await seedBoard(
        project,
        specTaskIds.map((taskId) => ({ taskId, column: "ready" })),
      );
    } catch (e) {
      err(`ensureAndGetBoard: seed failed for ${project}:`, (e as Error).message);
    }
  }
  return getBoard(project);
}
