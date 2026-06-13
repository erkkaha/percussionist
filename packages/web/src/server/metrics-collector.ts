// Metrics snapshot collector.
//
// Polls the metrics-server API every 30s and persists snapshots to SQLite
// for time-series queries. Uses host-level memory from kubelet /stats/summary
// and total VM capacity from the core API. Automatically disables itself if
// the metrics-server is not installed.

import { lt } from 'drizzle-orm';
import { getDb, metricSnapshots } from './db.js';
import { listNodeCapacities, listNodeHostStats, listNodeMetrics } from './kube.js';

const POLL_INTERVAL_MS = 30_000;
const TTL_DAYS = 7;

let _interval: ReturnType<typeof setInterval> | null = null;

export async function startMetricsCollector(): Promise<void> {
  try {
    await listNodeMetrics();
  } catch {
    console.log('[metrics-collector] metrics-server not available — collector disabled');
    return;
  }

  console.log('[metrics-collector] starting (poll every 30s)');
  void poll();
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
    const [metrics, capacities] = await Promise.all([listNodeMetrics(), listNodeCapacities()]);
    const capMap = new Map(capacities.map((c) => [c.name, c]));

    // Fetch host-level memory from kubelet for each node.
    const hostStats = await Promise.all(
      metrics.map((m) => listNodeHostStats(m.name).catch(() => null)),
    );
    const hostMap = new Map<string, NonNullable<(typeof hostStats)[0]>>();
    for (const hs of hostStats) {
      if (hs) hostMap.set(hs.name, hs);
    }

    const db = getDb();
    const now = new Date().toISOString();

    const rows = metrics.map((m) => {
      const cap = capMap.get(m.name);
      const hs = hostMap.get(m.name);
      return {
        node: m.name,
        cpuUsageMillicores: parseCpu(m.usage.cpu),
        // Use host-level memory when available, fall back to cgroup.
        memoryUsageBytes: hs ? hs.hostMemoryBytes : parseMemory(m.usage.memory),
        cpuCapacityMillicores: cap ? parseCpu(cap.capacityCpu) : 0,
        memoryCapacityBytes: cap ? parseMemory(cap.capacityMemory) : 0,
        recordedAt: now,
      };
    });

    if (rows.length) {
      db.insert(metricSnapshots).values(rows).run();
    }

    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.delete(metricSnapshots).where(lt(metricSnapshots.recordedAt, cutoff)).run();
  } catch (e) {
    console.error('[metrics-collector] poll error:', e);
  }
}

function parseCpu(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('n')) return Math.round(n / 1_000_000);
  if (raw.endsWith('u')) return Math.round(n / 1_000);
  if (raw.endsWith('m')) return n;
  return n * 1000;
}

function parseMemory(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('Ki')) return n * 1024;
  if (raw.endsWith('Mi')) return n * 1024 * 1024;
  if (raw.endsWith('Gi')) return n * 1024 * 1024 * 1024;
  return n;
}
