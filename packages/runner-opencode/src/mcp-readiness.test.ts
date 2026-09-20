import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  DEFAULT_MCP_READY_TIMEOUT_MS,
  dispatcherMcpReadyTimeoutMs,
  parseMcpTarget,
  waitForDispatcherMcp,
} from './mcp-readiness.js';

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (!srv) continue;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

/** Reserve an ephemeral port, then release it so a test can decide when to listen. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function listen(port: number): Promise<Server> {
  const srv = createServer();
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', resolve));
  return srv;
}

describe('parseMcpTarget', () => {
  test('reads host and port from a dispatcher MCP URL', () => {
    expect(parseMcpTarget('http://127.0.0.1:4097/mcp')).toEqual({
      host: '127.0.0.1',
      port: 4097,
    });
  });

  test('rejects non-http or malformed URLs', () => {
    expect(parseMcpTarget('not a url')).toBeNull();
    expect(parseMcpTarget('ftp://127.0.0.1:4097/mcp')).toBeNull();
    expect(parseMcpTarget('http://')).toBeNull();
  });
});

describe('dispatcherMcpReadyTimeoutMs', () => {
  test('defaults, honours an override, and falls back on garbage', () => {
    expect(dispatcherMcpReadyTimeoutMs({})).toBe(DEFAULT_MCP_READY_TIMEOUT_MS);
    expect(dispatcherMcpReadyTimeoutMs({ DISPATCHER_MCP_READY_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(dispatcherMcpReadyTimeoutMs({ DISPATCHER_MCP_READY_TIMEOUT_MS: '0' })).toBe(0);
    expect(dispatcherMcpReadyTimeoutMs({ DISPATCHER_MCP_READY_TIMEOUT_MS: 'nope' })).toBe(
      DEFAULT_MCP_READY_TIMEOUT_MS,
    );
    expect(dispatcherMcpReadyTimeoutMs({ DISPATCHER_MCP_READY_TIMEOUT_MS: '-5' })).toBe(
      DEFAULT_MCP_READY_TIMEOUT_MS,
    );
  });
});

describe('waitForDispatcherMcp', () => {
  test('resolves immediately when the listener is already up', async () => {
    const port = await freePort();
    await listen(port);
    const logs: string[] = [];
    const res = await waitForDispatcherMcp(`http://127.0.0.1:${port}/mcp`, {
      timeoutMs: 2000,
      intervalMs: 10,
      log: (m) => logs.push(m),
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(1);
    expect(logs.join(' ')).toContain('ready after');
  });

  test('retries until a late listener appears', async () => {
    const port = await freePort();
    const waiting = waitForDispatcherMcp(`http://127.0.0.1:${port}/mcp`, {
      timeoutMs: 3000,
      intervalMs: 10,
      attemptTimeoutMs: 100,
    });
    // Start the "dispatcher" after the first probes have already been refused.
    setTimeout(() => {
      void listen(port);
    }, 150);

    const res = await waiting;
    expect(res.ready).toBe(true);
    expect(res.attempts).toBeGreaterThan(1);
  });

  test('times out bounded and warns when nothing ever listens', async () => {
    const port = await freePort();
    const warnings: string[] = [];
    const started = Date.now();
    const res = await waitForDispatcherMcp(`http://127.0.0.1:${port}/mcp`, {
      timeoutMs: 150,
      intervalMs: 20,
      attemptTimeoutMs: 30,
      warn: (m) => warnings.push(m),
    });
    expect(res.ready).toBe(false);
    expect(res.attempts).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warnings.join(' ')).toContain('not reachable within 150ms');
    expect(warnings.join(' ')).toContain('starting the runner anyway');
  });

  test('timeout 0 skips probing entirely', async () => {
    const port = await freePort();
    const res = await waitForDispatcherMcp(`http://127.0.0.1:${port}/mcp`, { timeoutMs: 0 });
    expect(res).toEqual({ ready: false, waitedMs: 0, attempts: 0 });
  });

  test('an invalid URL warns and skips without probing', async () => {
    const warnings: string[] = [];
    const res = await waitForDispatcherMcp('not a url', { warn: (m) => warnings.push(m) });
    expect(res).toEqual({ ready: false, waitedMs: 0, attempts: 0 });
    expect(warnings.join(' ')).toContain('skipping readiness wait');
  });

  test('a cancellation signal stops the wait early', async () => {
    const port = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const warnings: string[] = [];
    const started = Date.now();
    const res = await waitForDispatcherMcp(`http://127.0.0.1:${port}/mcp`, {
      timeoutMs: 5000,
      intervalMs: 10,
      attemptTimeoutMs: 50,
      signal: controller.signal,
      warn: (m) => warnings.push(m),
    });
    expect(res.ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(warnings.join(' ')).toContain('wait cancelled');
  });
});
