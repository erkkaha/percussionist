// metrics-routes.test.ts — C9: route-level tests for the metrics API
// (GET /api/metrics/nodes and /api/metrics/pods) with the kube client stubbed,
// plus unit tests for the client's parseCpu/parseMemory unit conversions.
//
// The metrics routes call into the shared @percussionist/kube helpers
// (listNodeMetrics, listPodMetrics, ...), which would hit the cluster in a
// test environment. Each helper is spied before the router is imported so the
// route exercises its own composition logic (host-memory fallback, capacity /
// allocatable / allocated merge, pod container requests/limits merge, and the
// 503-vs-500 error mapping) against deterministic fixtures.
//
// AUTH_DISABLED=1 skips the auth middleware, so requests reach the handlers.

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { parseCpu, parseMemory } from '../src/client/hooks/useMetrics.js';
import * as kube from '../src/server/kube.js';

const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

const NODE_A = {
  name: 'node-a',
  timestamp: '2026-01-01T00:00:00Z',
  window: '30s',
  usage: { cpu: '750m', memory: '1073741824' }, // 750m cpu, 1 GiB cgroup mem
};

const NODE_B = {
  name: 'node-b',
  timestamp: '2026-01-01T00:00:00Z',
  window: '30s',
  usage: { cpu: '1000000000n', memory: '536870912' }, // 1000m cpu, 0.5 GiB cgroup mem
};

const CAP_A = {
  name: 'node-a',
  allocatableCpu: '3820m',
  allocatableMemory: '7500Mi',
  capacityCpu: '4000m',
  capacityMemory: '8192Mi',
};

const CAP_B = {
  name: 'node-b',
  allocatableCpu: '1900m',
  allocatableMemory: '3800Mi',
  capacityCpu: '2000m',
  capacityMemory: '4096Mi',
};

const HOST_A = {
  name: 'node-a',
  hostMemoryBytes: 2147483648, // 2 GiB host-level memory
  hostCpuNanoCores: 750_000_000,
  hostFsUsedBytes: 1048576,
  hostFsCapacityBytes: 2097152,
  hostFsAvailableBytes: 1048576,
};

let app: Hono;
let listNodeMetricsSpy: ReturnType<typeof spyOn>;
let listNodeCapacitiesSpy: ReturnType<typeof spyOn>;
let listNodeAllocatedSpy: ReturnType<typeof spyOn>;
let listNodeHostStatsSpy: ReturnType<typeof spyOn>;
let listPodMetricsSpy: ReturnType<typeof spyOn>;
let listPodResourcesSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  listNodeMetricsSpy = spyOn(kube, 'listNodeMetrics');
  listNodeCapacitiesSpy = spyOn(kube, 'listNodeCapacities');
  listNodeAllocatedSpy = spyOn(kube, 'listNodeAllocated');
  listNodeHostStatsSpy = spyOn(kube, 'listNodeHostStats');
  listPodMetricsSpy = spyOn(kube, 'listPodMetrics');
  listPodResourcesSpy = spyOn(kube, 'listPodResources');

  const { default: metricsRouter } = await import('../src/server/routes/metrics.js');
  app = new Hono();
  app.route('/api/metrics', metricsRouter);
});

afterAll(() => {
  listNodeMetricsSpy.mockRestore();
  listNodeCapacitiesSpy.mockRestore();
  listNodeAllocatedSpy.mockRestore();
  listNodeHostStatsSpy.mockRestore();
  listPodMetricsSpy.mockRestore();
  listPodResourcesSpy.mockRestore();
  if (prevAuthDisabled !== undefined) process.env.AUTH_DISABLED = prevAuthDisabled;
  else delete process.env.AUTH_DISABLED;
});

// ===========================================================================
// GET /api/metrics/nodes
// ===========================================================================

describe('GET /api/metrics/nodes', () => {
  beforeEach(() => {
    listNodeMetricsSpy.mockResolvedValue([NODE_A, NODE_B]);
    listNodeCapacitiesSpy.mockResolvedValue([CAP_A, CAP_B]);
    listNodeAllocatedSpy.mockResolvedValue(
      new Map<string, { cpu: string; memory: string }>([
        ['node-a', { cpu: '1500m', memory: '2Gi' }],
      ]),
    );
    listNodeHostStatsSpy.mockResolvedValue(HOST_A);
  });

  it('merges usage/capacity/allocatable/allocated and prefers host memory', async () => {
    const res = await app.request('/api/metrics/nodes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        name: string;
        usage: { cpu: string; memory: string };
        capacity: { cpu: string; memory: string } | null;
        allocatable: { cpu: string; memory: string } | null;
        allocated: { cpu: string; memory: string } | null;
        volume: {
          usedBytes: number | null;
          capacityBytes: number | null;
          availableBytes: number | null;
        } | null;
      }>;
    };

    // node-a: host stats present → usage.memory is the host-level byte count
    // and volume/fs data is attached from the kubelet summary.
    const a = body.items.find((n) => n.name === 'node-a');
    expect(a).toBeDefined();
    expect(a?.usage.cpu).toBe('750m');
    expect(a?.usage.memory).toBe('2147483648');
    expect(a?.capacity).toEqual({ cpu: '4000m', memory: '8192Mi' });
    expect(a?.allocatable).toEqual({ cpu: '3820m', memory: '7500Mi' });
    expect(a?.allocated).toEqual({ cpu: '1500m', memory: '2Gi' });
    expect(a?.volume).toEqual({
      usedBytes: 1048576,
      capacityBytes: 2097152,
      availableBytes: 1048576,
    });

    // node-b: no host stats (mockResolvedValue(HOST_A) resolves for every
    // node, but the route catches and maps it to null per-node via the
    // name-keyed map — node-b gets no entry) → cgroup memory is kept and
    // volume/allocated fall back to null.
    const b = body.items.find((n) => n.name === 'node-b');
    expect(b).toBeDefined();
    expect(b?.usage.memory).toBe('536870912');
    expect(b?.capacity).toEqual({ cpu: '2000m', memory: '4096Mi' });
    expect(b?.allocated).toBeNull();
    expect(b?.volume).toBeNull();
  });

  it('falls back to cgroup memory when host stats are unavailable', async () => {
    listNodeHostStatsSpy.mockRejectedValue(new Error('kubelet unreachable'));
    const res = await app.request('/api/metrics/nodes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ usage: { memory: string } }> };
    for (const item of body.items) {
      expect(item.usage.memory).not.toBe('2147483648');
    }
    const a = body.items.find((n) => n.name === 'node-a');
    expect(a?.usage.memory).toBe('1073741824');
  });

  it('answers 503 with available:false when metrics-server is missing', async () => {
    const err404 = Object.assign(new Error('not found'), { statusCode: 404 });
    listNodeMetricsSpy.mockRejectedValue(err404);
    const res = await app.request('/api/metrics/nodes');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; available: boolean };
    expect(body.available).toBe(false);
    expect(body.error).toContain('metrics-server');

    // The message-based detection path also maps to 503.
    listNodeMetricsSpy.mockRejectedValue(new Error('metrics.k8s.io v1beta1 unavailable'));
    const res2 = await app.request('/api/metrics/nodes');
    expect(res2.status).toBe(503);
  });

  it('maps non-metrics errors to 500', async () => {
    listNodeMetricsSpy.mockRejectedValue(new Error('token read failed'));
    const res = await app.request('/api/metrics/nodes');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('token read failed');
  });
});

// ===========================================================================
// GET /api/metrics/pods
// ===========================================================================

describe('GET /api/metrics/pods', () => {
  beforeEach(() => {
    listPodMetricsSpy.mockResolvedValue([
      {
        name: 'pod-app',
        namespace: 'percussionist',
        timestamp: '2026-01-01T00:00:00Z',
        window: '30s',
        containers: [
          { name: 'app', usage: { cpu: '100m', memory: '64Mi' } },
          { name: 'sidecar', usage: { cpu: '50m', memory: '32Mi' } },
        ],
      },
      {
        name: 'pod-bare',
        namespace: 'percussionist',
        timestamp: '2026-01-01T00:00:00Z',
        window: '30s',
        containers: [{ name: 'bare', usage: { cpu: '10m', memory: '8Mi' } }],
      },
    ]);
    listPodResourcesSpy.mockResolvedValue([
      {
        name: 'pod-app',
        nodeName: 'node-a',
        containers: [
          {
            name: 'app',
            requests: { cpu: '100m', memory: '128Mi', storage: '1Gi' },
            limits: { cpu: '200m', memory: '256Mi', storage: '2Gi' },
          },
          {
            name: 'sidecar',
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '100m', memory: '128Mi' },
          },
        ],
        podRequests: { cpu: '150m', memory: '192Mi', storage: '1Gi' },
        podLimits: { cpu: '300m', memory: '384Mi', storage: '2Gi' },
      },
    ]);
  });

  it('merges per-container requests/limits and pod-level totals from resource specs', async () => {
    const res = await app.request('/api/metrics/pods');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        name: string;
        containers: Array<{
          name: string;
          requests: { cpu: string; memory: string; storage: number | null } | null;
          limits: { cpu: string; memory: string; storage: number | null } | null;
        }>;
        podRequests: { cpu: string; memory: string; storage: number | null } | null;
        podLimits: { cpu: string; memory: string; storage: number | null } | null;
      }>;
    };

    const podApp = body.items.find((p) => p.name === 'pod-app');
    expect(podApp).toBeDefined();
    expect(podApp?.containers[0]?.requests).toEqual({
      cpu: '100m',
      memory: '128Mi',
      storage: '1Gi',
    });
    expect(podApp?.containers[0]?.limits).toEqual({ cpu: '200m', memory: '256Mi', storage: '2Gi' });
    expect(podApp?.containers[1]?.requests).toEqual({ cpu: '50m', memory: '64Mi', storage: null });
    expect(podApp?.containers[1]?.limits).toEqual({ cpu: '100m', memory: '128Mi', storage: null });
    expect(podApp?.podRequests).toEqual({ cpu: '150m', memory: '192Mi', storage: '1Gi' });
    expect(podApp?.podLimits).toEqual({ cpu: '300m', memory: '384Mi', storage: '2Gi' });

    // pod-bare has no resource spec → null requests/limits, usage preserved.
    const bare = body.items.find((p) => p.name === 'pod-bare');
    expect(bare).toBeDefined();
    expect(bare?.containers[0]?.requests).toBeNull();
    expect(bare?.containers[0]?.limits).toBeNull();
    expect(bare?.podRequests).toBeNull();
    expect(bare?.podLimits).toBeNull();
    expect(bare?.containers[0]?.usage).toEqual({ cpu: '10m', memory: '8Mi' });
  });

  it('answers 503 when metrics-server is missing (404 or message match)', async () => {
    listPodMetricsSpy.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const res = await app.request('/api/metrics/pods');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);

    listPodMetricsSpy.mockRejectedValue(new Error('metrics.k8s.io not installed'));
    const res2 = await app.request('/api/metrics/pods');
    expect(res2.status).toBe(503);
  });

  it('maps non-metrics errors to 500', async () => {
    listPodMetricsSpy.mockRejectedValue(new Error('kube api unreachable'));
    const res = await app.request('/api/metrics/pods');
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// parseCpu / parseMemory unit conversions
// ===========================================================================

describe('parseCpu / parseMemory unit conversions', () => {
  it('parseCpu converts nanocores, microcores, millicores and full cores', () => {
    expect(parseCpu('750m')).toBe(750);
    expect(parseCpu('1000000000n')).toBe(1000); // 1 core in nanocores → 1000m
    expect(parseCpu('999500000n')).toBe(1000); // rounds to nearest millicore
    expect(parseCpu('500000u')).toBe(500); // microcores → millicores
    expect(parseCpu('2')).toBe(2000); // bare core count → millicores
    expect(parseCpu('0m')).toBe(0);
  });

  it('parseMemory converts Ki/Mi/Gi binary-suffix values to bytes', () => {
    expect(parseMemory('64Ki')).toBe(64 * 1024);
    expect(parseMemory('512Mi')).toBe(512 * 1024 * 1024);
    expect(parseMemory('2Gi')).toBe(2 * 1024 * 1024 * 1024);
    expect(parseMemory('1048576')).toBe(1048576); // raw bytes pass through
    expect(parseMemory('0')).toBe(0);
  });
});
