import { randomBytes } from 'node:crypto';
import type { CoreV1Api } from '@kubernetes/client-node';
import { isNotFoundError } from '@percussionist/kube';

export const MANAGER_MCP_TOKEN_SECRET = 'manager-mcp-token';

function statusCode(error: unknown): number | undefined {
  return (
    (error as { statusCode?: number; code?: number }).statusCode ??
    (error as { code?: number }).code
  );
}

/** Ensure the shared manager/web/memory bearer token exists without rotating it. */
export async function ensureManagerMcpToken(core: CoreV1Api, namespace: string): Promise<void> {
  try {
    await core.readNamespacedSecret({ name: MANAGER_MCP_TOKEN_SECRET, namespace });
    return;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  try {
    await core.createNamespacedSecret({
      namespace,
      body: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: MANAGER_MCP_TOKEN_SECRET, namespace },
        type: 'Opaque',
        stringData: { token: randomBytes(32).toString('hex') },
      },
    });
  } catch (error) {
    const status = statusCode(error);
    // Image-only upgrades do not update RBAC. Keep reconciliation available
    // while protected services remain fail-closed until manifests are applied.
    if (status === 403) {
      console.warn(
        `[operator ${new Date().toISOString()}] cannot create Secret ${namespace}/${MANAGER_MCP_TOKEN_SECRET}; apply the current deployment manifests to update RBAC`,
      );
      return;
    }
    if (status !== 409) throw error;
  }
}
