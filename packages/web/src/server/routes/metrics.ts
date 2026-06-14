// Metrics API routes.
//
// GET /api/metrics/nodes — cluster-wide node CPU/memory usage.
// GET /api/metrics/pods  — pod CPU/memory usage in the configured namespace.
// GET /api/metrics/events — SSE stream for metric changes (polling-based).

import { Hono } from 'hono';
import { auth } from '../auth.js';
import {
  listNodeAllocated,
  listNodeCapacities,
  listNodeHostStats,
  listNodeMetrics,
  listPodMetrics,
  listPodResources,
  NAMESPACE,
  type NodeCapacityTotal,
  type NodeHostStats,
  type NodeMetric,
  type PodMetric,
  type PodResourceSpec,
} from '../kube.js';
import { createPollingSseResponse } from '../lib/sse.js';

const metrics = new Hono();

metrics.get('/nodes', auth(), async (c) => {
  try {
    const [items, capacities, nodeAllocated] = await Promise.all([
      listNodeMetrics(),
      listNodeCapacities().catch((): NodeCapacityTotal[] => []),
      listNodeAllocated(NAMESPACE).catch(
        (): Map<string, { cpu: string; memory: string }> => new Map(),
      ),
    ]);
    const capMap = new Map<string, NodeCapacityTotal>(capacities.map((c: NodeCapacityTotal) => [c.name, c]));

    // Fetch host-level memory from kubelet for each node (fallback to metrics-server cgroup data).
    const hostStats = await Promise.all(
      items.map((n: NodeMetric) => listNodeHostStats(n.name).catch((): NodeHostStats | null => null)),
    );
    const hostMap = new Map<string, NodeHostStats>();
    for (const hs of hostStats) {
      if (hs) hostMap.set(hs.name, hs);
    }

    const nodes = items.map((n: NodeMetric) => {
      const cap = capMap.get(n.name);
      const hs = hostMap.get(n.name);
      const allocated = nodeAllocated.get(n.name);
      return {
        name: n.name,
        timestamp: n.timestamp,
        window: n.window,
        usage: {
          cpu: n.usage.cpu,
          // Use host-level memory when available, fall back to cgroup memory.
          memory: hs ? String(hs.hostMemoryBytes) : n.usage.memory,
        },
        capacity: cap ? { cpu: cap.capacityCpu, memory: cap.capacityMemory } : null,
        allocatable: cap ? { cpu: cap.allocatableCpu, memory: cap.allocatableMemory } : null,
        allocated: allocated ? { cpu: allocated.cpu, memory: allocated.memory } : null,
        // Volume filesystem data from kubelet (nullable when unavailable).
        volume: hs
          ? {
              usedBytes: hs.hostFsUsedBytes ?? null,
              capacityBytes: hs.hostFsCapacityBytes ?? null,
              availableBytes: hs.hostFsAvailableBytes ?? null,
            }
          : null,
      };
    });
    return c.json({ items: nodes });
  } catch (e: unknown) {
    const statusCode = (e as { statusCode?: number })?.statusCode;
    const msg =
      (e as { body?: { message?: string } })?.body?.message ?? (e as Error).message ?? String(e);
    if (statusCode === 404 || msg.includes('metrics.k8s.io')) {
      return c.json({ error: 'metrics-server not available', available: false }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

metrics.get('/pods', auth(), async (c) => {
  try {
    const [metricsItems, resourceSpecs] = await Promise.all([
      listPodMetrics(NAMESPACE),
      listPodResources(NAMESPACE).catch((): PodResourceSpec[] => []),
    ]);
    const resMap = new Map<string, PodResourceSpec>(resourceSpecs.map((r: PodResourceSpec) => [r.name, r]));

    const items = metricsItems.map((p: PodMetric) => {
      const res = resMap.get(p.name);
      return {
        ...p,
        containers: res
          ? p.containers.map((c: { name: string; usage: { cpu: string; memory: string } }) => {
              const r = res.containers.find((rc: { name: string }) => rc.name === c.name);
              return {
                ...c,
                requests: r ? { cpu: r.requests.cpu, memory: r.requests.memory, storage: r.requests.storage ?? null } : null,
                limits: r ? { cpu: r.limits.cpu, memory: r.limits.memory, storage: r.limits.storage ?? null } : null,
              };
            })
          : p.containers.map((c: { name: string; usage: { cpu: string; memory: string } }) => ({ ...c, requests: null, limits: null })),
        podRequests: res ? { ...res.podRequests, storage: res.podRequests.storage ?? null } : null,
        podLimits: res ? { ...res.podLimits, storage: res.podLimits.storage ?? null } : null,
      };
    });
    return c.json({ items });
  } catch (e: unknown) {
    const statusCode = (e as { statusCode?: number })?.statusCode;
    const msg =
      (e as { body?: { message?: string } })?.body?.message ?? (e as Error).message ?? String(e);
    if (statusCode === 404 || msg.includes('metrics.k8s.io')) {
      return c.json({ error: 'metrics-server not available', available: false }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

metrics.get('/events', auth(), async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const [nodes, pods, capacities, allocated] = await Promise.all([
        listNodeMetrics().catch((): NodeMetric[] => []),
        listPodMetrics(NAMESPACE).catch((): PodMetric[] => []),
        listNodeCapacities().catch((): NodeCapacityTotal[] => []),
        listNodeAllocated(NAMESPACE).catch(
          (): Map<string, { cpu: string; memory: string }> => new Map(),
        ),
      ]);
      const capMap = new Map<string, NodeCapacityTotal>(capacities.map((c: NodeCapacityTotal) => [c.name, c]));
      return JSON.stringify({
        n: nodes.map(
          (n: NodeMetric) =>
            `${n.name}:${n.usage.cpu}:${n.usage.memory}:${capMap.get(n.name)?.capacityCpu ?? ''}:${capMap.get(n.name)?.capacityMemory ?? ''}:${allocated.get(n.name)?.cpu ?? '0'}:${allocated.get(n.name)?.memory ?? '0'}`,
        ),
        p: pods.map(
          (p: PodMetric) =>
            `${p.name}:${p.containers.map((c: { name: string; usage: { cpu: string; memory: string } }) => `${c.name}:${c.usage.cpu}:${c.usage.memory}`).join(',')}`,
        ),
      });
    },
    updatedEvent: 'metrics.updated',
    errorEvent: 'metrics.error',
    readyEvent: { event: 'ready', data: { collection: 'metrics' } },
    pollIntervalMs: 15_000,
  });
});

export default metrics;
