// session-fallback.test.ts — C10: route-level tests for the 3-source fallback
// chain in GET /api/runs/:name/session (snapshot ConfigMap → live OpenCode
// proxy → stats-DB replay), plus the /events sidecar proxy.
//
// The route was the subject of two bug-fix commits (snapshot-then-live
// ordering, and the DB-replay fallback for TTL-deleted runs), so the whole
// chain is pinned here:
//
//   1. snapshot ConfigMap exists            → source: 'snapshot'
//   2. no snapshot, live proxy works        → source: 'live'
//   3. no snapshot, live proxy fails, DB    → source: 'db'
//   4. Run CR deleted (404), DB row exists  → source: 'db'
//   5. Run CR deleted, no DB row            → 404 "run deleted and no stored messages"
//   6. Run exists but still initializing    → 404 "no session ID yet"
//   7. everything unavailable, run exists   → 502
//   8. getRun fails non-404                 → 500
//
// The kube helpers (getRun / readSessionConfigMap / fetchSessionMessages /
// postSessionMessage) are spied before the router is imported; the stats DB is
// a real temp SQLite so the replay path executes for real.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { closeDb, getDb, messages, runs } from '../src/server/db.js';
import * as kube from '../src/server/kube.js';
import { resetAuth } from '../src/server/lib/better-auth.js';

const TEST_DATA_DIR = join('/tmp', `percussionist-session-fallback-${Date.now()}`);
const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

type RunWithStatus = {
  metadata: Record<string, never>;
  status?: {
    serviceName?: string;
    sessionID?: string;
    phase?: string;
  };
};

const kube404 = Object.assign(new Error('not found'), { statusCode: 404 }) as Error;

let app: Hono;
let getRunSpy: ReturnType<typeof spyOn>;
let readSessionConfigMapSpy: ReturnType<typeof spyOn>;
let fetchSessionMessagesSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;

function seedDbSession(sessionID: string, name: string): void {
  const db = getDb();
  db.insert(runs)
    .values({
      id: sessionID,
      name,
      agent: 'builder',
      phase: 'Succeeded',
      startedAt: '2024-01-01T00:00:00Z',
      tokensIn: 10,
      tokensOut: 5,
    })
    .run();
  db.insert(messages)
    .values({
      id: `${sessionID}-m0`,
      sessionId: sessionID,
      idx: 0,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'hello from db' }]),
      model: 'openai/gpt-4o',
    })
    .run();
}

beforeAll(async () => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  closeDb();
  resetAuth();

  getRunSpy = spyOn(kube, 'getRun');
  readSessionConfigMapSpy = spyOn(kube, 'readSessionConfigMap');
  fetchSessionMessagesSpy = spyOn(kube, 'fetchSessionMessages');
  fetchSpy = spyOn(globalThis, 'fetch');

  const { default: sessionRouter } = await import('../src/server/routes/session.js');
  app = new Hono();
  app.route('/api/runs', sessionRouter);
});

afterAll(() => {
  getRunSpy.mockRestore();
  readSessionConfigMapSpy.mockRestore();
  fetchSessionMessagesSpy.mockRestore();
  fetchSpy.mockRestore();
  closeDb();
  resetAuth();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  if (prevAuthDisabled !== undefined) process.env.AUTH_DISABLED = prevAuthDisabled;
  else delete process.env.AUTH_DISABLED;
});

beforeEach(() => {
  getRunSpy.mockReset();
  readSessionConfigMapSpy.mockReset();
  fetchSessionMessagesSpy.mockReset();
  fetchSpy.mockReset();
});

describe('GET /api/runs/:name/session fallback chain', () => {
  it('serves the snapshot ConfigMap when it exists (source: snapshot)', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-1' },
    } as RunWithStatus);
    readSessionConfigMapSpy.mockResolvedValue({
      messages: [{ info: { id: 'snap-1' } }],
      truncated: true,
    });

    const res = await app.request('/api/runs/run-1/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionID: string;
      source: string;
      truncated: boolean;
      messages: unknown[];
    };
    expect(body.sessionID).toBe('sess-1');
    expect(body.source).toBe('snapshot');
    expect(body.truncated).toBe(true);
    expect(body.messages).toEqual([{ info: { id: 'snap-1' } }]);
    // The live proxy must not be consulted when the snapshot wins.
    expect(fetchSessionMessagesSpy).not.toHaveBeenCalled();
  });

  it('falls through to the live proxy when no snapshot exists (source: live)', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-2' },
    } as RunWithStatus);
    readSessionConfigMapSpy.mockResolvedValue(null);
    fetchSessionMessagesSpy.mockResolvedValue([{ info: { id: 'live-1' } }]);

    const res = await app.request('/api/runs/run-2/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionID: string; source: string; messages: unknown[] };
    expect(body.source).toBe('live');
    expect(body.messages).toEqual([{ info: { id: 'live-1' } }]);
    expect(fetchSessionMessagesSpy).toHaveBeenCalledWith('run-svc', 'sess-2');
  });

  it('replays from the stats DB when snapshot and live both fail (source: db)', async () => {
    seedDbSession('sess-db-3', 'run-3');
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-db-3' },
    } as RunWithStatus);
    // Snapshot read throws (not just missing) — must not kill the chain.
    readSessionConfigMapSpy.mockRejectedValue(new Error('ConfigMap read failed'));
    fetchSessionMessagesSpy.mockRejectedValue(new Error('pod is gone'));

    const res = await app.request('/api/runs/run-3/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionID: string;
      source: string;
      messages: Array<{
        info: { id: string; role: string };
        parts: Array<{ type: string; text: string }>;
      }>;
    };
    expect(body.source).toBe('db');
    expect(body.sessionID).toBe('sess-db-3');
    expect(body.messages[0]?.info.role).toBe('user');
    expect(body.messages[0]?.parts[0]?.text).toBe('hello from db');
  });

  it('replays from the stats DB for a Run CR deleted by the TTL (source: db)', async () => {
    seedDbSession('sess-db-4', 'run-4');
    // Run CR gone → getRun 404s; the route looks the session ID up in the DB.
    getRunSpy.mockRejectedValue(kube404);
    readSessionConfigMapSpy.mockResolvedValue(null);

    const res = await app.request('/api/runs/run-4/session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionID: string; source: string };
    expect(body.source).toBe('db');
    expect(body.sessionID).toBe('sess-db-4');
    expect(fetchSessionMessagesSpy).not.toHaveBeenCalled();
  });

  it('answers 404 when the run is deleted and no stored messages exist', async () => {
    getRunSpy.mockRejectedValue(kube404);
    readSessionConfigMapSpy.mockResolvedValue(null);

    const res = await app.request('/api/runs/run-gone/session');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('run deleted and no stored messages');
  });

  it('answers 404 with an initializing hint when the run has no session ID yet', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: '' },
    } as RunWithStatus);

    const res = await app.request('/api/runs/run-new/session');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('no session ID yet');
  });

  it('answers 502 when every source is unavailable for a live run', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-7' },
    } as RunWithStatus);
    readSessionConfigMapSpy.mockResolvedValue(null);
    fetchSessionMessagesSpy.mockRejectedValue(new Error('connection refused'));

    const res = await app.request('/api/runs/run-7/session');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('live proxy failed');
  });

  it('answers 500 when the Run lookup fails with a non-404 error', async () => {
    getRunSpy.mockRejectedValue(new Error('kube API down'));

    const res = await app.request('/api/runs/run-8/session');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('kube API down');
  });
});

describe('GET /api/runs/:name/session/events', () => {
  it('refuses a terminal-phase run with 404', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-e1', phase: 'Succeeded' },
    } as RunWithStatus);

    const res = await app.request('/api/runs/run-e1/session/events');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('no active event stream');
  });

  it('answers 404 when the run has no active session', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', phase: 'Running' },
    } as RunWithStatus);

    const res = await app.request('/api/runs/run-e2/session/events');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No active session');
  });

  it('answers 502 when the upstream event stream cannot be reached', async () => {
    getRunSpy.mockResolvedValue({
      metadata: {},
      status: { serviceName: 'run-svc', sessionID: 'sess-e3', phase: 'Running' },
    } as RunWithStatus);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.request('/api/runs/run-e3/session/events');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Failed to connect to event stream');
    // The upstream URL targets the run's service with the OpenCode port.
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('run-svc');
    expect(url).toContain('svc.cluster.local');
  });
});
