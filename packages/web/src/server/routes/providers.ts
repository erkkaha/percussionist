// routes/providers.ts — fetches available LLM providers/models by invoking the
// manager's list_models MCP tool on port 4097.
//
// Port 4096 (opencode sidecar) is not exposed on the manager Service, but
// port 4097 (MCP) is. We call list_models via JSON-RPC 2.0 directly.

import { Hono } from "hono";
import { NAMESPACE } from "../kube.js";

const router = new Hono();

const MANAGER_MCP_URL = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local:4097/mcp`;

// GET /api/providers — list all providers, connected status, and defaults.
router.get("/", async (c) => {
  try {
    const res = await fetch(MANAGER_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_models", arguments: {} },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return c.json({ error: `MCP returned ${res.status}` }, 502);
    }

    const rpc = (await res.json()) as {
      result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (rpc.error) {
      return c.json({ error: rpc.error.message ?? "MCP error" }, 502);
    }

    const text = rpc.result?.content?.find((p) => p.type === "text")?.text;
    if (!text) {
      return c.json({ error: "empty response from list_models" }, 502);
    }

    if (rpc.result?.isError) {
      return c.json({ error: text }, 502);
    }

    const data = JSON.parse(text) as unknown;
    return c.json(data);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

export default router;
