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
import { computeBoardColumn } from "@percussionist/api";
import {
  getProject,
  patchProjectSpec,
  listTasks,
  getTask,
  deleteTask,
  createTask,
  patchTask,
  patchTaskStatus,
  buildTask,
  NAMESPACE,
} from "../kube.js";
import { getDb, taskEvents } from "../db.js";
import type { TaskSpec, TaskPhase } from "@percussionist/api";
import { createPollingSseResponse } from "../lib/sse.js";
import { auth, adminAuth } from "../auth.js";

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
      createdAt: new Date().toISOString(),
    }).run();
  } catch {
    // Event logging is best-effort — never fail the main operation.
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:project/board
board.get("/:project/board", auth(), async (c) => {
  const name = c.req.param("project");
  try {
    const [project, tasks] = await Promise.all([
      getProject(name),
      listTasks(name),
    ]);

    // Build a map of child progress for PLAN tasks in awaiting-children phase.
    const childProgressMap = new Map<string, { total: number; completed: number; childRefs: string[] }>();
    for (const task of tasks) {
      if (task.spec.type === "PLAN" && task.status?.phase === "awaiting-children") {
        const taskName = task.metadata.name;
        const children = tasks.filter(
          (t) => t.spec.type === "BUILD" && t.spec.parentTaskRef === taskName,
        );
        const completed = children.filter((t) => t.status?.phase === "done").length;
        childProgressMap.set(taskName, {
          total: children.length,
          completed,
          childRefs: children.map((t) => t.metadata.name),
        });
      }
    }

    // Group tasks by board column derived from phase (authoritative).
    const columns: Record<string, unknown[]> = {};
    for (const task of tasks) {
      const phase = task.status?.phase ?? "pending";
      let col: string;
      if (task.status?.blocked) {
        col = "blocked";
      } else {
        col = computeBoardColumn(phase);
        // Override to blocked if waiting for a predecessor that isn't done.
        const predRef = task.spec.predecessorRef;
        if (predRef && phase !== "done") {
          const pred = tasks.find((t) => t.metadata.name === predRef);
          if (!pred || pred.status?.phase !== "done") {
            col = "blocked";
            task.status = { ...task.status, blockedReason: `Waiting for: ${predRef}` };
          }
        }
      }
      if (!columns[col]) columns[col] = [];
      
      // Attach child progress if available.
      const taskWithProgress = {
        ...task,
        childProgress: childProgressMap.get(task.metadata.name),
      };
      columns[col]!.push(taskWithProgress);
    }

    // Collect per-task approval annotations from task metadata.
    const approvals: Record<string, { approved: boolean; requestChanges: boolean }> = {};
    for (const task of tasks) {
      const taskAnnotations = task.metadata.annotations ?? {};
      approvals[task.metadata.name] = {
        approved: taskAnnotations["percussionist.dev/action-approved"] === "true",
        requestChanges: taskAnnotations["percussionist.dev/action-request-changes"] === "true",
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
board.get("/:project/board/events", auth(), async (c) => {
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
      // Collect task annotations for change detection.
      const taskApprovalAnnotations: [string, string][] = [];
      for (const task of tasks) {
        const taskAnnotations = task.metadata.annotations ?? {};
        for (const key of Object.keys(taskAnnotations)) {
          if (key.startsWith("percussionist.dev/action-")) {
            taskApprovalAnnotations.push([key, taskAnnotations[key] ?? ""]);
          }
        }
      }
      taskApprovalAnnotations.sort((a, b) => a[0].localeCompare(b[0]));

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
board.patch("/:project/board/spec", adminAuth(), async (c) => {
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
board.post("/:project/board/tasks", adminAuth(), async (c) => {
  const name = c.req.param("project");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const { type, title, description, agent, priority } = body as Partial<TaskSpec> & { column?: string };
  const { column: targetColumn } = body as { column?: string };

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

    // If the caller specified ideas column, patch status to phase=idea immediately.
    if (targetColumn === "ideas") {
      await patchTaskStatus(taskName, { phase: "idea" }, ns);
    }

    await appendTaskEvent(name, taskName, type, "run.created", { title, agent, priority });

    return c.json({ task: created }, 201);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:project/board/tasks/:taskName

board.delete("/:project/board/tasks/:taskName", adminAuth(), async (c) => {
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
// POST /api/projects/:project/board/tasks/:taskName/move
//
// Body: { column: string }
// Resets a failed/escalated task back to "pending" phase so the reconciler
// picks it up again. "column" in the body is accepted for API compatibility
// but only "ready"/"pending" makes sense here — anything else is rejected.

board.post("/:project/board/tasks/:taskName/move", adminAuth(), async (c) => {
  const projectName = c.req.param("project");
  const taskName = c.req.param("taskName");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const { column } = body as { column?: string };
  if (!column?.trim()) return c.json({ error: "column is required" }, 400);

  // Supported target columns and the phase they map to.
  const columnPhaseMap: Record<string, TaskPhase> = {
    ready: "pending",
    pending: "pending",
    backlog: "pending",
    ideas: "idea",
  };
  if (!(column in columnPhaseMap)) {
    return c.json({ error: `Unsupported target column: ${column}. Supported: ready, backlog, ideas.` }, 400);
  }

  try {
    const project = await getProject(projectName);
    const ns = project.metadata.namespace ?? NAMESPACE;
    const targetPhase = columnPhaseMap[column]!;
    const patch: Record<string, unknown> = { phase: targetPhase, blocked: false };

    // When resetting to backlog/pending, increment retryCount so the
    // reconciler generates a new unique run name (workerRunName hashes
    // retryCount into the name), preserving the old failed Run and its history.
    const resetTargets = ["ready", "pending", "backlog"];
    if (resetTargets.includes(column)) {
      const task = await getTask(taskName, ns);
      const currentRetryCount = task.status?.worker?.retryCount ?? 0;
      patch.worker = { retryCount: currentRetryCount + 1 };
    }

    await patchTaskStatus(taskName, patch as never, ns);
    await appendTaskEvent(projectName, taskName, "unknown", "moved", { column });
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/approve

board.post("/:project/board/tasks/:taskName/approve", adminAuth(), async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  try {
    // Write approval as Task annotation (new format).
    const task = await getTask(taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(taskName, {
      metadata: {
        ...task.metadata,
        annotations: {
          ...currentAnnotations,
          "percussionist.dev/action-approved": "true",
          "percussionist.dev/action-request-changes": "false",
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

board.post("/:project/board/tasks/:taskName/request-changes", adminAuth(), async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const { feedback } = body as { feedback?: string };
  if (!feedback?.trim()) {
    return c.json({ error: "Feedback is required" }, 400);
  }
  try {
    // Write rework as Task annotation (new format).
    const task = await getTask(taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(taskName, {
      metadata: {
        ...task.metadata,
        annotations: {
          ...currentAnnotations,
          "percussionist.dev/action-request-changes": "true",
          "percussionist.dev/action-rework-feedback": feedback.trim(),
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
// POST /api/projects/:project/board/tasks/:taskName/abandon

board.post("/:project/board/tasks/:taskName/abandon", adminAuth(), async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  try {
    // Write abandon as Task annotation (new format).
    const task = await getTask(taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(taskName, {
      metadata: {
        ...task.metadata,
        annotations: {
          ...currentAnnotations,
          "percussionist.dev/action-abandon": "true",
        },
      },
    });
    await appendTaskEvent(name, taskName, "unknown", "abandoned", {});
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/answer

board.post("/:project/board/tasks/:taskName/answer", adminAuth(), async (c) => {
  const name = c.req.param("project");
  const taskName = c.req.param("taskName");
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const { answer } = body as { answer?: string };
  if (!answer?.trim()) {
    return c.json({ error: "Answer is required" }, 400);
  }
  try {
    // Answer is written as a Task annotation (not Project).
    const task = await getTask(taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(taskName, {
      metadata: {
        ...task.metadata,
        annotations: {
          ...currentAnnotations,
          "percussionist.dev/action-answer": answer.trim(),
        },
      },
    });
    await appendTaskEvent(name, taskName, "PLAN", "answered", { answer: answer.trim() });
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

board.post("/:project/board/task-events", adminAuth(), async (c) => {
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
