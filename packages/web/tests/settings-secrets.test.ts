// settings-secrets.test.ts — regression guard for sibling-key destruction on
// PUT /api/settings/secrets/:name.
//
// The merged upsert (mergeUpsertSecret) must preserve keys already present in
// the Secret when a partial update is submitted. Previously a `PUT llm-keys`
// carrying only { OPENAI_API_KEY } silently deleted ANTHROPIC_API_KEY.

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';

// Disable auth middleware so the route handlers run without a session token.
process.env.AUTH_DISABLED = '1';

// In-memory fake of the subset of the Kubernetes CoreV1Api used by the Secrets
// write path. Kubernetes stores secret `data` base64-encoded; `stringData`
// arrives as plaintext and is what our upsert helpers submit.
const secretStore = new Map<string, Record<string, string>>();

const fakeCore = {
  async readNamespacedSecret({ name }: { name: string }) {
    const s = secretStore.get(name);
    if (!s) {
      const err = new Error(`secrets "${name}" not found`) as Error & {
        statusCode?: number;
        response?: { statusCode?: number };
      };
      err.statusCode = 404;
      err.response = { statusCode: 404 };
      throw err;
    }
    const encoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) {
      encoded[k] = Buffer.from(v).toString('base64');
    }
    return { data: encoded };
  },
  async replaceNamespacedSecret({
    name,
    body,
  }: {
    name: string;
    body: { stringData?: Record<string, string> };
  }) {
    secretStore.set(name, { ...(body.stringData ?? {}) });
    return {};
  },
  async createNamespacedSecret({
    body,
  }: {
    body: { metadata: { name: string }; stringData?: Record<string, string> };
  }) {
    secretStore.set(body.metadata.name, { ...(body.stringData ?? {}) });
    return {};
  },
};

const realKube = await import('@percussionist/kube');
await mock.module('@percussionist/kube', () => ({
  ...realKube,
  core: () => fakeCore,
  NAMESPACE: 'percussionist',
}));

const settings = (await import('../src/server/routes/settings.js')).default;
const { mergeUpsertSecret } = await import('../src/server/lib/kube-upsert.js');

beforeAll(() => {
  secretStore.clear();
});

afterEach(() => {
  secretStore.clear();
});

// ===========================================================================
// Route-level regression: partial PUT must not delete sibling keys
// ===========================================================================

describe('PUT /api/settings/secrets/:name', () => {
  it('preserves existing sibling keys when only one key is updated', async () => {
    // Seed the Secret with an existing key (simulating a prior write).
    await settings.request('/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'llm-keys', data: { ANTHROPIC_API_KEY: 'a' } }),
    });

    // Partial update: only OPENAI_API_KEY.
    const res = await settings.request('/secrets/llm-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { OPENAI_API_KEY: 'b' } }),
    });
    expect(res.status).toBe(200);

    // Both keys must now be present in the backing store.
    const stored = secretStore.get('llm-keys');
    expect(stored).toBeDefined();
    expect(stored).toHaveProperty('ANTHROPIC_API_KEY', 'a');
    expect(stored).toHaveProperty('OPENAI_API_KEY', 'b');
  });

  it('rejects an empty data payload with 400', async () => {
    const res = await settings.request('/secrets/llm-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST still creates/replaces as a full set
// ===========================================================================

describe('POST /api/settings/secrets', () => {
  it('creates the Secret with exactly the submitted keys', async () => {
    const res = await settings.request('/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'llm-keys', data: { OPENAI_API_KEY: 'b' } }),
    });
    expect(res.status).toBe(201);
    const stored = secretStore.get('llm-keys');
    expect(stored).toEqual({ OPENAI_API_KEY: 'b' });
  });

  it('rejects an empty data payload with 400', async () => {
    const res = await settings.request('/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'llm-keys', data: {} }),
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// mergeUpsertSecret unit behavior
// ===========================================================================

describe('mergeUpsertSecret', () => {
  it('merges submitted keys over an existing base64-encoded Secret', async () => {
    secretStore.set('llm-keys', { ANTHROPIC_API_KEY: 'a' });
    await mergeUpsertSecret('llm-keys', { OPENAI_API_KEY: 'b' });
    expect(secretStore.get('llm-keys')).toEqual({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
    });
  });

  it('falls through to a plain create when the Secret does not exist', async () => {
    await mergeUpsertSecret('missing', { ONLY_KEY: 'x' });
    expect(secretStore.get('missing')).toEqual({ ONLY_KEY: 'x' });
  });
});
