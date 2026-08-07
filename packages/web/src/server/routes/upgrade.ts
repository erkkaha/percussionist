// routes/upgrade.ts — Version check API.
//
// Proxies to the manager's MCP tool `check_for_updates` which reads the
// current running image tags from live deployments and queries GHCR for the
// latest available semver release.

import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import { callManagerTool, ManagerMcpHttpError } from '../lib/manager-mcp.js';

const router = new Hono();

/**
 * How upgrades reach the cluster.
 *
 * `gitops` — a Flux OCIRepository drives the install; upgrading moves its
 * pinned tag and Flux applies the whole release, CRDs first.
 * `deployments` — the manager patches container images directly. CRDs are out
 * of reach on this path, so a release that changes a schema needs a manual
 * `kubectl apply -f k8s/crds/`.
 */
export type UpgradeMode = 'gitops' | 'deployments';

export interface UpdateStatus {
  current: {
    operator: string | null;
    manager: string | null;
    web: string | null;
    dispatcher: string | null;
  };
  latest: string | null;
  updateAvailable: boolean;
  registryPrefix?: string;
  mode?: UpgradeMode;
  source?: {
    name: string;
    namespace: string;
    tag: string | null;
    url: string;
    semverRange: string | null;
    suspended: boolean;
  };
  error?: string;
}

// GET /api/upgrade/status
//
// Returns the currently running component versions and the latest available
// version from the container registry. Suitable for polling from the UI.
router.get('/status', auth(), async (c) => {
  try {
    const mcpResult = await callManagerTool('check_for_updates', {});

    const rawText = mcpResult.content?.[0]?.text;

    if (mcpResult.isError) {
      return c.json(
        {
          current: { operator: null, manager: null, web: null, dispatcher: null },
          latest: null,
          updateAvailable: false,
          error: rawText ?? 'Unknown MCP tool error',
        } satisfies UpdateStatus,
        500,
      );
    }

    if (!rawText) {
      return c.json(
        {
          current: { operator: null, manager: null, web: null, dispatcher: null },
          latest: null,
          updateAvailable: false,
          error: 'Empty response from manager',
        } satisfies UpdateStatus,
        500,
      );
    }

    const result = JSON.parse(rawText) as UpdateStatus;
    return c.json(result);
  } catch (e) {
    // HTTP failures from the manager keep the 502 they had before the shared
    // client; JSON-RPC and transport errors map to 500.
    if (e instanceof ManagerMcpHttpError) {
      return c.json({ error: e.message } as UpdateStatus, 502);
    }
    return c.json(
      {
        current: { operator: null, manager: null, web: null, dispatcher: null },
        latest: null,
        updateAvailable: false,
        error: (e as Error).message,
      } satisfies UpdateStatus,
      500,
    );
  }
});

export interface UpgradeResult {
  patched: string[];
  errors: string[];
  targetTag: string;
  mode?: UpgradeMode;
  /**
   * Non-fatal caveats about what the upgrade did *not* cover — most
   * importantly, that the `deployments` path leaves CRDs at their installed
   * version.
   */
  warnings?: string[];
  error?: string;
}

// POST /api/upgrade/apply
router.post('/apply', adminAuth(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { targetTag?: string };
  const targetTag = body.targetTag;
  if (!targetTag) {
    return c.json({ error: 'targetTag is required' } satisfies Partial<UpgradeResult>, 400);
  }

  try {
    const mcpResult = await callManagerTool('apply_upgrade', { targetTag });

    const rawText = mcpResult.content?.[0]?.text;

    if (mcpResult.isError) {
      return c.json(
        { error: rawText ?? 'Unknown MCP tool error' } satisfies Partial<UpgradeResult>,
        500,
      );
    }

    if (!rawText) {
      return c.json({ error: 'Empty response from manager' } satisfies Partial<UpgradeResult>, 500);
    }

    const result = JSON.parse(rawText) as UpgradeResult;
    return c.json(result);
  } catch (e) {
    // HTTP failures from the manager keep the 502 they had before the shared
    // client; JSON-RPC and transport errors map to 500.
    if (e instanceof ManagerMcpHttpError) {
      return c.json({ error: e.message } satisfies Partial<UpgradeResult>, 502);
    }
    return c.json({ error: (e as Error).message } satisfies Partial<UpgradeResult>, 500);
  }
});

export default router;
