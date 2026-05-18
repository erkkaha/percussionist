import { Hono } from "hono";
import { getRun, fetchSessionMessages, readSessionConfigMap } from "../kube.js";
import { OPENCODE_RUNNER_DEFAULTS } from "@percussionist/api";

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
    const messages = await fetchSessionMessages(serviceName, sessionID);
    return c.json({ sessionID, messages, source: "live" });
  } catch {
    // Live proxy failed — fall through to ConfigMap snapshot.
  }

  // 3. ConfigMap fallback.
  try {
    const snapshot = await readSessionConfigMap(name, sessionID);
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

// GET /api/runs/:name/session/events — proxy OpenCode SSE stream from the run service.
session.get("/:name/session/events", async (c) => {
  const name = c.req.param("name");

  let serviceName: string;
  let ns: string;
  try {
    const run = await getRun(name);
    serviceName = run.status?.serviceName ?? name;
    ns = run.metadata.namespace ?? "percussionist";
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return c.json({ error: anyE.body?.message ?? anyE.message ?? String(e) }, status);
  }

  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/event`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: c.req.raw.signal,
    });
  } catch (e) {
    return c.json({ error: `Failed to connect to event stream: ${(e as Error).message}` }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    return c.json({ error: `OpenCode event stream ${upstream.status}: ${body}` }, 502);
  }

  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "off");

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
});

export default session;
