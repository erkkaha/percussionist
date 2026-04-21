import { Hono } from "hono";
import { getRun, readPodLog } from "../kube.js";
import { RUNNER_CONTAINER, DISPATCHER_CONTAINER } from "@percussionist/api";

const VALID_CONTAINERS = new Set([RUNNER_CONTAINER, DISPATCHER_CONTAINER]);
const DEFAULT_TAIL = 500;

const logs = new Hono();

// GET /api/runs/:name/logs?container=opencode&tailLines=500
logs.get("/:name/logs", async (c) => {
  const name = c.req.param("name");
  const container = c.req.query("container") ?? RUNNER_CONTAINER;
  const tailParam = c.req.query("tailLines");
  const tailLines = tailParam ? parseInt(tailParam, 10) : DEFAULT_TAIL;

  if (!VALID_CONTAINERS.has(container)) {
    return c.json(
      { error: `Invalid container: ${container}. Must be one of: ${[...VALID_CONTAINERS].join(", ")}` },
      400,
    );
  }

  // Resolve podName from the run's status (or fall back to the run name).
  let podName: string;
  try {
    const run = await getRun(name);
    podName = run.status?.podName ?? name;
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }

  try {
    const text = await readPodLog(podName, container, tailLines || undefined);
    return c.json({ podName, container, lines: text });
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    // Pod may not exist yet or container may not have started.
    const status = anyE.statusCode === 404 ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

export default logs;
