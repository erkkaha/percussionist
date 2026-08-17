// use-metrics.test.tsx — A16: useMetrics must not silently turn a broken
// metrics endpoint into "no data". When exactly one of /api/metrics/nodes or
// /api/metrics/pods fails, the hook still returns the healthy side's live data
// and names the failed endpoint in `data.failures`; when both fail the query
// rejects into `error`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { useMetrics } from '../src/client/hooks/useMetrics.js';

function nodeItem(name: string) {
  return {
    name,
    timestamp: '2026-01-01T00:00:00Z',
    window: '15s',
    usage: { cpu: '100m', memory: '1Gi' },
    capacity: { cpu: '4', memory: '16Gi' },
    allocatable: { cpu: '4', memory: '16Gi' },
    allocated: { cpu: '100m', memory: '1Gi' },
    volume: null,
  };
}

function podItem(name: string) {
  return {
    name,
    namespace: 'percussionist',
    timestamp: '2026-01-01T00:00:00Z',
    window: '15s',
    containers: [{ name: 'opencode', usage: { cpu: '50m', memory: '256Mi' } }],
    podRequests: { cpu: '50m', memory: '256Mi', storage: null },
    podLimits: { cpu: '50m', memory: '256Mi', storage: null },
  };
}

let fetchMock: typeof fetch;
let origFetch: typeof fetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
  fetchMock = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  cleanup();
});

function renderMetrics() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMetrics(false), { wrapper });
}

describe('useMetrics partial-failure signal', () => {
  it('reports nodes in failures and empty pods when only the pods endpoint fails', async () => {
    fetchMock = (async (url: string) => {
      if (String(url).includes('/api/metrics/nodes')) {
        return new Response(JSON.stringify({ items: [nodeItem('node-1')] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'upstream down' }), { status: 500 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const { result } = renderMetrics();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.nodes).toHaveLength(1);
    expect(result.current.data?.pods).toEqual([]);
    expect(result.current.data?.failures).toEqual(['pods']);
    expect(result.current.error).toBeNull();
  });

  it('reports pods in failures and empty nodes when only the nodes endpoint fails', async () => {
    fetchMock = (async (url: string) => {
      if (String(url).includes('/api/metrics/pods')) {
        return new Response(JSON.stringify({ items: [podItem('pod-1')] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'nodes unavailable' }), { status: 503 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const { result } = renderMetrics();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.pods).toHaveLength(1);
    expect(result.current.data?.nodes).toEqual([]);
    expect(result.current.data?.failures).toEqual(['nodes']);
  });

  it('has empty failures and full data when both endpoints succeed', async () => {
    fetchMock = (async (url: string) => {
      if (String(url).includes('/api/metrics/nodes')) {
        return new Response(JSON.stringify({ items: [nodeItem('node-1')] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [podItem('pod-1')] }), { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const { result } = renderMetrics();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.nodes).toHaveLength(1);
    expect(result.current.data?.pods).toHaveLength(1);
    expect(result.current.data?.failures).toEqual([]);
  });

  it('rejects into error when both endpoints fail', async () => {
    fetchMock = (async () =>
      new Response(JSON.stringify({ error: 'metrics-server is down' }), {
        status: 500,
      })) as typeof fetch;
    globalThis.fetch = fetchMock;

    const { result } = renderMetrics();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe('metrics-server is down');
  });
});
