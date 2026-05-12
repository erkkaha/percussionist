// `beatctl kanban` — manage OpenCodeKanban boards (kanban-style task tracking).
//
// Subcommands:
//   list          — list all kanban boards in a namespace
//   get <name>    — show details of a board
//   create        — create from flags or YAML file
//   delete <name> — delete a board (cascades to child runs)
//   task add      — add a task to the board
//   task move     — move a task between columns
//   task remove   — remove a task from the board

import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  API_GROUP_VERSION,
  KIND_KANBAN,
  OpenCodeKanbanSchema,
  type OpenCodeKanban,
} from "@percussionist/api";
import {
  DEFAULT_NAMESPACE,
  age,
  createKanban,
  deleteKanban,
  fatal,
  getKanban,
  listKanbans,
  loadKube,
  padCols,
  patchKanban,
} from "./kube.js";

// ---------------------------------------------------------------------------
// kanban list

export interface KanbanListOpts {
  namespace?: string;
}

export async function runKanbanList(opts: KanbanListOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  let items: OpenCodeKanban[];
  try {
    items = await listKanbans(custom, ns);
  } catch (e) {
    fatal("list kanbans failed", e);
  }
  if (items.length === 0) {
    console.log(`No kanban boards in namespace ${ns}.`);
    return;
  }
  const rows: string[][] = [
    ["NAME", "PHASE", "READY", "ACTIVE", "MAX", "AGE"],
  ];
  for (const k of items) {
    const backlog = k.status?.backlog ?? {};
    const readyCount = (backlog.ready ?? []).length;
    const activeWorkers = k.status?.activeWorkers ?? 0;
    rows.push([
      k.metadata.name,
      k.spec.phase ?? "-",
      String(readyCount),
      String(activeWorkers),
      String(k.spec.maxParallel),
      age(k.metadata.creationTimestamp),
    ]);
  }
  console.log(padCols(rows));
}

// ---------------------------------------------------------------------------
// kanban get

export interface KanbanGetOpts {
  namespace?: string;
  output?: "yaml" | "json";
}

export async function runKanbanGet(
  name: string,
  opts: KanbanGetOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  let kanban: OpenCodeKanban;
  try {
    kanban = await getKanban(custom, ns, name);
  } catch (e) {
    fatal("get kanban failed", e);
  }

  if (opts.output === "json") {
    console.log(JSON.stringify(kanban, null, 2));
    return;
  }

  // Pretty-print the board state.
  const backlog = kanban.status?.backlog ?? {};
  const columns = kanban.status?.columns ?? ["ready", "in-progress", "review", "rework", "done"];
  const workers = kanban.status?.workers ?? [];

  console.log(`Board: ${kanban.metadata.name}`);
  console.log(`Phase: ${kanban.spec.phase}`);
  console.log(`Max parallel: ${kanban.spec.maxParallel}`);
  if (kanban.spec.source?.git?.url) {
    console.log(`Git: ${kanban.spec.source.git.url}${kanban.spec.source.git.ref ? `@${kanban.spec.source.git.ref}` : ""}`);
  }
  console.log();

  // Print columns as a table.
  const colRows: string[][] = [["COLUMN", "TASKS"]];
  for (const col of columns) {
    const tasks = backlog[col] ?? [];
    if (tasks.length > 0) {
      colRows.push([col, tasks.join(", ")]);
    } else {
      colRows.push([col, "(empty)"]);
    }
  }
  console.log(padCols(colRows));
  console.log();

  // Print active workers.
  const runningWorkers = workers.filter((w) => w.status === "Running");
  if (runningWorkers.length > 0) {
    console.log("Active workers:");
    const workerRows: string[][] = [["TASK", "RUN NAME", "STATUS", "RETRIES"]];
    for (const w of runningWorkers) {
      workerRows.push([
        w.taskId,
        w.runName ?? "-",
        w.status,
        String(w.retryCount ?? 0),
      ]);
    }
    console.log(padCols(workerRows));
    console.log();
  }

  // Print escalations.
  const escalated = workers.filter((w) => w.status === "Escalated");
  if (escalated.length > 0) {
    console.log(`Escalations (${escalated.length}):`);
    for (const e of escalated) {
      console.log(`--- ${e.taskId} ---`);
      console.log(e.escalation ?? "(no details)");
      console.log();
    }
  }

  // Print full CR as YAML at the end for programmatic use.
  if (opts.output === "yaml") {
    console.log("---");
    console.log(YAML.stringify(kanban));
  }
}

// ---------------------------------------------------------------------------
// kanban create

export interface KanbanCreateOpts {
  name?: string;
  namespace?: string;
  file?: string;
  displayName?: string;
  gitUrl?: string;
  gitRef?: string;
  gitSshSecret?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  maxParallel?: number;
  model?: string;
  dryRun?: boolean;
}

function buildKanbanFromFlags(opts: KanbanCreateOpts): OpenCodeKanban {
  if (!opts.name) {
    throw new Error("--name is required when --file is not supplied");
  }
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const raw: unknown = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_KANBAN,
    metadata: { name: opts.name, namespace: ns },
    spec: {
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
      ...(opts.model ? { defaults: { model: opts.model } } : {}),
      ...(opts.gitUrl
        ? {
            source: {
              git: {
                url: opts.gitUrl,
                ...(opts.gitRef ? { ref: opts.gitRef } : {}),
                ...(opts.gitSshSecret
                  ? { sshSecret: { name: opts.gitSshSecret } }
                  : {}),
                ...(opts.gitAuthorName && opts.gitAuthorEmail
                  ? {
                      author: {
                        name: opts.gitAuthorName,
                        email: opts.gitAuthorEmail,
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    },
  };
  return OpenCodeKanbanSchema.parse(raw);
}

function buildKanbanFromFile(
  path: string,
  opts: KanbanCreateOpts,
): OpenCodeKanban {
  const doc = YAML.parse(readFileSync(path, "utf8"));
  if (opts.name) doc.metadata = { ...(doc.metadata ?? {}), name: opts.name };
  if (opts.namespace) {
    doc.metadata = { ...(doc.metadata ?? {}), namespace: opts.namespace };
  }
  return OpenCodeKanbanSchema.parse(doc);
}

export async function runKanbanCreate(opts: KanbanCreateOpts): Promise<void> {
  let kanban: OpenCodeKanban;
  try {
    kanban = opts.file
      ? buildKanbanFromFile(opts.file, opts)
      : buildKanbanFromFlags(opts);
  } catch (e) {
    fatal("invalid kanban spec", e);
  }
  const ns = kanban.metadata.namespace ?? DEFAULT_NAMESPACE;
  kanban.metadata.namespace = ns;

  if (opts.dryRun) {
    console.log(YAML.stringify(kanban));
    return;
  }

  const { custom } = loadKube();
  try {
    const created = await createKanban(custom, ns, kanban);
    console.log(
      `kanban ${created.metadata.name} created in namespace ${ns}`,
    );
  } catch (e) {
    fatal("create kanban failed", e);
  }
}

// ---------------------------------------------------------------------------
// kanban delete

export interface KanbanDeleteOpts {
  namespace?: string;
}

export async function runKanbanDelete(
  name: string,
  opts: KanbanDeleteOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();
  try {
    await deleteKanban(custom, ns, name);
    console.log(`kanban ${name} deleted from namespace ${ns}`);
  } catch (e) {
    fatal("delete kanban failed", e);
  }
}

// ---------------------------------------------------------------------------
// kanban task add

export interface KanbanTaskAddOpts {
  namespace?: string;
  id: string;
  title: string;
  description?: string;
  priority?: "high" | "medium" | "low";
  column?: string;
}

export async function runKanbanTaskAdd(
  kanbanName: string,
  opts: KanbanTaskAddOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  let kanban: OpenCodeKanban;
  try {
    kanban = await getKanban(custom, ns, kanbanName);
  } catch (e) {
    fatal("get kanban failed", e);
  }

  // Build the patch body to add a task.
  const backlog = kanban.status?.backlog ?? {};
  const column = opts.column ?? "ready";
  if (!backlog[column]) backlog[column] = [];
  (backlog[column] as string[]).push(opts.id);

  // Also add the task definition to spec.tasks if not already present.
  const tasks = kanban.spec.tasks ?? [];
  const existingIdx = tasks.findIndex((t) => t.id === opts.id);
  if (existingIdx < 0) {
    tasks.push({
      id: opts.id,
      title: opts.title,
      description: opts.description,
      priority: opts.priority ?? "medium",
    });
  }

  const patchBody = {
    status: { backlog },
    spec: { tasks },
  };

  try {
    await patchKanban(custom, ns, kanbanName, patchBody);
    console.log(`task ${opts.id} added to "${column}" on kanban ${kanbanName}`);
  } catch (e) {
    fatal("patch kanban failed", e);
  }
}

// ---------------------------------------------------------------------------
// kanban task move

export interface KanbanTaskMoveOpts {
  namespace?: string;
  taskId: string;
  to: string;
}

export async function runKanbanTaskMove(
  kanbanName: string,
  opts: KanbanTaskMoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  let kanban: OpenCodeKanban;
  try {
    kanban = await getKanban(custom, ns, kanbanName);
  } catch (e) {
    fatal("get kanban failed", e);
  }

  const backlog = kanban.status?.backlog ?? {};

  // Remove from all columns first.
  for (const col of Object.keys(backlog)) {
    if ((backlog[col] as string[]).includes(opts.taskId)) {
      (backlog[col] as string[]) = (backlog[col] as string[]).filter(
        (id) => id !== opts.taskId,
      );
    }
  }

  // Add to target column.
  if (!backlog[opts.to]) backlog[opts.to] = [];
  (backlog[opts.to] as string[]).push(opts.taskId);

  const patchBody = { status: { backlog } };

  try {
    await patchKanban(custom, ns, kanbanName, patchBody);
    console.log(`task ${opts.taskId} moved to "${opts.to}" on kanban ${kanbanName}`);
  } catch (e) {
    fatal("patch kanban failed", e);
  }
}

// ---------------------------------------------------------------------------
// kanban task remove

export interface KanbanTaskRemoveOpts {
  namespace?: string;
  taskId: string;
}

export async function runKanbanTaskRemove(
  kanbanName: string,
  opts: KanbanTaskRemoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const { custom } = loadKube();

  let kanban: OpenCodeKanban;
  try {
    kanban = await getKanban(custom, ns, kanbanName);
  } catch (e) {
    fatal("get kanban failed", e);
  }

  const backlog = kanban.status?.backlog ?? {};

  // Remove from all columns.
  for (const col of Object.keys(backlog)) {
    if ((backlog[col] as string[]).includes(opts.taskId)) {
      (backlog[col] as string[]) = (backlog[col] as string[]).filter(
        (id) => id !== opts.taskId,
      );
    }
  }

  // Remove from spec.tasks.
  const tasks = kanban.spec.tasks ?? [];
  kanban.spec.tasks = tasks.filter((t) => t.id !== opts.taskId);

  const patchBody = { status: { backlog }, spec: { tasks: kanban.spec.tasks } };

  try {
    await patchKanban(custom, ns, kanbanName, patchBody);
    console.log(`task ${opts.taskId} removed from kanban ${kanbanName}`);
  } catch (e) {
    fatal("patch kanban failed", e);
  }
}
