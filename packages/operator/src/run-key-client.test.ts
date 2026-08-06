// run-key-client.test.ts — unit tests for the per-run stats key client.
//
// Every branch of mintRunKey/revokeRunKey is driven with a fully stubbed
// `fetch` (no network access in tests): the auth-disabled short-circuit, the
// missing-token warn-once path, HTTP/malformed-body mint failures, success,
// and the best-effort revoke path.
//
// WEB_AUTH_TOKEN / WEB_STATS_URL are read from config.ts at module load, so
// each test imports a fresh run-key-client instance (cache-busted specifier)
// against a re-registered config mock — loadClient() re-calls mock.module
// with the env values set in beforeEach, and the fresh instance links against
// them. A fresh instance also means a fresh authEnabledPromise/warn-once
// cache; __resetForTests() is exercised directly to pin the seam.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const STATS_URL = 'http://web.test:8080';

// --- fetch stub -------------------------------------------------------------

type FetchRecord = { url: string; init?: RequestInit };

let fetchCalls: FetchRecord[] = [];
let fetchHandler: (url: string, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

/** Minimal Response-like object — enough for run-key-client (ok/status/statusText/json). */
function http(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `fake status ${status}`,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchCalls = [];
  fetchHandler = () => http(500, {});
  process.env.WEB_AUTH_TOKEN = 'test-operator-token';
  process.env.WEB_STATS_URL = STATS_URL;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    try {
      return Promise.resolve(fetchHandler(url, init));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WEB_AUTH_TOKEN;
  delete process.env.WEB_STATS_URL;
});

// --- fresh module instance per test -----------------------------------------

let importCounter = 0;

type RunKeyModule = typeof import('./run-key-client.js');

/**
 * Import a fresh run-key-client instance whose config mock is registered with
 * the current process.env values. Must be called after the test (or
 * beforeEach) has set the env it needs.
 */
function loadClient(): Promise<RunKeyModule> {
  mock.module('./config.js', () => ({
    WEB_AUTH_TOKEN: process.env.WEB_AUTH_TOKEN ?? '',
    WEB_STATS_URL: process.env.WEB_STATS_URL ?? STATS_URL,
  }));
  importCounter += 1;
  return import(`./run-key-client.js?fresh=${importCounter}`);
}

function healthUrl(): string {
  return `${STATS_URL}/api/health`;
}

function mintUrl(): string {
  return `${STATS_URL}/api/internal/run-keys`;
}

function revokeUrl(runName: string): string {
  return `${STATS_URL}/api/internal/run-keys/${runName}`;
}

/** Run a thunk with console.log/console.error captured into string arrays. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = origOut;
    console.error = origErr;
  }
  return { out, err };
}

// --- tests ------------------------------------------------------------------

describe('mintRunKey', () => {
  it('returns null and makes no mint request when the web server reports auth disabled', async () => {
    fetchHandler = () => http(200, { authDisabled: true });
    const rkc = await loadClient();

    expect(await rkc.mintRunKey({ runName: 'run-1' })).toBeNull();
    expect(await rkc.mintRunKey({ runName: 'run-2' })).toBeNull();

    // Only the health probe was made (cached across both calls) — never the mint endpoint.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(healthUrl());
    expect(fetchCalls.some((c) => c.url === mintUrl())).toBe(false);
  });

  it('returns null and warns exactly once when no WEB_AUTH_TOKEN is configured', async () => {
    process.env.WEB_AUTH_TOKEN = '';
    fetchHandler = () => http(200, {});
    const rkc = await loadClient();

    const { out } = await captureConsole(async () => {
      expect(await rkc.mintRunKey({ runName: 'run-1' })).toBeNull();
      expect(await rkc.mintRunKey({ runName: 'run-2' })).toBeNull();
    });

    const warnings = out.filter((l) => l.includes('no WEB_AUTH_TOKEN configured'));
    expect(warnings).toHaveLength(1);
    expect(fetchCalls.some((c) => c.url === mintUrl())).toBe(false);
  });

  it('returns null when the mint endpoint responds non-2xx', async () => {
    fetchHandler = (url) => (url === healthUrl() ? http(200, {}) : http(500, { error: 'boom' }));
    const rkc = await loadClient();

    expect(await rkc.mintRunKey({ runName: 'run-1' })).toBeNull();
    expect(fetchCalls.map((c) => c.url)).toContain(mintUrl());
  });

  it('returns null when the mint response body has no key', async () => {
    fetchHandler = (url) => (url === healthUrl() ? http(200, {}) : http(200, {}));
    const rkc = await loadClient();

    expect(await rkc.mintRunKey({ runName: 'run-1' })).toBeNull();
  });

  it('returns the key on success and authenticates with the operator bearer token', async () => {
    fetchHandler = (url) =>
      url === healthUrl() ? http(200, {}) : http(200, { key: 'run-key-abc' });
    const rkc = await loadClient();

    const key = await rkc.mintRunKey({ runName: 'run-1', runUid: 'uid-1', project: 'proj' });

    expect(key).toBe('run-key-abc');
    const mintCall = fetchCalls.find((c) => c.url === mintUrl());
    expect(mintCall).toBeDefined();
    expect(mintCall?.init?.method).toBe('POST');
    const mintHeaders = mintCall?.init?.headers as Record<string, string> | undefined;
    expect(mintHeaders?.Authorization).toBe('Bearer test-operator-token');
    expect(mintCall?.init?.body).toContain('"runName":"run-1"');
  });

  it('treats an unreachable health endpoint as auth enabled and proceeds to mint', async () => {
    fetchHandler = (url) => {
      if (url === healthUrl()) throw new Error('ECONNREFUSED');
      return http(200, { key: 'fallback-key' });
    };
    const rkc = await loadClient();

    expect(await rkc.mintRunKey({ runName: 'run-1' })).toBe('fallback-key');
  });
});

describe('revokeRunKey', () => {
  it('is best-effort: a non-2xx revoke response is logged, not thrown', async () => {
    fetchHandler = (url) => (url === healthUrl() ? http(200, {}) : http(500, {}));
    const rkc = await loadClient();

    const { out } = await captureConsole(() => rkc.revokeRunKey('run-1'));

    expect(out.some((l) => l.includes('revoke for run-1 failed: HTTP 500'))).toBe(true);
  });

  it('is best-effort: a fetch rejection is swallowed and logged', async () => {
    fetchHandler = () => {
      throw new Error('ECONNREFUSED');
    };
    const rkc = await loadClient();

    const { out } = await captureConsole(() => rkc.revokeRunKey('run-1'));

    expect(out.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
  });

  it('skips the network call entirely when auth is disabled', async () => {
    fetchHandler = () => http(200, { authDisabled: true });
    const rkc = await loadClient();

    await rkc.revokeRunKey('run-1');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(healthUrl());
    expect(fetchCalls.some((c) => c.url === revokeUrl('run-1'))).toBe(false);
  });
});

describe('__resetForTests', () => {
  it('clears the cached auth-enabled decision so the next call re-probes health', async () => {
    fetchHandler = () => http(200, { authDisabled: true });
    const rkc = await loadClient();

    expect(await rkc.mintRunKey({ runName: 'run-1' })).toBeNull();
    expect(fetchCalls).toHaveLength(1);

    // The server now reports auth enabled — without a reset the cached
    // decision would short-circuit every future mint.
    fetchHandler = (url) => (url === healthUrl() ? http(200, {}) : http(200, { key: 'k' }));
    rkc.__resetForTests();

    expect(await rkc.mintRunKey({ runName: 'run-2' })).toBe('k');
    expect(fetchCalls.map((c) => c.url)).toEqual([healthUrl(), healthUrl(), mintUrl()]);
  });
});
