import { Hono } from "hono";
import { listRuns, getRun, createRun, deleteRun, postSessionMessage, listKanbans, patchKanbanStatus } from "../kube.js";
import {
  OpenCodeRunSpecSchema,
  API_GROUP_VERSION,
  KIND_RUN,
} from "@percussionist/api";

const runs = new Hono();

// GET /api/runs — list all OpenCodeRuns in the namespace.
runs.get("/", async (c) => {
  try {
    const items = await listRuns();
    return c.json({ items });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/runs/:name — get a single OpenCodeRun by name.
runs.get("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const run = await getRun(name);
    return c.json(run);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/runs — create a new OpenCodeRun.
// Body: OpenCodeRunSpec fields (task, model, agent, interactive, source,
// timeoutSeconds). Name is optional; auto-generated when absent.
runs.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate spec fields.
  const parsed = OpenCodeRunSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  // Auto-generate a name (same scheme as beatctl submit).
  const name =
    (body as { name?: string }).name ??
    `run-${Date.now().toString(16)}`;

  const run = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: { name },
    spec,
  };

  try {
    const created = await createRun(run as Parameters<typeof createRun>[0]);
    return c.json(created, 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode ?? 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status as 400 | 409 | 500);
  }
});

// DELETE /api/runs/:name — delete (cancel) a run and all its child resources.
runs.delete("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await deleteRun(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/runs/:name/reply — human answers a worker's pending question.
runs.post("/:name/reply", async (c) => {
  const runName = c.req.param("name");

  let run: import("@percussionist/api").OpenCodeRun;
  try { run = await getRun(runName); } catch { return c.json({ error: "Run not found" }, 404); }

  const serviceName = (run as any).status?.serviceName;
  if (!serviceName || !(run as any).status?.sessionID) {
    return c.json({ error: "No active session for this run" }, 400);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const textBody = body as { message?: string };
  if (!textBody?.message || typeof textBody.message !== "string") {
    return c.json({ error: "Missing 'message' field (human reply text)" }, 400);
  }

  try {
    await postSessionMessage(serviceName, (run as any).status.sessionID, textBody.message);
    
    // Clear this question from kanban pendingQuestions for immediate UI feedback.
    const match = runName.match(/^kanban-[^-]+-(.+?)-/s);
    if (match) {
      const taskId = match[1];
      try {
        const allKanbans = await listKanbans();
        for (const kb of allKanbans) {
          const qs = (kb as any).status?.pendingQuestions ?? [];
          let changed = false;
          const filtered = qs.filter((q: Record<string, unknown>) => q.workerId !== taskId);
          if (filtered.length < qs.length) {
            await patchKanbanStatus(kb.metadata.name!, { pendingQuestions: filtered });
            console.log(`Cleared question for ${taskId} from kanban ${kb.metadata.name}`);
            changed = true;
          }
        }
      } catch {} // best-effort, manager will clear on next reconcile anyway
        
    }

    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("reply failed:", msg);
    return c.json({ error: `Failed to forward reply: ${msg}` }, 502);
  }
});

export default runs;