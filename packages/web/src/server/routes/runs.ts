import { Hono } from "hono";
import { listRuns, getRun } from "../kube.js";

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

export default runs;
