// board.ts — `beatctl board` subcommands.
//
// Manages the kanban board embedded in an OpenCodeProject.
// The board always lives at project.spec.board (K8s) and the web service's
// SQLite DB for runtime state (backlog columns + worker status).
//
// Subcommands:
//   get <project>                  — show board state (columns, workers, escalations)
//   task add <project>             — add a task to the board
//   task move <project>            — move a task between columns
//   task remove <project>          — remove a task from the board
//
// Board state is read/written via the web service API (PERCUSSIONIST_WEB_URL).
// Defaults to http://localhost:8080 for local use with `kubectl port-forward`.

import YAML from "yaml";
import {
  type OpenCodeProject,
  type BoardTask,
  type BoardSpec,
  type WorkerStatus,
} from "@percussionist/api";
import {
  NAMESPACE,
  getProject,
  patchProjectSpec,
  age,
  padCols,
  fatal,
  loadFromKubeconfig,
} from "@percussionist/kube";

// ---------------------------------------------------------------------------
// Web API client (board state)

const WEB_URL =
  process.env.PERCUSSIONIST_WEB_URL ??
  process.env.WEB_SERVICE_URL ??
  "http://localhost:8080";

interface FullBoard {
  columns: Record<string, string[]>;
  workers: Record<string, {
    taskId: string;
    runName: string;
    retryCount: number;
    status: string;
    branch: string | null;
    facilitated: boolean;
    extra: Record<string, unknown> | null;
  }>;
  activeWorkers: number;
}

async function boardApiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${WEB_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`board API ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function getBoardFromApi(project: string): Promise<FullBoard | null> {
  try {
    return (await boardApiRequest("GET", `/api/board/${encodeURIComponent(project)}`)) as FullBoard;
  } catch {
    return null;
  }
}

async function moveBoardTask(project: string, taskId: string, column: string): Promise<void> {
  await boardApiRequest(
    "POST",
    `/api/board/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/move`,
    { column },
  );
}

async function seedBoardTask(project: string, taskId: string, column: string): Promise<void> {
  await boardApiRequest("POST", `/api/board/${encodeURIComponent(project)}/seed`, {
    tasks: [{ taskId, column }],
  });
}

async function removeBoardTaskFromDb(project: string, taskId: string): Promise<void> {
  // The sync endpoint would handle removal, but for a single task we call move
  // then let the reconciler prune it on next cycle. For now, we can call the
  // seed endpoint with just the remaining tasks — but that's expensive.
  // Simpler: the reconciler will prune it from SQLite on next cycle since it's
  // removed from spec.board.tasks. No immediate API call needed.
  void project;
  void taskId;
}

// ---------------------------------------------------------------------------
// board get

export interface BoardGetOpts {
  namespace?: string;
  output?: "yaml" | "json";
}

export async function runBoardGet(
  projectName: string,
  opts: BoardGetOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();
  let project: OpenCodeProject;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  // Try to read board state from SQLite via web API.
  const sqliteBoard = await getBoardFromApi(projectName);

  if (opts.output === "json") {
    const output: Record<string, unknown> = { spec: project.spec.board };
    if (sqliteBoard) {
      output.board = sqliteBoard;
    } else {
      output.board = project.status?.board;
      output.boardSource = "k8s-status (web API unavailable)";
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (opts.output === "yaml") {
    const output: Record<string, unknown> = { spec: { board: project.spec.board } };
    if (sqliteBoard) {
      output.board = sqliteBoard;
    } else {
      output.board = { status: project.status?.board };
      output.boardSource = "k8s-status (web API unavailable)";
    }
    console.log(YAML.stringify(output));
    return;
  }

  const board = project.spec.board;

  // Use SQLite board if available, fall back to K8s status.
  const backlog: Record<string, string[]> = sqliteBoard?.columns ?? project.status?.board?.backlog ?? {};
  const columns = ["ready", "in-progress", "review", "rework", "done"];

  // Build workers list from SQLite or K8s.
  let workers: WorkerStatus[];
  if (sqliteBoard) {
    workers = Object.values(sqliteBoard.workers).map((w) => ({
      taskId: w.taskId,
      runName: w.runName || undefined,
      status: w.status as WorkerStatus["status"],
      branch: w.branch ?? undefined,
      retryCount: w.retryCount,
      facilitated: w.facilitated,
      ...(w.extra as Partial<WorkerStatus> ?? {}),
    }));
  } else {
    workers = project.status?.board?.workers ?? [];
    if (!sqliteBoard) {
      console.error(`  (web API unavailable at ${WEB_URL} — showing K8s status; set PERCUSSIONIST_WEB_URL or run kubectl port-forward)`);
    }
  }

  console.log(`Board: ${projectName}`);
  console.log(`Phase: ${board?.phase ?? "Active"}`);
  console.log(`Max parallel: ${board?.maxParallel ?? 2}`);
  console.log(`Team: ${(board?.agents ?? []).map((a) => a.name).join(", ") || "(none)"}`);
  console.log();

  const colRows: string[][] = [["COLUMN", "TASKS"]];
  for (const col of columns) {
    const tasks = backlog[col] ?? [];
    colRows.push([col, tasks.length > 0 ? tasks.join(", ") : "(empty)"]);
  }
  console.log(padCols(colRows));
  console.log();

  const running = workers.filter((w) => w.status === "Running");
  if (running.length > 0) {
    console.log("Active workers:");
    const workerRows: string[][] = [["TASK", "AGENT", "RUN", "RETRIES"]];
    for (const w of running) {
      const taskDef = (board?.tasks ?? []).find((t) => t.id === w.taskId);
      workerRows.push([w.taskId, taskDef?.agent ?? "-", w.runName ?? "-", String(w.retryCount ?? 0)]);
    }
    console.log(padCols(workerRows));
    console.log();
  }

  const escalated = workers.filter((w) => w.status === "Escalated");
  if (escalated.length > 0) {
    console.log(`Escalations (${escalated.length}):`);
    for (const e of escalated) {
      console.log(`--- ${e.taskId} ---`);
      console.log(e.escalation ?? "(no details)");
      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// board task add

export interface BoardTaskAddOpts {
  namespace?: string;
  id: string;
  title: string;
  description?: string;
  type: "PLAN" | "BUILD";
  priority?: "high" | "medium" | "low";
  agent: string;
  column?: string;
}

export async function runBoardTaskAdd(
  projectName: string,
  opts: BoardTaskAddOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();

  let project: OpenCodeProject;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  const board: BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const teamNames = (board.agents ?? []).map((a) => a.name);
  if (!teamNames.includes(opts.agent)) {
    console.error(
      `beatctl: agent "${opts.agent}" is not in the board's team roster.`,
    );
    console.error(`  Available agents: ${teamNames.join(", ") || "(none — add agents to the board first)"}`);
    process.exit(1);
  }

  // Add task to spec.board.tasks.
  const tasks = board.tasks ?? [];
  if (tasks.find((t) => t.id === opts.id)) {
    console.error(`beatctl: task "${opts.id}" already exists on the board`);
    process.exit(1);
  }
  const newTask: BoardTask = {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    type: opts.type,
    priority: opts.priority ?? "medium",
    agent: opts.agent,
  };
  tasks.push(newTask);

  // Patch spec.board.tasks.
  try {
    await patchProjectSpec(projectName, { board: { ...board, tasks } }, ns, custom);
  } catch (e) {
    fatal("patch project spec failed", e);
  }

  // Add task to SQLite board state via web API.
  const column = opts.column ?? "ready";
  try {
    await seedBoardTask(projectName, opts.id, column);
    console.log(`task ${opts.id} added to "${column}" on project ${projectName} board`);
  } catch (e) {
    console.error(`beatctl: task added to spec but failed to write to web API: ${(e as Error).message}`);
    console.error(`  The reconciler will seed the task on next cycle.`);
    console.log(`task ${opts.id} added to spec (board state will sync on next reconcile)`);
  }
}

// ---------------------------------------------------------------------------
// board task move

export interface BoardTaskMoveOpts {
  namespace?: string;
  taskId: string;
  to: string;
}

export async function runBoardTaskMove(
  projectName: string,
  opts: BoardTaskMoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  void ns;

  try {
    await moveBoardTask(projectName, opts.taskId, opts.to);
    console.log(`task ${opts.taskId} moved to "${opts.to}" on project ${projectName} board`);
  } catch (e) {
    fatal(`board task move failed — ensure web API is accessible at ${WEB_URL}`, e);
  }
}

// ---------------------------------------------------------------------------
// board task remove

export interface BoardTaskRemoveOpts {
  namespace?: string;
  taskId: string;
}

export async function runBoardTaskRemove(
  projectName: string,
  opts: BoardTaskRemoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();

  let project: OpenCodeProject;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  const board: BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
  const tasks = (board.tasks ?? []).filter((t) => t.id !== opts.taskId);
  await patchProjectSpec(projectName, { board: { ...board, tasks } }, ns, custom).catch(
    (e) => fatal("patch spec failed", e),
  );

  // The reconciler will prune the task from SQLite on its next cycle since
  // it's no longer in spec.board.tasks.  No immediate web API call needed.
  console.log(`task ${opts.taskId} removed from project ${projectName} board`);
  console.log(`  (board state will sync on next reconcile cycle)`);
}
