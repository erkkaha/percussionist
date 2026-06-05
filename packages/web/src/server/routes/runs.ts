import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { listRuns, getRun, createRun, deleteRun, postSessionMessage } from "../kube.js";
import { createPollingSseResponse } from "../lib/sse.js";
import {
  RunSpecSchema,
  API_GROUP_VERSION,
  KIND_RUN,
} from "@percussionist/api";

const runs = new Hono();

// GET /api/runs — list all Runs in the namespace.
// Optional query param: ?task=<taskName> to filter by task CR name.
runs.get("/", async (c) => {
  try {
    const taskFilter = c.req.query("task");
    let items = await listRuns();
    if (taskFilter) {
      items = items.filter((r) => r.spec.boardTask === taskFilter);
    }
    return c.json({ items });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/runs/events — SSE stream for run list changes.
runs.get("/events", async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => JSON.stringify((await listRuns()).map((r) => ({
      resourceVersion: r.metadata.resourceVersion,
      generation: r.metadata.generation,
      name: r.metadata.name,
      namespace: r.metadata.namespace,
      phase: r.status?.phase,
      completedAt: r.status?.completedAt,
      startedAt: r.status?.startedAt,
      sessionID: r.status?.sessionID,
      tokensIn: r.status?.tokensIn,
      tokensOut: r.status?.tokensOut,
      lastEventAt: r.status?.lastEventAt,
      message: r.status?.message,
    }))),
    updatedEvent: "runs.updated",
    errorEvent: "runs.error",
    readyEvent: { event: "ready", data: { collection: "runs" } },
  });
});

// GET /api/runs/:name — get a single Run by name.
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

// POST /api/runs — create a new Run.
// Body: RunSpec fields (task, model, agent, interactive, source,
// timeoutSeconds). Name is optional; auto-generated when absent.
runs.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate spec fields.
  const parsed = RunSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  }
  const spec = parsed.data;

  // Auto-generate a name with crypto-random suffix to avoid collisions under concurrent submits.
  const name =
    (body as { name?: string }).name ??
    `run-${randomBytes(5).toString("hex")}`;

  const run = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name,
      labels: { "percussionist.dev/project": spec.project },
    },
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

  let run: import("@percussionist/api").Run;
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
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("reply failed:", msg);
    return c.json({ error: `Failed to forward reply: ${msg}` }, 502);
  }
});

export default runs;
