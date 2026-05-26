// routes/upgrade.ts — Version check API.
//
// Proxies to the manager's MCP tool `check_for_updates` which reads the
// current running image tags from live deployments and queries GHCR for the
// latest available semver release.

import { Hono } from "hono";
import { NAMESPACE } from "../kube.js";

const router = new Hono();

const MANAGER_SERVICE = `http://percussionist-manager.${NAMESPACE}.svc.cluster.local`;
const MCP_URL = `${MANAGER_SERVICE}:4097/mcp`;

export interface UpdateStatus {
  current: {
    operator: string | null;
    manager: string | null;
    web: string | null;
  };
  latest: string | null;
  updateAvailable: boolean;
  registryPrefix?: string;
  error?: string;
}

// GET /api/upgrade/status
//
// Returns the currently running component versions and the latest available
// version from the container registry. Suitable for polling from the UI.
router.get("/status", async (c) => {
  const mcpRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "check_for_updates",
      arguments: {},
    },
  };

  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpRequest),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return c.json(
        { error: `Manager MCP service returned ${res.status}` } as UpdateStatus,
        502,
      );
    }

    const mcpResponse = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: { content: Array<{ type: string; text: string }> };
      error?: { code: number; message: string };
    };

    if (mcpResponse.error) {
      return c.json(
        {
          current: { operator: null, manager: null, web: null },
          latest: null,
          updateAvailable: false,
          error: mcpResponse.error.message,
        } satisfies UpdateStatus,
        500,
      );
    }

    const rawText = mcpResponse.result?.content?.[0]?.text;
    if (!rawText) {
      return c.json(
        {
          current: { operator: null, manager: null, web: null },
          latest: null,
          updateAvailable: false,
          error: "Empty response from manager",
        } satisfies UpdateStatus,
        500,
      );
    }

    const result = JSON.parse(rawText) as UpdateStatus;
    return c.json(result);
  } catch (e) {
    return c.json(
      {
        current: { operator: null, manager: null, web: null },
        latest: null,
        updateAvailable: false,
        error: (e as Error).message,
      } satisfies UpdateStatus,
      500,
    );
  }
});

export default router;
