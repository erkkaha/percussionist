import { Hono } from "hono";
import { getRun, readAuthPassword, fetchSessionMessages, readSessionConfigMap } from "../kube.js";

const session = new Hono();

// GET /api/runs/:name/session — proxy session messages from the OpenCode API
// running inside the run's pod, with ConfigMap snapshot fallback.
//
// Strategy:
//   1. Try the live proxy to the OpenCode server inside the run pod.
//   2. If that fails (pod deleted, network error, etc), read the session
//      snapshot from the ConfigMap the dispatcher wrote before exiting.
//   3. If neither works, return an appropriate error.
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

  // 2. Try live proxy first.
  try {
    const password = await readAuthPassword(name);
    const messages = await fetchSessionMessages(serviceName, sessionID, password);
    return c.json({ sessionID, messages, source: "live" });
  } catch {
    // Live proxy failed — fall through to ConfigMap snapshot.
  }

  // 3. ConfigMap fallback.
  try {
    const snapshot = await readSessionConfigMap(name);
    if (snapshot) {
      return c.json({
        sessionID,
        messages: snapshot.messages,
        source: "snapshot",
        truncated: snapshot.truncated,
      });
    }
  } catch {
    // ConfigMap read also failed — fall through to error.
  }

  return c.json(
    { error: "Session unavailable: live proxy failed and no snapshot exists" },
    502,
  );
});

export default session;
