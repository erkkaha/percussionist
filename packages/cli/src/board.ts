// board.ts — `beatctl board` subcommands.
//
// Manages the kanban board for an Project.
// Task state is authoritative in Task CRs (status subresource).
//
// Subcommands:
//   get <project>                  — show board state (columns, workers, escalations)
//   task add <project>             — create a new Task CR
//   task move <project>            — patch task status.column
//   task remove <project>          — delete the Task CR

import YAML from "yaml";
import {
  type Project,
  type TaskColumn,
  type TaskPhase,
  computeBoardColumn,
} from "@percussionist/api";
import {
  NAMESPACE,
  getProject,
  listTasks,
  createTask,
  deleteTask,
  patchTaskStatus,
  buildTask,
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

  let project: Project;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  const tasks = await listTasks(projectName, ns, custom);

  if (opts.output === "json") {
    console.log(JSON.stringify({ project: project.spec, tasks }, null, 2));
    return;
  }
  if (opts.output === "yaml") {
    console.log(YAML.stringify({ project: project.spec, tasks }));
    return;
  }

  console.log(`Board: ${projectName}`);
  console.log(`Phase: ${project.spec.phase ?? "Active"}`);
  console.log(`Max parallel: ${project.spec.maxParallel ?? 2}`);
  console.log(`Team: ${(project.spec.agents ?? []).map((a) => a.name).join(", ") || "(none)"}`);
  console.log();

  const columns = ["backlog", "ready", "in-progress", "review", "rework", "done", "blocked"];
  const colRows: string[][] = [["COLUMN", "TASKS"]];
  for (const col of columns) {
    const colTasks = tasks.filter((t) => (t.status?.column ?? "ready") === col);
    colRows.push([
      col,
      colTasks.length > 0
        ? colTasks.map((t) => `${t.metadata.name} (${t.spec.title})`).join(", ")
        : "(empty)",
    ]);
  }
  console.log(padCols(colRows));
  console.log();

  const running = tasks.filter((t) => t.status?.worker?.status === "Running");
  if (running.length > 0) {
    console.log("Active workers:");
    const workerRows: string[][] = [["TASK", "AGENT", "RUN", "RETRIES"]];
    for (const t of running) {
      const w = t.status!.worker!;
      workerRows.push([
        t.metadata.name,
        t.spec.agent ?? "-",
        w.runName ?? "-",
        String(w.retryCount ?? 0),
      ]);
    }
    console.log(padCols(workerRows));
    console.log();
  }

  const escalated = tasks.filter((t) => t.status?.worker?.status === "Escalated");
  if (escalated.length > 0) {
    console.log(`Escalations (${escalated.length}):`);
    for (const t of escalated) {
      console.log(`--- ${t.metadata.name} ---`);
      // Note: escalation field removed in new schema
      console.log("(escalation details no longer stored in worker status)");
      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// board task add

export interface BoardTaskAddOpts {
  namespace?: string;
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

  let project: Project;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal("get project failed", e);
  }

  const teamNames = (project.spec.agents ?? []).map((a) => a.name);
  if (!teamNames.includes(opts.agent)) {
    console.error(`beatctl: agent "${opts.agent}" is not in the project's agents list.`);
    console.error(`  Available agents: ${teamNames.join(", ") || "(none)"}`);
    process.exit(1);
  }

  // Generate a unique name for the task CR.
  const { randomBytes } = await import("node:crypto");
  const suffix = randomBytes(3).toString("hex");
  const taskName = `${projectName}-${opts.type.toLowerCase()}-${suffix}`;

  const task = buildTask({
    name: taskName,
    projectName,
    projectUid: project.metadata.uid!,
    ns,
    spec: {
      projectRef: projectName,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      agent: opts.agent,
      priority: opts.priority ?? "medium",
    },
  });

  // Set initial phase in status (defaults to pending).
  const initialPhase: TaskPhase = "pending";
  
  task.status = { phase: initialPhase };

  try {
    const created = await createTask(task, ns, custom);
    const column = computeBoardColumn(initialPhase);
    console.log(`task ${created.metadata.name} created in "${column}" (phase: ${initialPhase}) on project ${projectName}`);
    // Patch status subresource to set initial phase.
    await patchTaskStatus(created.metadata.name, { phase: initialPhase }, ns);
  } catch (e) {
    fatal("create task failed", e);
  }
}

// ---------------------------------------------------------------------------
// board task move

export interface BoardTaskMoveOpts {
  namespace?: string;
  taskName: string;
  to: string;
}

export async function runBoardTaskMove(
  projectName: string,
  opts: BoardTaskMoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  void projectName;

  try {
    await patchTaskStatus(opts.taskName, { column: opts.to as TaskColumn }, ns);
    console.log(`task ${opts.taskName} moved to "${opts.to}"`);
  } catch (e) {
    fatal("task move failed", e);
  }
}

// ---------------------------------------------------------------------------
// board task remove

export interface BoardTaskRemoveOpts {
  namespace?: string;
  taskName: string;
}

export async function runBoardTaskRemove(
  projectName: string,
  opts: BoardTaskRemoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();
  void projectName;
  void custom;

  try {
    await deleteTask(opts.taskName, ns);
    console.log(`task ${opts.taskName} deleted`);
  } catch (e) {
    fatal("delete task failed", e);
  }
}
