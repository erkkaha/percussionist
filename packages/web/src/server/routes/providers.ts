// routes/providers.ts — proxies opencode provider/model list from the manager's
// opencode-web sidecar.
//
// The manager's opencode sidecar runs on port 4096 inside the manager pod and
// is reachable via the percussionist-manager ClusterIP Service.

import { Hono } from "hono";
import { NAMESPACE } from "../kube.js";

const router = new Hono();

const MANAGER_OPENCODE_URL = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local:4096`;

// GET /api/providers — list all providers, connected status, and defaults.
router.get("/", async (c) => {
  try {
    const res = await fetch(`${MANAGER_OPENCODE_URL}/provider`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return c.json({ error: `opencode /provider returned ${res.status}` }, 502);
    }
    const data = await res.json();
    return c.json(data);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

export default router;
