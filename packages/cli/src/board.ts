// board.ts — `beatctl board` subcommands.
//
// Manages the kanban board embedded in an OpenCodeProject.
// The board always lives at project.spec.board and project.status.board.
//
// Subcommands:
//   get <project>                  — show board state (columns, workers, escalations)
//   task add <project>             — add a task to the board
//   task move <project>            — move a task between columns
//   task remove <project>          — remove a task from the board

import YAML from "yaml";
import {
  type OpenCodeProject,
  type BoardTask,
  type BoardSpec,
} from "@percussionist/api";
import {
  NAMESPACE,
  getProject,
  patchProjectSpec,
  patchProjectStatus,
  age,
  padCols,
  fatal,
  loadFromKubeconfig,
} from "@percussionist/kube";

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

  if (opts.output === "json") {
    console.log(JSON.stringify({ spec: project.spec.board, status: project.status?.board }, null, 2));
    return;
  }
  if (opts.output === "yaml") {
    console.log(YAML.stringify({ spec: { board: project.spec.board }, status: { board: project.status?.board } }));
    return;
  }

  const board = project.spec.board;
  const boardStatus = project.status?.board;
  const backlog = boardStatus?.backlog ?? {};
  const columns = boardStatus?.columns ?? ["ready", "in-progress", "review", "rework", "done"];
  const workers = boardStatus?.workers ?? [];

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

  // Add task ID to status.board.backlog[column].
  const column = opts.column ?? "ready";
  const boardStatus = project.status?.board ?? {
    columns: ["ready", "in-progress", "review", "rework", "done"],
    backlog: { ready: [] },
    workers: [],
    activeWorkers: 0,
  };
  const backlog = boardStatus.backlog ?? {};
  if (!backlog[column]) backlog[column] = [];
  backlog[column]!.push(opts.id);

  try {
    await patchProjectStatus(projectName, { board: { ...boardStatus, backlog } }, ns);
  } catch (e) {
    fatal("patch project status failed", e);
  }

  console.log(`task ${opts.id} added to "${column}" on project ${projectName} board`);
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
  const { custom } = loadFromKubeconfig();

  let project: OpenCodeProject;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  const boardStatus = project.status?.board ?? { backlog: {}, columns: [], workers: [], activeWorkers: 0 };
  const backlog = { ...boardStatus.backlog };
  for (const col of Object.keys(backlog)) {
    backlog[col] = (backlog[col] ?? []).filter((id) => id !== opts.taskId);
  }
  if (!backlog[opts.to]) backlog[opts.to] = [];
  backlog[opts.to]!.push(opts.taskId);

  try {
    await patchProjectStatus(projectName, { board: { ...boardStatus, backlog } }, ns);
    console.log(`task ${opts.taskId} moved to "${opts.to}" on project ${projectName} board`);
  } catch (e) {
    fatal("patch project status failed", e);
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

  const boardStatus = project.status?.board ?? { backlog: {}, columns: [], workers: [], activeWorkers: 0 };
  const backlog = { ...boardStatus.backlog };
  for (const col of Object.keys(backlog)) {
    backlog[col] = (backlog[col] ?? []).filter((id) => id !== opts.taskId);
  }
  await patchProjectStatus(projectName, { board: { ...boardStatus, backlog } }, ns).catch(
    (e) => fatal("patch status failed", e),
  );

  console.log(`task ${opts.taskId} removed from project ${projectName} board`);
}
