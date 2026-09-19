import { describe, expect, it, mock } from 'bun:test';
import type { CoreV1Api } from '@kubernetes/client-node';
import { ensureManagerMcpToken, MANAGER_MCP_TOKEN_SECRET } from './control-plane-secret.js';

describe('ensureManagerMcpToken', () => {
  it('preserves an existing token', async () => {
    const create = mock(async () => ({}));
    const core = {
      readNamespacedSecret: mock(async () => ({ metadata: { name: MANAGER_MCP_TOKEN_SECRET } })),
      createNamespacedSecret: create,
    } as unknown as CoreV1Api;

    await ensureManagerMcpToken(core, 'test-ns');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a strong token when the secret is absent', async () => {
    const create = mock(async () => ({}));
    const core = {
      readNamespacedSecret: mock(async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }),
      createNamespacedSecret: create,
    } as unknown as CoreV1Api;

    await ensureManagerMcpToken(core, 'test-ns');
    const request = create.mock.calls[0]?.[0] as {
      namespace: string;
      body: { stringData?: { token?: string } };
    };
    expect(request.namespace).toBe('test-ns');
    expect(request.body.stringData?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not replace a concurrently created secret', async () => {
    const core = {
      readNamespacedSecret: mock(async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }),
      createNamespacedSecret: mock(async () => {
        throw Object.assign(new Error('conflict'), { statusCode: 409 });
      }),
    } as unknown as CoreV1Api;

    await expect(ensureManagerMcpToken(core, 'test-ns')).resolves.toBeUndefined();
  });
});
