// attach-ws.test.ts — Unit tests for the WebSocket exec bridge.
//
// Tests:
//   - buildTlsOptions: CA extraction from KubeConfig cluster config
//   - BunWsWrapper: TLS options passed to WebSocket constructor,
//     rich error surfacing on failed connections

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunWsWrapper, buildTlsOptions, resolveBearerToken } from '../src/server/attach-ws.js';

// ---------------------------------------------------------------------------
// buildTlsOptions — pure function tests
// ---------------------------------------------------------------------------

describe('buildTlsOptions', () => {
  it('returns undefined when no CA and no skipTLSVerify', () => {
    const cluster = {};
    expect(buildTlsOptions(cluster as any)).toBeUndefined();
  });

  it('decodes caData from base64 into a Buffer', () => {
    const caPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const result = buildTlsOptions({ caData: Buffer.from(caPem).toString('base64') } as any);
    expect(result).toBeDefined();
    expect(result!.ca).toBeInstanceOf(Buffer);
    expect(result!.ca!.toString()).toBe(caPem);
  });

  it('sets rejectUnauthorized: false when skipTLSVerify is true', () => {
    const result = buildTlsOptions({ skipTLSVerify: true } as any);
    expect(result).toBeDefined();
    expect(result!.rejectUnauthorized).toBe(false);
  });

  it('combines CA and skipTLSVerify', () => {
    const caPem = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';
    const result = buildTlsOptions({
      caData: Buffer.from(caPem).toString('base64'),
      skipTLSVerify: true,
    } as any);
    expect(result).toBeDefined();
    expect(result!.ca).toBeInstanceOf(Buffer);
    expect(result!.rejectUnauthorized).toBe(false);
  });

  it('includes client cert and key from base64 data', () => {
    const cert = 'client-cert-data';
    const key = 'client-key-data';
    const result = buildTlsOptions({
      certData: Buffer.from(cert).toString('base64'),
      keyData: Buffer.from(key).toString('base64'),
    } as any);
    expect(result).toBeDefined();
    expect(result!.cert).toBeInstanceOf(Buffer);
    expect(result!.cert!.toString()).toBe(cert);
    expect(result!.key).toBeInstanceOf(Buffer);
    expect(result!.key!.toString()).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// resolveBearerToken — KubeConfig token + in-cluster fallback
// ---------------------------------------------------------------------------

describe('resolveBearerToken', () => {
  it('uses KubeConfig user token when present', () => {
    const kc = { getCurrentUser: () => ({ token: ' kubeconfig-token\n' }) };
    expect(resolveBearerToken(kc as any, '/no/such/file')).toBe('kubeconfig-token');
  });

  it('falls back to service-account token file when KubeConfig token is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'percussionist-token-'));
    const tokenPath = join(dir, 'token');
    try {
      writeFileSync(tokenPath, 'service-account-token\n');
      const kc = { getCurrentUser: () => ({}) };
      expect(resolveBearerToken(kc as any, tokenPath)).toBe('service-account-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when no token is available', () => {
    const kc = { getCurrentUser: () => ({}) };
    expect(() => resolveBearerToken(kc as any, '/no/such/file')).toThrow(
      'No Kubernetes bearer token available',
    );
  });
});

// ---------------------------------------------------------------------------
// BunWsWrapper — constructor options and error surfacing
// ---------------------------------------------------------------------------

describe('BunWsWrapper', () => {
  let OriginalWebSocket: typeof WebSocket;

  class MockWebSocket {
    readonly url: string;
    readonly options: unknown;
    readyState = 0; // CONNECTING
    private handlers: Record<string, ((...args: unknown[]) => void) | null> = {
      open: null,
      close: null,
      error: null,
      message: null,
    };

    constructor(url: string | URL, options?: unknown) {
      this.url = String(url);
      this.options = options;
    }

    get onopen(): ((...args: unknown[]) => void) | null {
      return this.handlers.open;
    }
    set onopen(fn: ((...args: unknown[]) => void) | null) {
      this.handlers.open = fn;
    }
    get onclose(): ((...args: unknown[]) => void) | null {
      return this.handlers.close;
    }
    set onclose(fn: ((...args: unknown[]) => void) | null) {
      this.handlers.close = fn;
    }
    get onerror(): ((...args: unknown[]) => void) | null {
      return this.handlers.error;
    }
    set onerror(fn: ((...args: unknown[]) => void) | null) {
      this.handlers.error = fn;
    }
    get onmessage(): ((...args: unknown[]) => void) | null {
      return this.handlers.message;
    }
    set onmessage(fn: ((...args: unknown[]) => void) | null) {
      this.handlers.message = fn;
    }

    close(): void {
      this.readyState = 3;
    }
    send(_data: unknown): void {}
  }

  beforeAll(() => {
    OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as any;
  });

  afterAll(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  function wsRef(wrapper: BunWsWrapper): MockWebSocket {
    return (wrapper as unknown as { ws: MockWebSocket }).ws;
  }

  it('passes TLS options to the underlying WebSocket constructor', () => {
    const ca = Buffer.from('fake-ca-cert');
    const wrapper = new BunWsWrapper('wss://k8s.example.com/exec', 'my-token', {
      ca,
      rejectUnauthorized: false,
    });

    const mock = wsRef(wrapper);
    expect(mock.url).toBe('wss://k8s.example.com/exec');

    const opts = mock.options as Record<string, unknown>;
    expect(opts.headers).toEqual({
      Authorization: 'Bearer my-token',
      'Sec-WebSocket-Protocol':
        'v5.channel.k8s.io, v4.channel.k8s.io, v3.channel.k8s.io, v2.channel.k8s.io, channel.k8s.io',
    });
    expect(opts.tls).toBeDefined();
    const tls = opts.tls as Record<string, unknown>;
    expect(tls.ca).toBe(ca);
    expect(tls.rejectUnauthorized).toBe(false);
  });

  it('passes no tls option when tlsOptions is undefined', () => {
    const wrapper = new BunWsWrapper('ws://k8s.example.com/exec', 'my-token');

    const mock = wsRef(wrapper);
    const opts = mock.options as Record<string, unknown>;
    expect(opts.headers).toEqual({
      Authorization: 'Bearer my-token',
      'Sec-WebSocket-Protocol':
        'v5.channel.k8s.io, v4.channel.k8s.io, v3.channel.k8s.io, v2.channel.k8s.io, channel.k8s.io',
    });
    expect(opts.tls).toBeUndefined();
  });

  it('emits rich error with TLS hint on close code 1006 (abnormal/TLS failure)', async () => {
    const wrapper = new BunWsWrapper('wss://k8s.example.com/exec', 'my-token');
    const errorPromise = new Promise<string>((resolve) => {
      wrapper.on('error', (err: unknown) => {
        resolve((err as Error).message);
      });
    });

    // Simulate failure: onerror fires first (no detail), then onclose with 1006
    const mock = wsRef(wrapper);
    mock.onerror!(new Event('error'));
    mock.onclose!({ code: 1006, reason: '' } as any);

    const msg = await errorPromise;
    expect(msg).toContain('1006');
    expect(msg).toContain('TLS');
    expect(msg).toContain('CA');
  });

  it('emits error with close reason when code is non-1006', async () => {
    const wrapper = new BunWsWrapper('wss://k8s.example.com/exec', 'my-token');
    const errorPromise = new Promise<string>((resolve) => {
      wrapper.on('error', (err: unknown) => {
        resolve((err as Error).message);
      });
    });

    const mock = wsRef(wrapper);
    mock.onclose!({ code: 4001, reason: 'pod not found' } as any);

    const msg = await errorPromise;
    expect(msg).toContain('4001');
    expect(msg).toContain('pod not found');
    expect(msg).not.toContain('TLS');
  });

  it('does not emit error when connection succeeds (opened is set)', async () => {
    const wrapper = new BunWsWrapper('wss://k8s.example.com/exec', 'my-token');
    const errors: string[] = [];
    wrapper.on('error', (err: unknown) => {
      errors.push((err as Error).message);
    });

    // Simulate successful connection
    const mock = wsRef(wrapper);
    mock.onopen!(new Event('open'));

    // Now simulate a normal close
    mock.onclose!({ code: 1000, reason: 'normal' } as any);

    // Should not have emitted any errors
    expect(errors).toHaveLength(0);
  });
});
