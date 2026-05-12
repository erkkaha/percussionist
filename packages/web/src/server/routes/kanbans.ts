import { Hono } from "hono";
import {
  listKanbans,
  getKanban,
  createKanban,
  updateKanban,
  patchKanbanStatus,
  deleteKanban,
} from "../kube.js";
import {
  OpenCodeKanbanSpecSchema,
  API_GROUP_VERSION,
  KIND_KANBAN,
} from "@percussionist/api";

const kanbans = new Hono();

// GET /api/kanbans
kanbans.get("/", async (c) => {
  try {
    const items = await listKanbans();
    return c.json({ items });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/kanbans/:name
kanbans.get("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const kanban = await getKanban(name);
    return c.json(kanban);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/kanbans
kanbans.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = OpenCodeKanbanSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  const name =
    (body as { name?: string }).name ??
    `kanban-${Date.now().toString(16)}`;

  const kanban = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_KANBAN,
    metadata: { name },
    spec,
  };

  try {
    const created = await createKanban(kanban as Parameters<typeof createKanban>[0]);
    return c.json(created, 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode ?? 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status as 400 | 409 | 500);
  }
});

// PUT /api/kanbans/:name
kanbans.put("/:name", async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = OpenCodeKanbanSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }

  try {
    const updated = await updateKanban(name, parsed.data);
    return c.json(updated);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// PATCH /api/kanbans/:name/status
kanbans.patch("/:name/status", async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Body must be an object" }, 400);
  }

  try {
    const updated = await patchKanbanStatus(name, body as Record<string, unknown>);
    return c.json(updated);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/kanbans/:name/tasks — add a task to the board
kanbans.post("/:name/tasks", async (c) => {
  const name = c.req.param("name");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Body must be an object" }, 400);
  }

  const task = (body as { task?: Record<string, unknown> }).task;
  if (!task || typeof task !== "object") {
    return c.json({ error: "Missing 'task' field in body" }, 400);
  }

  try {
    const kanban = await getKanban(name);
    if (!kanban) {
      return c.json({ error: `Kanban "${name}" not found` }, 404);
    }

    const specTasks = (kanban.spec?.tasks as Record<string, unknown>[] | undefined) ?? [];
    const taskId = (task as { id?: string }).id;
    if (!taskId || typeof taskId !== "string") {
      return c.json({ error: "Task must have an 'id' field" }, 400);
    }

    // Dedup by id — replace existing task with same id.
    const existingIdx = specTasks.findIndex((t) => (t.id as string) === taskId);
    if (existingIdx >= 0) {
      specTasks[existingIdx] = task as Record<string, unknown>;
    } else {
      specTasks.push(task as Record<string, unknown>);
    }

    return c.json(await updateKanban(name, { ...(kanban.spec ?? {}), tasks: specTasks as any }), 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status as 400 | 404 | 500);
  }
});

// DELETE /api/kanbans/:name
kanbans.delete("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await deleteKanban(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

export default kanbans;
