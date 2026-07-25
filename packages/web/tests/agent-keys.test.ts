// agent-keys.test.ts — scope enforcement on agent API keys.
//
// The property under test is the reason this machinery exists: a key handed to a
// run pod must be able to report stats and nothing else. Previously every agent
// held the shared dashboard token, so a compromised run pod could read secrets,
// delete projects and trigger upgrades.
//
// These tests mint real keys through better-auth against a temporary SQLite DB,
// so they cover the actual verification path (hashing, expiry, permission
// matching) rather than a stub.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = join('/tmp', `percussionist-agent-keys-${Date.now()}`);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-agent-keys';
process.env.WEB_BASE_URL = 'http://localhost:8080';
// Auth must be enforced, and the legacy shared secret must NOT be accepted —
// otherwise a scope failure could be masked by the fallback path.
delete process.env.AUTH_DISABLED;
delete process.env.LEGACY_TOKEN_AUTH;
delete process.env.AUTH_SECRET;

mkdirSync(TEST_DATA_DIR, { recursive: true });

const { createApp } = await import('../src/server/app.js');
const { mintKey } = await import('../src/server/lib/agent-keys.js');
const { RUN_KEY_PERMISSIONS, OPERATOR_KEY_PERMISSIONS } = await import(
  '../src/server/lib/better-auth.js'
);

const app = createApp();

/** A minimal valid stats payload — enough to get past body validation. */
const STATS_BODY = {
  sessionID: `agent-keys-${Date.now()}`,
  run: { name: 'agent-keys-run' },
};

let runKey: string;
let operatorKey: string;

beforeAll(async () => {
  runKey = await mintKey({ name: 'run:test-run', permissions: RUN_KEY_PERMISSIONS });
  operatorKey = await mintKey({
    name: 'component:test-operator',
    permissions: OPERATOR_KEY_PERMISSIONS,
  });
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function withKey(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, ...extra };
}

// ===========================================================================
// A run key can do its job
// ===========================================================================

describe('run key (stats:write)', () => {
  it('POST /api/stats/session is accepted', async () => {
    const res = await app.request('/api/stats/session', {
      method: 'POST',
      headers: withKey(runKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('PATCH /api/stats/session is accepted', async () => {
    const res = await app.request('/api/stats/session', {
      method: 'PATCH',
      headers: withKey(runKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ===========================================================================
// …and nothing else. This is the core regression guard.
// ===========================================================================

describe('run key is confined to its scope', () => {
  it('GET /api/settings → 403 (session-only endpoint)', async () => {
    const res = await app.request('/api/settings', { headers: withKey(runKey) });
    expect(res.status).toBe(403);
  });

  it('GET /api/settings/secrets → 403', async () => {
    const res = await app.request('/api/settings/secrets', { headers: withKey(runKey) });
    expect(res.status).toBe(403);
  });

  it('POST /api/upgrade/apply → 403', async () => {
    const res = await app.request('/api/upgrade/apply', {
      method: 'POST',
      headers: withKey(runKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ targetTag: 'v9.9.9' }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/projects/myproj → 403', async () => {
    const res = await app.request('/api/projects/myproj', {
      method: 'DELETE',
      headers: withKey(runKey),
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/runs → 403', async () => {
    const res = await app.request('/api/runs', { headers: withKey(runKey) });
    expect(res.status).toBe(403);
  });

  it('POST /api/internal/run-keys → 403 (cannot mint more keys)', async () => {
    const res = await app.request('/api/internal/run-keys', {
      method: 'POST',
      headers: withKey(runKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ runName: 'escalated' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/projects/p/board/task-events → 403 (events:write not held)', async () => {
    const res = await app.request('/api/projects/p/board/task-events', {
      method: 'POST',
      headers: withKey(runKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ taskName: 't1', taskType: 'PLAN', eventType: 'created' }),
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Cross-scope isolation between agent keys
// ===========================================================================

describe('operator key (runkeys:mint)', () => {
  it('POST /api/internal/run-keys is accepted', async () => {
    const res = await app.request('/api/internal/run-keys', {
      method: 'POST',
      headers: withKey(operatorKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ runName: 'minted-by-operator', timeoutSeconds: 600 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key?: string; expiresIn?: number };
    expect(typeof body.key).toBe('string');
    expect(body.key?.startsWith('pcn_')).toBe(true);
    // Grace period on top of the requested timeout.
    expect(body.expiresIn).toBeGreaterThan(600);
  });

  it('POST /api/stats/session → 403 (stats:write not held)', async () => {
    const res = await app.request('/api/stats/session', {
      method: 'POST',
      headers: withKey(operatorKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Bad and expired keys
// ===========================================================================

describe('invalid keys', () => {
  it('an unknown key → 401, not 403', async () => {
    const res = await app.request('/api/stats/session', {
      method: 'POST',
      headers: withKey('pcn_not_a_real_key', { 'Content-Type': 'application/json' }),
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('an expired key → 401', async () => {
    // 1 second, then wait it out. minExpiresIn is configured to 0 precisely so
    // sub-day lifetimes like per-run keys (and this test) are possible.
    const shortLived = await mintKey({
      name: 'run:expires-immediately',
      permissions: RUN_KEY_PERMISSIONS,
      expiresInSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1200));

    const res = await app.request('/api/stats/session', {
      method: 'POST',
      headers: withKey(shortLived, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('no credential at all → 401', async () => {
    const res = await app.request('/api/stats/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(STATS_BODY),
    });
    expect(res.status).toBe(401);
  });
});
