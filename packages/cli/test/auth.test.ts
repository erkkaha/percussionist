// auth.test.ts — `beatctl auth*` logic (C19): the device-flow poller's branch
// handling, the auth Secret upsert semantics, the auth.json path resolution,
// the safe token summary, the session-file round trip and the web-auth Secret
// maintenance helpers. All cluster calls are driven with fake clients.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CoreV1Api } from '@kubernetes/client-node';
import { authJsonPath, runAuthImport, summarise, upsertSecret } from '../src/auth.ts';
import {
  assertRotatableComponent,
  patchWebAuthSecret,
  runAuthKeyRotate,
  runGithubAllow,
} from '../src/auth-keys.ts';
import { pollForToken } from '../src/auth-login.ts';
import { clearSession, readSession, writeSession } from '../src/web-client.ts';

// ---------------------------------------------------------------------------
// Helpers

function makeAuthFile(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'auth-test-'));
  const file = path.join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

function cleanupTmp(tmp: string): void {
  try {
    rmSync(tmp, { recursive: true });
  } catch {
    /* already gone */
  }
}

function notFound(): Error {
  return Object.assign(new Error('secret not found'), { code: 404 });
}

type MockResponse = { status?: number; body: unknown };

function jsonResponse({ status = 200, body }: MockResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Capture console.error output (the auth commands print to stderr). */
function captureStderr() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: unknown) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

// ---------------------------------------------------------------------------
// pollForToken — device-flow poller branches

describe('pollForToken', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let sleepSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Collapse the inter-poll sleep to zero so the loop is deterministic.
    sleepSpy = spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    sleepSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  it('POSTs the device-code grant to the token endpoint and returns the access token', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ body: { access_token: 'tok-123' } }),
    );
    const token = await pollForToken('http://server', 'device-1', 3, 600);
    expect(token).toBe('tok-123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://server/api/auth/device/token');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.device_code).toBe('device-1');
    expect(body.client_id).toBe('beatctl');
  });

  it('polls through authorization_pending until approval arrives', async () => {
    const responses = [
      jsonResponse({ status: 400, body: { error: 'authorization_pending' } }),
      jsonResponse({ body: { access_token: 'tok-ok' } }),
    ];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => responses.shift() as Response,
    );
    expect(await pollForToken('http://server', 'd', 3, 600)).toBe('tok-ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('backs off by 5s on slow_down but keeps polling', async () => {
    const responses = [
      jsonResponse({ status: 400, body: { error: 'slow_down' } }),
      jsonResponse({ status: 400, body: { error: 'authorization_pending' } }),
      jsonResponse({ body: { access_token: 'finally' } }),
    ];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => responses.shift() as Response,
    );
    expect(await pollForToken('http://server', 'd', 3, 600)).toBe('finally');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('fails fast when the user denies the request in the browser', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ status: 400, body: { error: 'access_denied' } }),
    );
    await expect(pollForToken('http://server', 'd', 3, 600)).rejects.toThrow(
      'Request denied in the browser.',
    );
  });

  it('fails fast when the code expires before approval', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ status: 400, body: { error: 'expired_token' } }),
    );
    await expect(pollForToken('http://server', 'd', 3, 600)).rejects.toThrow(
      'The code expired before it was approved.',
    );
  });

  it('times out when the deadline passes without approval', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ status: 400, body: { error: 'authorization_pending' } }),
    );
    await expect(pollForToken('http://server', 'd', 3, 0.01)).rejects.toThrow(
      'Timed out waiting for approval.',
    );
  });

  it('surfaces unexpected error payloads instead of looping forever', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ status: 500, body: { error: 'server_error', error_description: 'nope' } }),
    );
    await expect(pollForToken('http://server', 'd', 3, 600)).rejects.toThrow('nope');
  });
});

// ---------------------------------------------------------------------------
// auth import

describe('authJsonPath', () => {
  it('honors XDG_DATA_HOME when set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-path-'));
    try {
      process.env.XDG_DATA_HOME = dir;
      expect(authJsonPath()).toBe(path.join(dir, 'opencode', 'auth.json'));
    } finally {
      delete process.env.XDG_DATA_HOME;
      cleanupTmp(dir);
    }
  });

  it('falls back to ~/.local/share/opencode/auth.json without XDG_DATA_HOME', () => {
    delete process.env.XDG_DATA_HOME;
    const p = authJsonPath();
    expect(p.endsWith(path.join('.local', 'share', 'opencode', 'auth.json'))).toBe(true);
  });

  it('prefers an explicit file override', () => {
    expect(authJsonPath('/custom/auth.json')).toBe('/custom/auth.json');
  });
});

describe('summarise', () => {
  it('masks oauth refresh tokens and names the enterprise URL', () => {
    const summary = summarise({
      type: 'oauth',
      refresh: 'abcdefghijklmnop',
      enterpriseUrl: 'https://ghe.example',
    } as never);
    expect(summary).toContain('type=oauth');
    expect(summary).toContain('token=abcd…mnop (16c)');
    expect(summary).toContain('ghe=https://ghe.example');
    expect(summary).not.toContain('abcdefghijklmnop');
  });

  it('masks api keys', () => {
    const summary = summarise({ type: 'api', key: 'sk-1234567890' } as never);
    expect(summary).toContain('type=api');
    expect(summary).toContain('key=sk-1…7890 (13c)');
    expect(summary).not.toContain('sk-1234567890');
  });

  it('falls back to unknown type', () => {
    expect(summarise({ type: 'weird' } as never)).toBe('type=weird');
  });
});

describe('runAuthImport', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderr: { lines: string[]; restore: () => void };

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    stderr = captureStderr();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderr.restore();
  });

  it('--dry-run imports every provider found in the auth file without touching kube', async () => {
    const file = makeAuthFile({
      'github-copilot': { type: 'oauth', refresh: 'abc-token-xyz' },
      openai: { type: 'api', key: 'sk-secret' },
    });
    try {
      await runAuthImport({
        namespace: 'percussionist',
        name: 'agent-auth',
        key: 'auth.json',
        file,
        dryRun: true,
      });
    } finally {
      cleanupTmp(path.dirname(file));
    }
    const out = stderr.lines.join('\n');
    expect(out).toContain('Providers:');
    expect(out).toContain('github-copilot');
    expect(out).toContain('openai');
    expect(out).toContain('--dry-run: no changes made');
  });

  it('--provider filters the imported subset', async () => {
    const file = makeAuthFile({
      'github-copilot': { type: 'oauth', refresh: 'abc' },
      openai: { type: 'api', key: 'sk' },
    });
    try {
      await runAuthImport({
        namespace: 'percussionist',
        name: 'agent-auth',
        key: 'auth.json',
        file,
        provider: ['openai'],
        dryRun: true,
      });
    } finally {
      cleanupTmp(path.dirname(file));
    }
    const out = stderr.lines.join('\n');
    expect(out).toContain('openai');
    expect(out).not.toContain('github-copilot');
  });

  it('exits when a requested provider is absent from the auth file', () => {
    const file = makeAuthFile({ openai: { type: 'api', key: 'sk' } });
    try {
      expect(() =>
        runAuthImport({
          namespace: 'percussionist',
          name: 'agent-auth',
          key: 'auth.json',
          file,
          provider: ['missing-provider'],
          dryRun: true,
        }),
      ).toThrow('process.exit called');
    } finally {
      cleanupTmp(path.dirname(file));
    }
    expect(stderr.lines.join('\n')).toContain('provider(s) not found');
  });

  it('exits on an empty auth file', () => {
    const file = makeAuthFile({});
    try {
      expect(() =>
        runAuthImport({
          namespace: 'percussionist',
          name: 'agent-auth',
          key: 'auth.json',
          file,
          dryRun: true,
        }),
      ).toThrow('process.exit called');
    } finally {
      cleanupTmp(path.dirname(file));
    }
    expect(stderr.lines.join('\n')).toContain('is empty');
  });

  it('exits when the auth file does not exist', () => {
    expect(() =>
      runAuthImport({
        namespace: 'percussionist',
        name: 'agent-auth',
        key: 'auth.json',
        file: path.join(tmpdir(), 'no-such-auth-12345.json'),
      }),
    ).toThrow('process.exit called');
    expect(stderr.lines.join('\n')).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// upsertSecret — created vs updated semantics

describe('upsertSecret', () => {
  function fakeCore(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
    return {
      readNamespacedSecret: async () => ({}),
      patchNamespacedSecret: async () => ({}),
      createNamespacedSecret: async () => ({}),
      ...overrides,
    } as unknown as CoreV1Api;
  }

  it('creates the Secret when it does not exist yet (404 on read)', async () => {
    const createCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => {
        throw notFound();
      },
      createNamespacedSecret: async (args: unknown) => {
        createCalls.push(args);
        return {};
      },
    });
    const action = await upsertSecret(core, 'ns', 'agent-auth', 'auth.json', '{"x":1}');
    expect(action).toBe('created');
    expect(createCalls).toHaveLength(1);
    const body = (createCalls[0] as { body: Record<string, unknown> }).body;
    expect(body.stringData).toEqual({ 'auth.json': '{"x":1}' });
    expect(body.type).toBe('Opaque');
  });

  it('patches only the auth.json key when the Secret already exists', async () => {
    const patchCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => ({ name: 'agent-auth' }),
      patchNamespacedSecret: async (args: unknown) => {
        patchCalls.push(args);
        return {};
      },
    });
    const action = await upsertSecret(core, 'ns', 'agent-auth', 'auth.json', '{"y":2}');
    expect(action).toBe('updated');
    expect(patchCalls).toHaveLength(1);
    const body = (patchCalls[0] as { body: Record<string, unknown> }).body;
    // The patch carries stringData for our key only — sibling keys (e.g. the
    // claude engine token) must be preserved by the merge.
    expect(body.stringData).toEqual({ 'auth.json': '{"y":2}' });
    expect(body).not.toHaveProperty('data');
  });

  it('propagates non-404 read errors instead of falling through to create', async () => {
    const core = fakeCore({
      readNamespacedSecret: async () => {
        throw new Error('network down');
      },
    });
    await expect(upsertSecret(core, 'ns', 'agent-auth', 'auth.json', '{}')).rejects.toThrow(
      'network down',
    );
  });
});

// ---------------------------------------------------------------------------
// web-auth Secret maintenance (auth-keys.ts)

describe('patchWebAuthSecret', () => {
  let stderr: { lines: string[]; restore: () => void };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  function fakeCore(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
    return {
      readNamespacedSecret: async () => ({}),
      replaceNamespacedSecret: async () => ({}),
      createNamespacedSecret: async () => ({}),
      ...overrides,
    } as unknown as CoreV1Api;
  }

  it('dry-run prints the target keys and touches no Secret', async () => {
    const core = fakeCore({
      readNamespacedSecret: async () => {
        throw new Error('read should not be called in dry-run');
      },
    });
    await patchWebAuthSecret('ns', { 'github-client-id': 'id' }, true, core);
    expect(stderr.lines.join('\n')).toContain('--dry-run: would set github-client-id');
  });

  it('creates the Secret when missing, carrying only the new keys', async () => {
    const createCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => {
        throw notFound();
      },
      createNamespacedSecret: async (args: unknown) => {
        createCalls.push(args);
        return {};
      },
    });
    await patchWebAuthSecret('ns', { 'github-allowed-logins': 'alice,bob' }, false, core);
    expect(createCalls).toHaveLength(1);
    const body = (createCalls[0] as { body: Record<string, unknown> }).body;
    expect(body.stringData).toEqual({ 'github-allowed-logins': 'alice,bob' });
    expect(body.data).toEqual({});
  });

  it('replaces the Secret when it exists, preserving untouched keys', async () => {
    const replaceCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => ({
        data: { token: Buffer.from('keep-me').toString('base64') },
      }),
      replaceNamespacedSecret: async (args: unknown) => {
        replaceCalls.push(args);
        return {};
      },
    });
    await patchWebAuthSecret('ns', { 'session-secret': 'new-secret' }, false, core);
    expect(replaceCalls).toHaveLength(1);
    const body = (replaceCalls[0] as { body: Record<string, unknown> }).body;
    // The untouched token key survives; the new key is added as stringData.
    expect(body.data).toEqual({ token: Buffer.from('keep-me').toString('base64') });
    expect(body.stringData).toEqual({ 'session-secret': 'new-secret' });
  });

  it('removes keys named in removeKeys while keeping siblings (stringData empty)', async () => {
    const replaceCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => ({
        data: {
          token: Buffer.from('keep-me').toString('base64'),
          'session-secret': Buffer.from('ss').toString('base64'),
          disabled: Buffer.from('1').toString('base64'),
        },
      }),
      replaceNamespacedSecret: async (args: unknown) => {
        replaceCalls.push(args);
        return {};
      },
    });
    await patchWebAuthSecret('ns', {}, false, core, ['disabled']);
    expect(replaceCalls).toHaveLength(1);
    const body = (replaceCalls[0] as { body: Record<string, unknown> }).body;
    // disabled is gone; token and session-secret survive.
    expect(body.data).toEqual({
      token: Buffer.from('keep-me').toString('base64'),
      'session-secret': Buffer.from('ss').toString('base64'),
    });
    expect(body.data).not.toHaveProperty('disabled');
    expect(body.stringData).toEqual({});
  });

  it('does not create an empty Secret when enabling on a missing Secret', async () => {
    const createCalls: unknown[] = [];
    const core = fakeCore({
      readNamespacedSecret: async () => {
        throw notFound();
      },
      createNamespacedSecret: async (args: unknown) => {
        createCalls.push(args);
        return {};
      },
    });
    await patchWebAuthSecret('ns', {}, false, core, ['disabled']);
    expect(createCalls).toHaveLength(0);
    expect(stderr.lines.join('\n')).toContain('beatctl auth web-token set <token>');
  });

  it('runGithubAllow exits when every login is blank', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    try {
      expect(() => runGithubAllow({ namespace: 'ns', logins: ['  ', ''] })).toThrow(
        'process.exit called',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  // E item — `auth key rotate <component>` interpolates the component into the
  // web API path and a printed kubectl command; arbitrary input must be
  // rejected up front instead of echoed into a shell command.
  describe('auth key rotate component whitelist', () => {
    it('accepts the standing components the web server knows', () => {
      expect(() => assertRotatableComponent('operator')).not.toThrow();
      expect(() => assertRotatableComponent('manager')).not.toThrow();
    });

    it('rejects anything outside the whitelist', () => {
      expect(() => assertRotatableComponent('web')).toThrow(/unknown component 'web'/);
      expect(() => assertRotatableComponent('; rm -rf /')).toThrow(
        /unknown component '; rm -rf \/'/,
      );
    });

    it('runAuthKeyRotate rejects before any network call for an unknown component', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch');
      await expect(runAuthKeyRotate('$(whoami)', { namespace: 'ns' })).rejects.toThrow(
        /unknown component/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// Session file round-trip (web-client.ts)

describe('session file round trip', () => {
  let configHome: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    configHome = mkdtempSync(path.join(tmpdir(), 'session-test-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
    cleanupTmp(configHome);
  });

  it('writeSession persists a token that readSession returns, and clearSession removes it', () => {
    expect(readSession()).toBeNull();
    writeSession({ token: 'tok-abc', baseUrl: 'http://example' });
    expect(readSession()?.token).toBe('tok-abc');
    expect(readSession()?.baseUrl).toBe('http://example');
    clearSession();
    expect(readSession()).toBeNull();
  });

  it('clearSession is a no-op when no session exists', () => {
    expect(() => clearSession()).not.toThrow();
  });
});
