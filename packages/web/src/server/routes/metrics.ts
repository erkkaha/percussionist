// Metrics API routes.
//
// GET /api/metrics/nodes — cluster-wide node CPU/memory usage.
// GET /api/metrics/pods  — pod CPU/memory usage in the configured namespace.
// GET /api/metrics/events — SSE stream for metric changes (polling-based).

import { Hono } from "hono";
import { listNodeMetrics, listPodMetrics, NAMESPACE, type NodeMetric, type PodMetric } from "../kube.js";
import { createPollingSseResponse } from "../lib/sse.js";

const metrics = new Hono();

metrics.get("/nodes", async (c) => {
  try {
    const items = await listNodeMetrics();
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

metrics.get("/pods", async (c) => {
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

metrics.get("/events", async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const [nodes, pods] = await Promise.all([
        listNodeMetrics().catch((): NodeMetric[] => []),
        listPodMetrics(NAMESPACE).catch((): PodMetric[] => []),
      ]);
      return JSON.stringify({
        n: nodes.map((n) => `${n.name}:${n.usage.cpu}:${n.usage.memory}`),
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
