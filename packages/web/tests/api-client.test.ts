// api-client.test.ts — A12: mutating API helpers must share fetchJSON's
// 401→login / 423→usage-lock / error-body handling. Before the fix, helpers
// like submitRun, saveSettings and addBoardTask did their own raw-fetch error
// parsing, so the daily usage lock never surfaced in the lock UI on mutating
// pages and an expired session silently threw an opaque error instead of
// bouncing to /login.
//
// The requirement is behavioural: a 423 from ANY helper flips the global lock
// state, a 401 redirects, a 5xx surfaces the server's error message, and the
// success path carries the correct method/headers/body.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { isGloballyLocked, setGloballyLocked } from '../src/client/lib/usage-lock-state.js';

// Keep the import graph shallow: api.ts pulls in better-auth via ./auth, which
// is irrelevant to these tests — stub authHeaders so only fetch is exercised.
mock.module(path.resolve('src/client/lib/auth'), () => ({
  authHeaders: () => ({}),
}));

const api = await import('../src/client/lib/api.js');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof mock>;
/** Controllable location — happy-dom's real Location applies href writes asynchronously. */
let locationMock: { href: string };

beforeEach(() => {
  setGloballyLocked(false);
  fetchMock = mock(() => Promise.resolve(jsonResponse(200, {})));
  globalThis.fetch = fetchMock;
  locationMock = { href: 'http://dashboard.test/' };
  Object.defineProperty(window, 'location', {
    value: locationMock,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  setGloballyLocked(false);
  // Restore the happy-dom fetch installed by tests/setup.ts.
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

describe('mutating helpers share fetchJSON error/lock handling', () => {
  it('a 423 response flips the global usage lock and throws the lock message', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(423, { error: 'Daily usage limit reached' })),
    );

    await expect(api.submitRun({ project: 'p', task: 't' } as never)).rejects.toThrow(
      'Daily usage limit reached',
    );
    expect(isGloballyLocked()).toBe(true);
  });

  it('a 401 redirects to /login instead of surfacing an opaque error', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(401, {})));

    await expect(api.saveSettings({})).rejects.toThrow('Unauthorized');
    expect(locationMock.href).toBe('/login');
  });

  it('surfaces the server error message on 5xx', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(500, { error: 'boom: upstream exploded' })),
    );

    await expect(
      api.addBoardTask('proj', { type: 'BUILD', title: 't', agent: 'a' }),
    ).rejects.toThrow('boom: upstream exploded');
    expect(isGloballyLocked()).toBe(false);
  });

  it('sends the JSON body with the right method and content-type on success', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const captured = { url, init };
      (fetchMock as unknown as { captured?: typeof captured }).captured = captured;
      return Promise.resolve(jsonResponse(200, { task: { metadata: { name: 't1' } } }));
    });

    const result = await api.addBoardTask('proj', {
      type: 'BUILD',
      title: 'my task',
      agent: 'builder',
    });

    const captured = (fetchMock as unknown as { captured?: { url: string; init?: RequestInit } })
      .captured;
    expect(captured?.url).toBe('/api/projects/proj/board/tasks');
    expect(captured?.init?.method).toBe('POST');
    expect((captured?.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      type: 'BUILD',
      title: 'my task',
      agent: 'builder',
    });
    expect(result).toEqual({ task: { metadata: { name: 't1' } } });
  });

  it('a 204 delete resolves without parsing a body', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(204, undefined)));

    await expect(api.deleteRun('run-1')).resolves.toBeUndefined();
  });
});
