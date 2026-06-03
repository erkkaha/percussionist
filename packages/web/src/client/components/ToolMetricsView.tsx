import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types matching GET /api/stats/tool-metrics response

interface ToolMetric {
  toolName: string;
  calls: number;
  avgDurationMs: number | null;
  successRate: number | null;
  avgResultSize: number | null;
  totalErrors: number;
  sessionsUsing: number;
}

interface ToolMetricsResponse {
  tools: ToolMetric[];
  totalCalls: number;
  totalSessions: number;
  period: { days: number; from: string | null; to: string };
}

// ---------------------------------------------------------------------------
// Helpers

function pct(value: number | null): string {
  if (value == null) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

// ---------------------------------------------------------------------------
// MetricCard

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs text-text-dim mb-1">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-text-dim mt-1">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component

export default function ToolMetricsView() {
  const [days, setDays] = useState(30);

  const { data, isLoading, error } = useQuery<ToolMetricsResponse>({
    queryKey: ["tool-metrics", days],
    queryFn: async () => {
      const res = await fetch(`/api/stats/tool-metrics?days=${days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ToolMetricsResponse>;
    },
    refetchInterval: 30_000,
  });

  // -----------------------------------------------------------------------
  // Loading

  if (isLoading) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold mb-4">Tool Usage</h1>
        <p className="text-text-dim">Loading tool metrics...</p>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Error

  if (error || !data) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold mb-4">Tool Usage</h1>
        <p className="text-text-danger">Failed to load tool metrics: {(error as Error)?.message ?? "unknown"}</p>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Empty

  const noData = data.tools.length === 0;

  // -----------------------------------------------------------------------
  // Derived summaries

  const totalCallDuration = data.tools.reduce(
    (s, t) => s + (t.avgDurationMs ?? 0) * t.calls,
    0,
  );
  const avgCallDuration = data.totalCalls > 0 ? totalCallDuration / data.totalCalls : null;
  const successRateTotal =
    data.totalCalls > 0
      ? data.tools.reduce((s, t) => s + (t.successRate ?? 0) * t.calls, 0) / data.totalCalls
      : null;

  // -----------------------------------------------------------------------
  // Render

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tool Usage</h1>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                days === opt.value
                  ? "bg-primary-container text-primary"
                  : "bg-surface-overlay text-text-dim hover:text-text"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total calls" value={data.totalCalls.toLocaleString()} />
        <MetricCard
          label="Avg duration"
          value={fmtMs(avgCallDuration)}
          sub={`across ${data.totalSessions} session(s)`}
        />
        <MetricCard label="Success rate" value={pct(successRateTotal)} />
        <MetricCard label="Unique tools" value={String(data.tools.length)} />
      </div>

      {/* Table */}
      {noData ? (
        <div className="rounded-lg border border-border bg-surface-raised p-8 text-center text-text-dim">
          <p>No tool usage data yet.</p>
          <p className="text-xs mt-1">Data appears after agents run and the dispatcher reports tool events.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-raised overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted text-left">
                <th className="px-4 py-2.5 font-medium">Tool</th>
                <th className="px-4 py-2.5 font-medium">Calls</th>
                <th className="px-4 py-2.5 font-medium">Avg duration</th>
                <th className="px-4 py-2.5 font-medium">Success rate</th>
                <th className="px-4 py-2.5 font-medium">Avg result</th>
                <th className="px-4 py-2.5 font-medium">Errors</th>
                <th className="px-4 py-2.5 font-medium">Sessions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted">
              {data.tools.map((t) => (
                <tr key={t.toolName} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-text">{t.toolName}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{t.calls.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{fmtMs(t.avgDurationMs)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{pct(t.successRate)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{fmtBytes(t.avgResultSize)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{t.totalErrors.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{t.sessionsUsing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
