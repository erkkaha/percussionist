// routes/board.ts — board endpoints nested under projects.
//
// Tasks are now first-class Task CRs — state lives in K8s, not SQLite.
//
// Mounted at /api/projects (so :project param is accessible).
//
// GET    /api/projects/:project/board                         — board settings + task list grouped by column
// PATCH  /api/projects/:project/board/spec                    — patch project settings (maxParallel, agents, phase)
// POST   /api/projects/:project/board/tasks                   — create a new Task CR
// DELETE /api/projects/:project/board/tasks/:taskName         — delete an Task CR
// POST   /api/projects/:project/board/tasks/:taskName/approve — set approved annotation
// POST   /api/projects/:project/board/tasks/:taskName/request-changes

import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import {
  getProject,
  patchProjectSpec,
  patchProject,
  listTasks,
  deleteTask,
  createTask,
  patchTaskStatus,
  buildTask,
  NAMESPACE,
} from "../kube.js";
import { getDb, taskEvents } from "../db.js";
import type { TaskSpec } from "@percussionist/api";
import { createPollingSseResponse } from "../lib/sse.js";

const board = new Hono();

type KubeError = { statusCode?: number; body?: { message?: string }; message?: string };
function errStatus(e: KubeError) { return e.statusCode === 404 ? 404 : 500; }
function errMsg(e: KubeError) { return e.body?.message ?? e.message ?? String(e); }

// ---------------------------------------------------------------------------
// Helpers

function taskCRName(project: string, type: "PLAN" | "BUILD"): string {
  const suffix = randomBytes(3).toString("hex");
  return `${project}-${type.toLowerCase()}-${suffix}`;
}

export async function appendTaskEvent(
  project: string,
  taskName: string,
  taskType: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = getDb();
    db.insert(taskEvents).values({
      project,
      taskName,
      taskType,
      eventType,
      payload: JSON.stringify(payload),
    }).run();
  } catch {
    // Event logging is best-effort — never fail the main operation.
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:project/board

board.get("/:project/board", async (c) => {
  const name = c.req.param("project");
  try {
    const [project, tasks] = await Promise.all([
      getProject(name),
      listTasks(name),
    ]);

    // Group tasks by column.
    const columns: Record<string, unknown[]> = {};
    for (const task of tasks) {
      const col = task.status?.column ?? "ready";
      if (!columns[col]) columns[col] = [];
      columns[col]!.push(task);
    }

    const annotations = project.metadata.annotations ?? {};
    // Collect per-task approval annotations.
    const approvals: Record<string, { approved: boolean; requestChanges: boolean }> = {};
    for (const task of tasks) {
      const tn = task.metadata.name;
      approvals[tn] = {
        approved: annotations[`percussionist.dev/approved-${tn}`] === "true",
        requestChanges: annotations[`percussionist.dev/request-changes-${tn}`] === "true",
      };
    }

    const settings = {
      maxParallel: project.spec.maxParallel ?? 2,
      agents: project.spec.agents ?? [],
      phase: project.spec.phase ?? "Active",
    };

    return c.json({ settings, columns, approvals, status: project.status?.board ?? {} });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:project/board/events — SSE stream for board changes.

board.get("/:project/board/events", async (c) => {
  const name = c.req.param("project");

  try {
    await getProject(name);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }

  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const [project, tasks] = await Promise.all([
        getProject(name),
        listTasks(name),
      ]);
      const annotations = project.metadata.annotations ?? {};
      const taskApprovalAnnotations = Object.keys(annotations)
        .filter((k) =>
          k.startsWith("percussionist.dev/approved-") ||
          k.startsWith("percussionist.dev/request-changes-") ||
          k.startsWith("percussionist.dev/rework-"),
        )
        .sort()
        .map((k) => [k, annotations[k]]);

      // Include task resourceVersions so any task status change triggers an event.
      const taskVersions = tasks.map((t) => `${t.metadata.name}:${t.metadata.resourceVersion}`).join(",");

      return JSON.stringify({
        resourceVersion: project.metadata.resourceVersion,
        generation: project.metadata.generation,
        taskVersions,
        boardStatus: project.status?.board ?? {},
        taskApprovalAnnotations,
      });
    },
    updatedEvent: "board.updated",
    errorEvent: "board.error",
    readyEvent: { event: "ready", data: { project: name } },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/:project/board/spec — patch project settings.
// Body: Partial<{ maxParallel, agents, phase }>

board.patch("/:project/board/spec", async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  try {
    const updated = await patchProjectSpec(name, body as Parameters<typeof patchProjectSpec>[1]);
    return c.json({
      maxParallel: updated.spec.maxParallel,
      agents: updated.spec.agents,
      phase: updated.spec.phase,
    });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks — create a new Task CR.
// Body: { type, title, agent, description?, priority? }

board.post("/:project/board/tasks", async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const { type, title, description, agent, priority } = body as Partial<TaskSpec>;

  if (!type || !title || !agent) {
    return c.json({ error: "type, title, and agent are required" }, 400);
  }
  if (type !== "PLAN" && type !== "BUILD") {
    return c.json({ error: "Invalid task type. Must be PLAN or BUILD" }, 400);
  }

  try {
    const project = await getProject(name);
    const roster = (project.spec.agents ?? []).map((a) => a.name);
    if (!roster.includes(agent)) {
      return c.json({ error: `agent "${agent}" not in project roster: ${roster.join(", ") || "(empty)"}` }, 400);
    }

    const taskName = taskCRName(name, type);
    const ns = (project.metadata.namespace ?? NAMESPACE);

    const task = buildTask({
      name: taskName,
      projectName: name,
      projectUid: project.metadata.uid ?? "",
      ns,
      spec: {
        projectRef: name,
        type,
        title,
        description,
        agent,
        priority: priority ?? "medium",
      },
    });

    const created = await createTask(task, ns);
    await patchTaskStatus(taskName, { column: "ready" }, ns);
    await appendTaskEvent(name, taskName, type, "run.created", { title, agent, priority });

    return c.json({ task: created }, 201);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:project/board/tasks/:taskName

board.delete("/:project/board/tasks/:taskName", async (c) => {
  const projectName = c.req.param("project");
  const taskName = c.req.param("taskName");
  try {
    const project = await getProject(projectName);
    const ns = project.metadata.namespace ?? NAMESPACE;
    await deleteTask(taskName, ns);
    return c.body(null, 204);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/approve

board.post("/:project/board/tasks/:taskName/approve", async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  try {
    const project = await getProject(name);
    const currentAnnotations = project.metadata.annotations ?? {};
    await patchProject(name, {
      metadata: {
        annotations: {
          ...currentAnnotations,
          [`percussionist.dev/approved-${taskName}`]: "true",
          [`percussionist.dev/request-changes-${taskName}`]: "false",
        },
      },
    });
    await appendTaskEvent(name, taskName, "unknown", "approved", {});
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/request-changes

board.post("/:project/board/tasks/:taskName/request-changes", async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const { feedback } = body as { feedback?: string };
  if (!feedback?.trim()) {
    return c.json({ error: "Feedback is required" }, 400);
  }
  try {
    const project = await getProject(name);
    const currentAnnotations = project.metadata.annotations ?? {};
    await patchProject(name, {
      metadata: {
        annotations: {
          ...currentAnnotations,
          [`percussionist.dev/rework-${taskName}`]: feedback.trim(),
          [`percussionist.dev/request-changes-${taskName}`]: "true",
        },
      },
    });
    await appendTaskEvent(name, taskName, "unknown", "request-changes", { feedback: feedback.trim() });
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/task-events — internal endpoint for the
// manager controller to append task lifecycle events.
// Body: { taskName, taskType, eventType, payload? }

board.post("/:project/board/task-events", async (c) => {
  const project = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const { taskName, taskType, eventType, payload } = body as {
    taskName?: string;
    taskType?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
  };
  if (!taskName || !taskType || !eventType) {
    return c.json({ error: "taskName, taskType, and eventType are required" }, 400);
  }
  await appendTaskEvent(project, taskName, taskType, eventType, payload ?? {});
  return c.body(null, 204);
});

export default board;
