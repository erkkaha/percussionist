import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { authHeaders } from '../lib/auth';

interface Props {
  days: number;
}

// ---------------------------------------------------------------------------
// Types matching GET /api/stats/tool-metrics response

interface ToolMetric {
  toolName: string;
  calls: number;
  avgDurationMs: number | null;
  successRate: number | null;
  avgResultSize: null;
  totalErrors: number;
  sessionsUsing: number;
  estTokensOut: number;
  avgTokensOutPerCall: number;
}

interface AgentSummary {
  agent: string;
  calls: number;
  totalTokensOut: number;
  totalSessions: number;
}

interface ToolMetricsResponse {
  tools: ToolMetric[];
  totalCalls: number;
  totalSessions: number;
  agentSummary: AgentSummary[];
  period: { days: number; from: string | null; to: string };
}

// ---------------------------------------------------------------------------
// Helpers

function pct(value: number | null): string {
  if (value == null) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '-';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}

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
// AgentCard — compact agent summary card

function AgentCard({ agent, calls, totalTokensOut, totalSessions }: AgentSummary) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <p className="text-sm font-medium text-text mb-1">{agent}</p>
      <div className="flex gap-3 text-xs text-text-dim">
        <span>{calls.toLocaleString()} calls</span>
        <span>{fmtTokens(totalTokensOut)} tok</span>
        <span>{totalSessions} sess</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component

export default function ToolMetricsView({ days }: Props) {
  const [agentFilter, setAgentFilter] = useState('');

  const { data, isLoading, error } = useQuery<ToolMetricsResponse>({
    queryKey: ['tool-metrics', days, agentFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days) });
      if (agentFilter) params.set('agent', agentFilter);
      const res = await fetch(`/api/stats/tool-metrics?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ToolMetricsResponse>;
    },
    refetchInterval: 30_000,
  });

  // Unique agents for the filter dropdown, derived from agentSummary.
  const agents = useMemo(() => {
    if (!data?.agentSummary) return [];
    return data.agentSummary.map((a) => a.agent);
  }, [data?.agentSummary]);

  // -----------------------------------------------------------------------
  // Loading

  if (isLoading) {
    return <p className="text-text-dim">Loading tool metrics...</p>;
  }

  // -----------------------------------------------------------------------
  // Error

  if (error || !data) {
    return (
      <p className="text-text-danger">
        Failed to load tool metrics: {(error as Error)?.message ?? 'unknown'}
      </p>
    );
  }

  // -----------------------------------------------------------------------
  // Empty

  const noData = data.tools.length === 0;

  // -----------------------------------------------------------------------
  // Derived summaries

  const totalCallDuration = data.tools.reduce((s, t) => s + (t.avgDurationMs ?? 0) * t.calls, 0);
  const avgCallDuration = data.totalCalls > 0 ? totalCallDuration / data.totalCalls : null;
  const successRateTotal =
    data.totalCalls > 0
      ? data.tools.reduce((s, t) => s + (t.successRate ?? 0) * t.calls, 0) / data.totalCalls
      : null;
  const totalTokenCost = data.tools.reduce((s, t) => s + t.estTokensOut, 0);

  // -----------------------------------------------------------------------
  // Render

  return (
    <div className="space-y-6">
      {/* Header with filters */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm text-text-muted">{data.tools.length} tools</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Agent filter */}
          {agents.length > 0 && (
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="px-2 py-1.5 text-xs rounded-md border border-border bg-surface-overlay text-text focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
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
        <MetricCard label="Est. tokens out" value={fmtTokens(totalTokenCost)} />
      </div>

      {/* Agent breakdown */}
      {data.agentSummary.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-text-dim mb-2">By agent</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {data.agentSummary.map((a) => (
              <AgentCard key={a.agent} {...a} />
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {noData ? (
        <div className="rounded-lg border border-border bg-surface-raised p-8 text-center text-text-dim">
          <p>No tool usage data yet.</p>
          <p className="text-xs mt-1">
            Data appears after agents complete runs and the dispatcher sends session stats.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-raised overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted text-left">
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Tool</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Calls</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Avg duration</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Success rate</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Errors</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Est. tokens</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Tok/call</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-muted">
                {data.tools.map((t) => (
                  <tr key={t.toolName} className="hover:bg-surface-raised/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-text whitespace-nowrap">
                      {t.toolName}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {t.calls.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {fmtMs(t.avgDurationMs)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {pct(t.successRate)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {t.totalErrors.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {fmtTokens(t.estTokensOut)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">
                      {fmtTokens(t.avgTokensOutPerCall)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-muted">{t.sessionsUsing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
