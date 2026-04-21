import { Hono } from "hono";
import { getRun, readAuthPassword, fetchSessionMessages } from "../kube.js";

const session = new Hono();

// GET /api/runs/:name/session — proxy session messages from the OpenCode API
// running inside the run's pod.
session.get("/:name/session", async (c) => {
  const name = c.req.param("name");

  // 1. Get the run to find serviceName + sessionID.
  let serviceName: string;
  let sessionID: string;
  try {
    const run = await getRun(name);
    serviceName = run.status?.serviceName ?? name;
    sessionID = run.status?.sessionID ?? "";
    if (!sessionID) {
      return c.json({ error: "Run has no session ID yet (still initializing?)" }, 404);
    }
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }

  // 2. Read the auth password from the per-run Secret.
  let password: string;
  try {
    password = await readAuthPassword(name);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    if (anyE.statusCode === 404) {
      return c.json({ error: "Auth secret not found (run may have been cleaned up)" }, 404);
    }
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, 500);
  }

  // 3. Fetch messages from the OpenCode API inside the pod.
  try {
    const messages = await fetchSessionMessages(serviceName, sessionID, password);
    return c.json({ sessionID, messages });
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message ?? String(e) }, 502);
  }
});

export default session;
