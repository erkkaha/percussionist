import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { closeDb } from '../src/server/db.js';
import usageRouter from '../src/server/routes/usage.js';

const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

const dataDirs: string[] = [];

function makeTestClient() {
  const dataDir = join('/tmp', `percussionist-usage-routes-${Date.now()}-${Math.random()}`);
  dataDirs.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  closeDb();

  const app = new Hono();
  app.route('/api/usage', usageRouter);

  function req(path: string, init?: RequestInit) {
    return app.request(path, init);
  }

  function post(path: string, body: unknown) {
    return req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return { req, post };
}

afterEach(() => {
  closeDb();
  delete process.env.DATA_DIR;
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.AUTH_DISABLED = '1';
});

beforeEach(() => {
  process.env.AUTH_DISABLED = '1';
});

afterAll(() => {
  if (prevAuthDisabled !== undefined) {
    process.env.AUTH_DISABLED = prevAuthDisabled;
  } else {
    delete process.env.AUTH_DISABLED;
  }
});

describe('usage routes per-project tracking', () => {
  it('heartbeat with project payload creates per-project rows and returns them from today endpoint', async () => {
    const { post, req } = makeTestClient();

    const heartbeatRes = await post('/api/usage/heartbeat', {
      reviewing: 30,
      planning: 20,
      other: 10,
      projectUsage: {
        alpha: { reviewing: 25, planning: 15 },
        beta: { reviewing: 5, planning: 5 },
      },
    });

    expect(heartbeatRes.status).toBe(200);
    const heartbeatBody = (await heartbeatRes.json()) as {
      reviewing: number;
      planning: number;
      other: number;
      total: number;
      projectUsage: Record<string, { reviewing: number; planning: number }>;
    };

    expect(heartbeatBody.reviewing).toBe(30);
    expect(heartbeatBody.planning).toBe(20);
    expect(heartbeatBody.other).toBe(10);
    expect(heartbeatBody.total).toBe(60);
    expect(heartbeatBody.projectUsage).toEqual({
      alpha: { reviewing: 25, planning: 15 },
      beta: { reviewing: 5, planning: 5 },
    });

    const todayRes = await req('/api/usage/today');
    expect(todayRes.status).toBe(200);
    const todayBody = (await todayRes.json()) as {
      reviewing: number;
      planning: number;
      other: number;
      total: number;
      projectUsage: Record<string, { reviewing: number; planning: number }>;
    };

    expect(todayBody.reviewing).toBe(30);
    expect(todayBody.planning).toBe(20);
    expect(todayBody.other).toBe(10);
    expect(todayBody.total).toBe(60);
    expect(todayBody.projectUsage).toEqual({
      alpha: { reviewing: 25, planning: 15 },
      beta: { reviewing: 5, planning: 5 },
    });
  });

  it('uses idempotent max-upsert semantics for repeated same-day heartbeats', async () => {
    const { post, req } = makeTestClient();

    const first = await post('/api/usage/heartbeat', {
      reviewing: 80,
      planning: 50,
      other: 20,
      projectUsage: {
        alpha: { reviewing: 40, planning: 30 },
      },
    });
    expect(first.status).toBe(200);

    const second = await post('/api/usage/heartbeat', {
      reviewing: 80,
      planning: 50,
      other: 20,
      projectUsage: {
        alpha: { reviewing: 40, planning: 30 },
      },
    });
    expect(second.status).toBe(200);

    const lower = await post('/api/usage/heartbeat', {
      reviewing: 10,
      planning: 10,
      other: 10,
      projectUsage: {
        alpha: { reviewing: 5, planning: 5 },
      },
    });
    expect(lower.status).toBe(200);

    const todayRes = await req('/api/usage/today');
    expect(todayRes.status).toBe(200);
    const todayBody = (await todayRes.json()) as {
      reviewing: number;
      planning: number;
      other: number;
      total: number;
      projectUsage: Record<string, { reviewing: number; planning: number }>;
    };

    expect(todayBody.reviewing).toBe(80);
    expect(todayBody.planning).toBe(50);
    expect(todayBody.other).toBe(20);
    expect(todayBody.total).toBe(150);
    expect(todayBody.projectUsage.alpha).toEqual({ reviewing: 40, planning: 30 });
  });

  it('accepts legacy heartbeat payloads without projectUsage', async () => {
    const { post } = makeTestClient();

    await post('/api/usage/heartbeat', {
      reviewing: 40,
      planning: 30,
      other: 10,
      projectUsage: {
        alpha: { reviewing: 20, planning: 15 },
      },
    });

    const res = await post('/api/usage/heartbeat', {
      reviewing: 91,
      planning: 52,
      other: 21,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      reviewing: number;
      planning: number;
      other: number;
      projectUsage: Record<string, { reviewing: number; planning: number }>;
    };

    expect(body.reviewing).toBe(91);
    expect(body.planning).toBe(52);
    expect(body.other).toBe(21);
    expect(body.projectUsage).toBeDefined();
    expect(body.projectUsage.alpha).toEqual({ reviewing: 20, planning: 15 });
  });
});
