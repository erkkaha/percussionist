// Metrics snapshot collector.
//
// Polls the metrics-server API every 30s and persists snapshots to SQLite
// for time-series queries. Automatically disables itself if the metrics-server
// is not installed (returns 503 from the metrics endpoint).

import { listNodeMetrics, listNodeCapacities } from "./kube.js";
import { getDb, metricSnapshots } from "./db.js";
import { lt } from "drizzle-orm";

const POLL_INTERVAL_MS = 30_000;
const TTL_DAYS = 7;

let _interval: ReturnType<typeof setInterval> | null = null;

export async function startMetricsCollector(): Promise<void> {
  // Probe once to check if metrics-server is available.
  try {
    await listNodeMetrics();
  } catch {
    console.log("[metrics-collector] metrics-server not available — collector disabled");
    return;
  }

  console.log("[metrics-collector] starting (poll every 30s)");
  void poll(); // run once immediately
  _interval = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopMetricsCollector(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

async function poll(): Promise<void> {
  try {
    const [metrics, capacities] = await Promise.all([
      listNodeMetrics(),
      listNodeCapacities(),
    ]);
    const capMap = new Map(capacities.map((c) => [c.name, c]));

    const db = getDb();
    const now = new Date().toISOString();

    const rows = metrics.map((m) => {
      const cap = capMap.get(m.name);
      return {
        node: m.name,
        cpuUsageMillicores: parseCpu(m.usage.cpu),
        memoryUsageBytes: parseMemory(m.usage.memory),
        cpuCapacityMillicores: cap ? parseCpu(cap.cpu) : 0,
        memoryCapacityBytes: cap ? parseMemory(cap.memory) : 0,
        recordedAt: now,
      };
    });

    if (rows.length) {
      db.insert(metricSnapshots).values(rows).run();
    }

    // TTL: delete rows older than 7 days.
    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.delete(metricSnapshots).where(lt(metricSnapshots.recordedAt, cutoff)).run();
  } catch (e) {
    console.error("[metrics-collector] poll error:", e);
  }
}

function parseCpu(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith("n")) return Math.round(n / 1_000_000);
  if (raw.endsWith("u")) return Math.round(n / 1_000);
  if (raw.endsWith("m")) return n;
  return n * 1000;
}

function parseMemory(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith("Ki")) return n * 1024;
  if (raw.endsWith("Mi")) return n * 1024 * 1024;
  if (raw.endsWith("Gi")) return n * 1024 * 1024 * 1024;
  return n;
}
