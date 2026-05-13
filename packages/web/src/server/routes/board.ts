// routes/board.ts — board endpoints nested under projects.
//
// Mounted at /api/projects (so :project param is accessible).
//
// GET    /api/projects/:project/board          — get board spec + status
// PATCH  /api/projects/:project/board/spec     — patch spec.board (add/remove tasks, agents)
// PATCH  /api/projects/:project/board/status   — patch status.board (backlog, workers)
// POST   /api/projects/:project/board/tasks    — add a task (validates agent in roster)
// DELETE /api/projects/:project/board/tasks/:id — remove a task

import { Hono } from "hono";
import { getProject, patchProjectSpec, patchProjectStatus } from "../kube.js";
import type { BoardTask, BoardSpec, BoardStatus } from "@percussionist/api";

const board = new Hono();

type KubeError = { statusCode?: number; body?: { message?: string }; message?: string };
function errStatus(e: KubeError) { return e.statusCode === 404 ? 404 : 500; }
function errMsg(e: KubeError) { return e.body?.message ?? e.message ?? String(e); }

// GET /api/projects/:project/board
board.get("/:project/board", async (c) => {
  const name = c.req.param("project");
  try {
    const project = await getProject(name);
    const spec: BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
    const status: Partial<BoardStatus> = project.status?.board ?? {};

    // Reconcile: any task in spec.tasks that isn't in any backlog column gets
    // placed into "ready". This repairs boards where the status patch failed
    // (e.g. due to a previous RBAC gap) without losing task data.
    const specTaskIds = new Set((spec.tasks ?? []).map((t: BoardTask) => t.id));
    const backlog: Record<string, string[]> = { ...(status.backlog ?? {}) };
    const placedIds = new Set(Object.values(backlog).flat());
    const unplaced = [...specTaskIds].filter((id) => !placedIds.has(id));
    if (unplaced.length > 0) {
      backlog["ready"] = [...(backlog["ready"] ?? []), ...unplaced];
      // Persist the repaired backlog so future reads are consistent.
      patchProjectStatus(name, { board: { ...status, backlog } }).catch(() => {});
    }

    return c.json({ spec, status: { ...status, backlog } });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// PATCH /api/projects/:project/board/spec
// Body: Partial<OpenCodeProject["spec"]["board"]>
board.patch("/:project/board/spec", async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  try {
    const project = await getProject(name);
    const board = await patchProjectSpec(name, {
      board: { ...(project.spec.board ?? { maxParallel: 2, phase: "Active" as const }), ...(body as object) },
    });
    return c.json(board.spec.board ?? {});
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// PATCH /api/projects/:project/board/status
// Body: Partial<BoardStatus>
board.patch("/:project/board/status", async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  try {
    const updated = await patchProjectStatus(name, { board: body as never });
    return c.json(updated.status?.board ?? {});
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// POST /api/projects/:project/board/tasks
// Body: BoardTask (id, title, agent, description?, priority?)
board.post("/:project/board/tasks", async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const task = body as BoardTask;
  if (!task.id || !task.title || !task.agent) {
    return c.json({ error: "id, title, and agent are required" }, 400);
  }
  try {
    const project = await getProject(name);
    const boardSpec: BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
    const roster = (boardSpec.agents ?? []).map((a) => a.name);
    if (!roster.includes(task.agent)) {
      return c.json({ error: `agent "${task.agent}" not in board roster: ${roster.join(", ") || "(empty)"}` }, 400);
    }
    const tasks = boardSpec.tasks ?? [];
    if (tasks.find((t) => t.id === task.id)) {
      return c.json({ error: `task "${task.id}" already exists` }, 409);
    }
    tasks.push(task);
    await patchProjectSpec(name, { board: { ...boardSpec, tasks } });

    // Add to status backlog.
    const boardStatus = project.status?.board ?? { columns: ["ready", "in-progress", "review", "rework", "done"], backlog: {}, workers: [], activeWorkers: 0 };
    const backlog = { ...boardStatus.backlog };
    const col = "ready";
    if (!backlog[col]) backlog[col] = [];
    backlog[col]!.push(task.id);
    await patchProjectStatus(name, { board: { ...boardStatus, backlog } });

    return c.json({ task }, 201);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// DELETE /api/projects/:project/board/tasks/:id
board.delete("/:project/board/tasks/:id", async (c) => {
  const name = c.req.param("project");
  const taskId = c.req.param("id");
  try {
    const project = await getProject(name);
    const boardSpec: BoardSpec = project.spec.board ?? { maxParallel: 2, phase: "Active" };
    const tasks = (boardSpec.tasks ?? []).filter((t) => t.id !== taskId);
    await patchProjectSpec(name, { board: { ...boardSpec, tasks } });

    const boardStatus = project.status?.board ?? { columns: [], backlog: {}, workers: [], activeWorkers: 0 };
    const backlog = { ...boardStatus.backlog };
    for (const col of Object.keys(backlog)) {
      backlog[col] = (backlog[col] ?? []).filter((id) => id !== taskId);
    }
    await patchProjectStatus(name, { board: { ...boardStatus, backlog } });

    return c.body(null, 204);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

export default board;
