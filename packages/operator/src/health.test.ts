// health.test.ts — the kubelet-facing health endpoint that replaced the exec probe.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { isReady, markReady, resetHealthForTests, startHealthServer } from './health.js';

let server: Server;
let base: string;

beforeEach(async () => {
  resetHealthForTests();
  server = startHealthServer(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('server not bound');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('health server', () => {
  it('serves /healthz as 200 from the start', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('serves /readyz as 503 until markReady, then 200', async () => {
    expect(isReady()).toBe(false);
    const before = await fetch(`${base}/readyz`);
    expect(before.status).toBe(503);

    markReady();
    expect(isReady()).toBe(true);
    const after = await fetch(`${base}/readyz`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('ready');
  });

  it('returns 404 for unknown paths and 405 for non-GET', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
  });
});
