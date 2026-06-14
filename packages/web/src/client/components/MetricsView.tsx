import { BarChart3, Clock } from 'lucide-react';
import { useState } from 'react';
import { type NodeMetricRow, type PodMetricRow, useMetrics } from '../hooks/useMetrics';
import { useMetricsEvents } from '../hooks/useMetricsEvents';
import { useMetricsTimeSeries } from '../hooks/useMetricsTimeSeries';
import { cn } from '../lib/utils';
import MetricsTimeSeriesChart from './MetricsTimeSeriesChart';

// ---------------------------------------------------------------------------
// Helpers

function fmtCpu(millicores: number): string {
  if (millicores >= 1000) return `${(millicores / 1000).toFixed(1)} CPU`;
  return `${millicores}m`;
}

function fmtMemory(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

function fmtStorage(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function age(iso: string | null): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ---------------------------------------------------------------------------
// Node card

function NodeCard({ node }: { node: NodeMetricRow }) {
  const cpuTotal = node.capacityCpuMillicores || 1000;
  const memTotal = node.capacityMemoryBytes || 2 * 1024 * 1024 * 1024;
  const cpuPct = Math.min((node.cpuMillicores / cpuTotal) * 100, 100);
  const memPct = Math.min((node.memoryBytes / memTotal) * 100, 100);

  const allocCpuTotal = node.allocatableCpuMillicores || cpuTotal;
  const allocMemTotal = node.allocatableMemoryBytes || memTotal;
  const cpuReqPct = node.allocatedCpuMillicores
    ? Math.min((node.allocatedCpuMillicores / allocCpuTotal) * 100, 100)
    : 0;
  const memReqPct = node.allocatedMemoryBytes
    ? Math.min((node.allocatedMemoryBytes / allocMemTotal) * 100, 100)
    : 0;

  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm text-text truncate" title={node.name}>
          {node.name}
        </h3>
        <span className="text-xs text-text-dim">{age(node.timestamp)} ago</span>
      </div>
      <UsageBar
        label="CPU"
        value={`${fmtCpu(node.cpuMillicores)} / ${fmtCpu(cpuTotal)}`}
        pct={cpuPct}
      />
      {node.allocated && (
        <UsageBar
          label="Req."
          value={`${fmtCpu(node.allocatedCpuMillicores)} / ${fmtCpu(allocCpuTotal)}`}
          pct={cpuReqPct}
          variant="request"
        />
      )}
      <UsageBar
        label="Memory"
        value={`${fmtMemory(node.memoryBytes)} / ${fmtMemory(memTotal)}`}
        pct={memPct}
      />
      {node.allocated && (
        <UsageBar
          label="Req."
          value={`${fmtMemory(node.allocatedMemoryBytes)} / ${fmtMemory(allocMemTotal)}`}
          pct={memReqPct}
          variant="request"
        />
      )}
      {node.volume?.capacityBytes != null && node.volume.capacityBytes > 0 && (
        <UsageBar
          label="Volume"
          value={`${fmtStorage(node.volume.usedBytes ?? 0)} / ${fmtStorage(node.volume.capacityBytes)}`}
          pct={
            node.volume.capacityBytes > 0
              ? Math.min(((node.volume.usedBytes ?? 0) / node.volume.capacityBytes) * 100, 100)
              : 0
          }
        />
      )}
    </div>
  );
}

function UsageBar({
  label,
  value,
  pct,
  variant = 'usage',
}: {
  label: string;
  value: string;
  pct: number;
  variant?: 'usage' | 'request';
}) {
  const color =
    variant === 'request'
      ? pct > 80
        ? 'bg-violet-500'
        : pct > 50
          ? 'bg-violet-400'
          : 'bg-violet-300'
      : pct > 80
        ? 'bg-red-500'
        : pct > 50
          ? 'bg-amber-500'
          : 'bg-primary-container';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono text-text">{value}</span>
      </div>
      <div className="h-1.5 bg-surface-overlay overflow-hidden">
        <div className={`h-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pod table

function fmtCpuCompact(usage: number, request: number, limit: number): string {
  const u = fmtCpu(usage);
  const r = request > 0 ? fmtCpu(request) : '-';
  const l = limit > 0 ? fmtCpu(limit) : '-';
  return `${u} / ${r} / ${l}`;
}

function fmtMemCompact(usage: number, request: number, limit: number): string {
  const u = fmtMemory(usage);
  const r = request > 0 ? fmtMemory(request) : '-';
  const l = limit > 0 ? fmtMemory(limit) : '-';
  return `${u} / ${r} / ${l}`;
}

function fmtStorageCompact(usage: number, request: number | null, limit: number | null): string {
  const u = usage > 0 ? fmtStorage(usage) : '0 B';
  const r = request != null && request > 0 ? fmtStorage(request) : '-';
  const l = limit != null && limit > 0 ? fmtStorage(limit) : '-';
  return `${u} / ${r} / ${l}`;
}

function PodTable({ pods }: { pods: PodMetricRow[] }) {
  const sorted = [...pods].sort((a, b) => b.totalCpuMillicores - a.totalCpuMillicores);

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
        No pod metrics available.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
            <th className="px-4 py-2.5 font-medium">Pod</th>
            <th className="px-4 py-2.5 font-medium">CPU (use / req / limit)</th>
            <th className="px-4 py-2.5 font-medium">Memory (use / req / limit)</th>
            <th className="px-4 py-2.5 font-medium">Storage (use / req / limit)</th>
            <th className="px-4 py-2.5 font-medium">Containers</th>
            <th className="px-4 py-2.5 font-medium">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-muted">
          {sorted.map((p) => (
            <tr key={p.name} className="hover:bg-surface-raised/60 transition-colors">
              <td
                className="px-4 py-3 font-mono text-xs text-text max-w-[240px] truncate"
                title={p.name}
              >
                {p.name}
              </td>
              <td className="px-4 py-3 tabular-nums font-mono text-xs text-text-muted">
                {fmtCpuCompact(p.totalCpuMillicores, p.totalCpuRequest, p.totalCpuLimit)}
              </td>
              <td className="px-4 py-3 tabular-nums font-mono text-xs text-text-muted">
                {fmtMemCompact(p.totalMemoryBytes, p.totalMemoryRequest, p.totalMemoryLimit)}
              </td>
              <td className="px-4 py-3 tabular-nums font-mono text-xs text-text-muted">
                {fmtStorageCompact(0, p.totalStorageRequestBytes, p.totalStorageLimitBytes)}
              </td>
              <td className="px-4 py-3 text-text-muted">
                <span className="text-xs">{p.containers.length}</span>
              </td>
              <td className="px-4 py-3 text-text-muted tabular-nums text-xs">{age(p.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar

const TABS = [
  { id: 'live', label: 'Live', icon: BarChart3 },
  { id: 'history', label: 'History', icon: Clock },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ---------------------------------------------------------------------------
// Main view

export default function MetricsView() {
  const [tab, setTab] = useState<TabId>('live');

  const { connected, eventTick } = useMetricsEvents();
  void eventTick;
  const { data, error, isLoading, isFetching } = useMetrics(connected ? false : 15_000);

  const [historyHours, setHistoryHours] = useState(1);
  const [historyNode, setHistoryNode] = useState('all');
  const {
    data: historyData,
    error: historyError,
    isLoading: historyLoading,
  } = useMetricsTimeSeries(historyHours, historyNode);

  const unavailable = error != null && !isLoading;

  const nodeNames = data?.nodes.map((n) => n.name) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-headline-lg flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-text-muted" />
            Metrics
          </h1>
          <p className="text-caption-xs text-text-muted">
            {data
              ? `${data.nodes.length} node${data.nodes.length !== 1 ? 's' : ''}, ${data.pods.length} pod${data.pods.length !== 1 ? 's' : ''}`
              : 'Loading...'}
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
        </div>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                tab === t.id
                  ? 'border-primary text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              )}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Live tab */}
      {tab === 'live' && (
        <>
          {unavailable && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-600">
              <h2 className="text-headline-md mb-1">Metrics server not available</h2>
              <p className="text-caption-xs">
                The Kubernetes metrics-server addon is required for this view. Install it with:{' '}
                <code className="px-1.5 py-0.5 bg-amber-500/20 rounded text-xs font-mono">
                  kubectl apply -f
                  https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
                </code>
              </p>
            </div>
          )}

          {isLoading && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[0, 1, 2].map((k) => (
                  <div
                    key={k}
                    className="rounded-lg border border-border bg-surface-raised p-4 h-28 animate-pulse"
                  />
                ))}
              </div>
              <div className="rounded-lg border border-border bg-surface-raised h-48 animate-pulse" />
            </div>
          )}

          {data && (
            <>
              {data.nodes.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-text-muted mb-3">Nodes</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {data.nodes.map((n) => (
                      <NodeCard key={n.name} node={n} />
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h2 className="text-sm font-semibold text-text-muted mb-3">Pods</h2>
                <PodTable pods={data.pods} />
              </section>
            </>
          )}
        </>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <MetricsTimeSeriesChart
          dataPoints={historyData?.dataPoints ?? []}
          runWindows={historyData?.runWindows ?? []}
          nodeNames={nodeNames}
          hours={historyHours}
          selectedNode={historyNode}
          onHoursChange={(h) => {
            setHistoryHours(h);
          }}
          onNodeChange={(n) => {
            setHistoryNode(n);
          }}
          loading={historyLoading}
          error={historyError}
        />
      )}
    </div>
  );
}
