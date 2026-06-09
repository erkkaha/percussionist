// Metrics API routes.
//
// GET /api/metrics/nodes — cluster-wide node CPU/memory usage.
// GET /api/metrics/pods  — pod CPU/memory usage in the configured namespace.
// GET /api/metrics/events — SSE stream for metric changes (polling-based).

import { Hono } from "hono";
import { listNodeMetrics, listPodMetrics, listNodeCapacities, listNodeHostStats, NAMESPACE, type NodeMetric, type NodeCapacityTotal, type NodeHostStats, type PodMetric } from "../kube.js";
import { createPollingSseResponse } from "../lib/sse.js";
import { auth } from "../auth.js";

const metrics = new Hono();

metrics.get("/nodes", auth(), async (c) => {
  try {
    const [items, capacities] = await Promise.all([
      listNodeMetrics(),
      listNodeCapacities().catch((): NodeCapacityTotal[] => []),
    ]);
    const capMap = new Map(capacities.map((c) => [c.name, c]));

    // Fetch host-level memory from kubelet for each node (fallback to metrics-server cgroup data).
    const hostStats = await Promise.all(
      items.map((n) => listNodeHostStats(n.name).catch((): NodeHostStats | null => null)),
    );
    const hostMap = new Map<string, NodeHostStats>();
    for (const hs of hostStats) {
      if (hs) hostMap.set(hs.name, hs);
    }

    const nodes = items.map((n) => {
      const cap = capMap.get(n.name);
      const hs = hostMap.get(n.name);
      return {
        ...n,
        usage: {
          cpu: n.usage.cpu,
          // Use host-level memory when available, fall back to cgroup memory.
          memory: hs ? String(hs.hostMemoryBytes) : n.usage.memory,
        },
        capacity: cap
          ? { cpu: cap.capacityCpu, memory: cap.capacityMemory }
          : null,
        allocatable: cap
          ? { cpu: cap.allocatableCpu, memory: cap.allocatableMemory }
          : null,
      };
    });
    return c.json({ items: nodes });
  } catch (e: unknown) {
    const statusCode = (e as { statusCode?: number })?.statusCode;
    const msg = (e as { body?: { message?: string } })?.body?.message ?? (e as Error).message ?? String(e);
    if (statusCode === 404 || msg.includes("metrics.k8s.io")) {
      return c.json({ error: "metrics-server not available", available: false }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

metrics.get("/pods", auth(), async (c) => {
  try {
    const items = await listPodMetrics(NAMESPACE);
    return c.json({ items });
  } catch (e: unknown) {
    const statusCode = (e as { statusCode?: number })?.statusCode;
    const msg = (e as { body?: { message?: string } })?.body?.message ?? (e as Error).message ?? String(e);
    if (statusCode === 404 || msg.includes("metrics.k8s.io")) {
      return c.json({ error: "metrics-server not available", available: false }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

metrics.get("/events", auth(), async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const [nodes, pods, capacities] = await Promise.all([
        listNodeMetrics().catch((): NodeMetric[] => []),
        listPodMetrics(NAMESPACE).catch((): PodMetric[] => []),
        listNodeCapacities().catch((): NodeCapacityTotal[] => []),
      ]);
      const capMap = new Map(capacities.map((c) => [c.name, c]));
      return JSON.stringify({
        n: nodes.map((n) => `${n.name}:${n.usage.cpu}:${n.usage.memory}:${(capMap.get(n.name)?.capacityCpu) ?? ""}:${(capMap.get(n.name)?.capacityMemory) ?? ""}`),
        p: pods.map((p) => `${p.name}:${p.containers.map((c) => `${c.name}:${c.usage.cpu}:${c.usage.memory}`).join(",")}`),
      });
    },
    updatedEvent: "metrics.updated",
    errorEvent: "metrics.error",
    readyEvent: { event: "ready", data: { collection: "metrics" } },
    pollIntervalMs: 15_000,
  });
});

export default metrics;
