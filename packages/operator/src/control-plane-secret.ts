import { randomBytes } from 'node:crypto';
import type { CoreV1Api } from '@kubernetes/client-node';
import { isNotFoundError } from '@percussionist/kube';

export const MANAGER_MCP_TOKEN_SECRET = 'manager-mcp-token';

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
    const status =
      (error as { statusCode?: number; code?: number }).statusCode ??
      (error as { code?: number }).code;
    if (status !== 409) throw error;
  }
}
