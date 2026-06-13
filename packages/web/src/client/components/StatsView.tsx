import { useQuery } from '@tanstack/react-query';
import { BarChart3, List, Table2, TrendingUp, Users, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { authHeaders } from '../lib/auth';
import { cn } from '../lib/utils';
import SessionView from './SessionView';
import StatusBadge from './StatusBadge';
import TokenCounter from './TokenCounter';
import ToolMetricsView from './ToolMetricsView';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from './ui/chart';

// ---------------------------------------------------------------------------
// Types matching /api/stats/sessions response

interface StatSession {
  id: string;
  name: string;
  namespace: string | null;
  task: string | null;
  model: string | null;
  agent: string | null;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  error: string | null;
  createdAt: string | null;
  resolvedModel: string;
}

interface Summary {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgDurationMs: number | null;
}

interface AgentSummary {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgTokensPerRun: number;
  avgDurationMs: number | null;
  models: string[];
}

interface ModelRow {
  model: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface SessionsResponse {
  sessions: StatSession[];
  total: number;
  limit: number;
  offset: number;
  summary: Summary;
  agentSummaries: AgentSummary[];
  modelRows: ModelRow[];
}

// ---------------------------------------------------------------------------
// Trend types (GET /api/stats/trends)

interface TrendPoint {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface ModelTrendPoint {
  date: string;
  [key: string]: string | number;
}

interface TrendsResponse {
  trendPoints: TrendPoint[];
  modelTrendPoints: ModelTrendPoint[];
}

// ---------------------------------------------------------------------------
// Helpers

function shortModelLabel(model: string): string {
  return model.includes('/') ? (model.split('/').pop() ?? model) : model;
}

function durationMs(s: StatSession): number | null {
  if (!s.startedAt || !s.completedAt) return null;
  const ms = new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return '-';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Resolve the model for a session: resolvedModel from server, then fallback.

function resolveModel(s: StatSession): string {
  return s.resolvedModel ?? s.model ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Fetch hook

const PAGE_SIZE = 50;

function useStats(days: number, page: number) {
  return useQuery<SessionsResponse>({
    queryKey: ['stats', days, page],
    queryFn: async () => {
      const offset = page * PAGE_SIZE;
      const url = `/api/stats/sessions?days=${days}&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<SessionsResponse>;
    },
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Server-side analytics — computed in /api/stats/sessions

// ---------------------------------------------------------------------------
// Summary cards

function SummaryCards({ a }: { a: Summary }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      <MetricCard label="Total Runs" value={a.total} />
      <MetricCard label="Succeeded" value={a.succeeded} color="text-phase-succeeded" />
      <MetricCard label="Failed" value={a.failed} color="text-phase-failed" />
      <MetricCard
        label="Success Rate"
        value={a.successRate != null ? `${a.successRate}%` : '-'}
        color={
          a.successRate != null && a.successRate >= 80
            ? 'text-phase-succeeded'
            : 'text-phase-failed'
        }
      />
      <MetricCard label="Avg Duration" value={fmtDuration(a.avgDurationMs)} />
      <MetricCard label="Total Cost" value={fmtCost(a.totalCost)} color="text-phase-running" mono />
      <MetricCard
        label="Tokens In / Out"
        value={`${fmtTokens(a.totalTokensIn)} / ${fmtTokens(a.totalTokensOut)}`}
        mono
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  color = 'text-text',
  mono = false,
}: {
  label: string;
  value: string | number;
  color?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs text-text-dim mb-1">{label}</p>
      <p className={`font-semibold ${color} ${mono ? 'font-mono text-sm mt-1' : 'text-2xl'}`}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model breakdown

function ModelBreakdown({ modelRows }: { modelRows: ModelRow[] }) {
  if (modelRows.length === 0) return null;
  const maxTokens = Math.max(...modelRows.map((r) => r.tokensIn + r.tokensOut));
  return (
    <section>
      <h2 className="text-sm font-semibold text-text-muted mb-3">Models</h2>
      <div className="rounded-lg border border-border bg-surface-raised overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 font-medium">Runs</th>
              <th className="px-4 py-2.5 font-medium">Tokens In</th>
              <th className="px-4 py-2.5 font-medium">Tokens Out</th>
              <th className="px-4 py-2.5 font-medium">Cost</th>
              <th className="px-4 py-2.5 font-medium w-1/4">Token Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {modelRows.map(({ model, runs, tokensIn, tokensOut, cost }) => {
              const total = tokensIn + tokensOut;
              const inPct = total > 0 ? (tokensIn / total) * 100 : 0;
              const outPct = total > 0 ? (tokensOut / total) * 100 : 0;
              const barWidth = maxTokens > 0 ? (total / maxTokens) * 100 : 0;
              return (
                <tr key={model} className="hover:bg-surface-raised/60">
                  <td
                    className="px-4 py-2.5 font-mono text-xs text-text max-w-[200px] truncate"
                    title={model}
                  >
                    {model}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{runs}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted font-mono text-xs">
                    {fmtTokens(tokensIn)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted font-mono text-xs">
                    {fmtTokens(tokensOut)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted font-mono text-xs">
                    {fmtCost(cost)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div
                      className="flex h-2 overflow-hidden bg-surface-overlay"
                      style={{ width: `${barWidth}%`, minWidth: '20px' }}
                      title={`In: ${fmtTokens(tokensIn)} (${inPct.toFixed(0)}%) / Out: ${fmtTokens(tokensOut)} (${outPct.toFixed(0)}%)`}
                    >
                      <div className="bg-primary-container" style={{ width: `${inPct}%` }} />
                      <div className="bg-surface-container-high" style={{ width: `${outPct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-text-dim border-t border-border-muted">
          Bar: <span className="text-primary-container">■</span> tokens in &nbsp;
          <span className="text-surface-container-high">■</span> tokens out
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sessions table

interface SessionsTableProps {
  sessions: StatSession[];
  openRunName: string | null;
  onToggleRun: (runName: string) => void;
}

function SessionsTable({ sessions, openRunName, onToggleRun }: SessionsTableProps) {
  const focusedRowRef = useRef<string | null>(null);

  return (
    <section>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm" aria-label="Session runs">
          <thead>
            <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Phase</th>
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 font-medium">Tokens</th>
              <th className="px-4 py-2.5 font-medium">Cost</th>
              <th className="px-4 py-2.5 font-medium">Duration</th>
              <th className="px-4 py-2.5 font-medium">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {sessions.map((s) => {
              const isOpen = openRunName === s.name;
              return (
                <tr
                  key={s.id}
                  className={`hover:bg-surface-raised/60 transition-colors cursor-pointer focus:outline-none ${
                    isOpen
                      ? 'bg-surface-overlay ring-2 ring-inset ring-primary'
                      : focusedRowRef.current === s.name
                        ? 'ring-2 ring-inset ring-ring'
                        : ''
                  }`}
                  onClick={() => onToggleRun(s.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onToggleRun(s.name);
                    }
                  }}
                  onFocus={() => {
                    focusedRowRef.current = s.name;
                  }}
                  onBlur={() => {
                    focusedRowRef.current = null;
                  }}
                  tabIndex={0}
                  role="button"
                  aria-expanded={isOpen}
                  aria-selected={isOpen}
                  aria-controls={`session-detail-${s.name}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-text flex items-center gap-2">
                      {s.name}
                      {isOpen && <span className="text-xs text-phase-running font-mono">▼</span>}
                    </div>
                    {s.task && (
                      <div
                        className="text-xs text-text-dim mt-0.5 truncate max-w-xs"
                        title={s.task}
                      >
                        {s.task}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge phase={s.phase as string | undefined} />
                  </td>
                  <td
                    className="px-4 py-3 text-text-muted font-mono text-xs max-w-[160px] truncate"
                    title={resolveModel(s)}
                  >
                    {resolveModel(s)}
                  </td>
                  <td className="px-4 py-3">
                    <TokenCounter tokensIn={s.tokensIn} tokensOut={s.tokensOut} />
                  </td>
                  <td className="px-4 py-3 text-text-muted tabular-nums font-mono text-xs">
                    {fmtCost(s.cost)}
                  </td>
                  <td className="px-4 py-3 text-text-muted tabular-nums">
                    {fmtDuration(durationMs(s))}
                  </td>
                  <td className="px-4 py-3 text-text-muted tabular-nums">{fmtAge(s.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// useTrends hook

function useTrends(days: number) {
  return useQuery<TrendsResponse>({
    queryKey: ['stats-trends', days],
    queryFn: async () => {
      const url = days === 0 ? '/api/stats/trends?days=0' : `/api/stats/trends?days=${days}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<TrendsResponse>;
    },
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Trend charts

function _fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TrendChartProps {
  title: string;
  description: string;
  data: Array<Record<string, unknown>>;
  config: ChartConfig;
  series: Array<{ dataKey: string; stackId?: string }>;
  yAxisDomain?: [number, number];
  yAxisFormatter?: (v: number) => string;
}

function TrendChart({
  title,
  description,
  data,
  config,
  series,
  yAxisDomain,
  yAxisFormatter,
}: TrendChartProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-text-dim">{description}</p>
      </div>
      {data.length === 0 ? (
        <div className="h-[180px] flex items-center justify-center text-text-dim text-sm">
          No data available
        </div>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[180px] w-full">
          <BarChart
            data={data}
            margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            barCategoryGap="20%"
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(t: number) => fmtDate(new Date(t).toISOString())}
              minTickGap={40}
            />
            <YAxis
              type="number"
              domain={yAxisDomain}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={
                yAxisFormatter ??
                ((v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)))
              }
              width={55}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  labelFormatter={(label, payload) => {
                    if (!payload.length) return String(label);
                    const p = payload[0] as unknown as Record<string, unknown>;
                    const time = (p?.payload as unknown as Record<string, unknown>)?.time as
                      | number
                      | undefined;
                    return time ? fmtDate(new Date(time).toISOString()) : String(label);
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((s) => {
              const entry = config[s.dataKey] as { color?: string } | undefined;
              const color = entry?.color ?? `var(--color-${s.dataKey})`;
              return (
                <Bar
                  key={s.dataKey}
                  dataKey={s.dataKey}
                  fill={color}
                  radius={0}
                  stackId={s.stackId}
                />
              );
            })}
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}

function TrendCharts({ trends }: { trends: TrendsResponse }) {
  const { trendPoints, modelTrendPoints } = trends;

  // Build chart data with time as Unix ms
  const runsData = useMemo(
    () =>
      trendPoints.map((p) => ({
        time: new Date(p.date).getTime(),
        succeeded: p.succeeded,
        failed: p.failed,
      })),
    [trendPoints],
  );

  const successRateData = useMemo(
    () =>
      trendPoints.map((p) => ({
        time: new Date(p.date).getTime(),
        successRate: p.successRate,
      })),
    [trendPoints],
  );

  const tokenData = useMemo(
    () =>
      trendPoints.map((p) => ({
        time: new Date(p.date).getTime(),
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
      })),
    [trendPoints],
  );

  const costData = useMemo(
    () =>
      trendPoints.map((p) => ({
        time: new Date(p.date).getTime(),
        cost: p.cost,
      })),
    [trendPoints],
  );

  // Build model trend data
  const modelData = useMemo(() => {
    if (modelTrendPoints.length === 0) return [];
    return modelTrendPoints.map((p) => {
      const { date, ...rest } = p;
      return { time: new Date(date).getTime(), ...rest };
    });
  }, [modelTrendPoints]);

  const models =
    modelTrendPoints.length > 0 ? Object.keys(modelTrendPoints[0]).filter((k) => k !== 'date') : [];

  const chartConfig: ChartConfig = {
    succeeded: { label: 'Succeeded', color: 'var(--chart-1)' },
    failed: { label: 'Failed', color: 'var(--chart-2)' },
    successRate: { label: 'Success Rate', color: 'var(--chart-1)' },
    tokensIn: { label: 'Tokens In', color: 'var(--chart-1)' },
    tokensOut: { label: 'Tokens Out', color: 'var(--chart-2)' },
    cost: { label: 'Cost ($)', color: 'var(--chart-4)' },
    ...Object.fromEntries(
      models.map((m, i) => [
        m,
        { label: shortModelLabel(m), color: `var(--chart-${(i % 5) + 1})` },
      ]),
    ),
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <TrendChart
        title="Runs"
        description="Succeeded vs failed runs over time"
        data={runsData}
        config={chartConfig}
        series={[{ dataKey: 'succeeded' }, { dataKey: 'failed' }]}
      />
      <TrendChart
        title="Success Rate"
        description="Percentage of successful runs"
        data={successRateData}
        config={chartConfig}
        series={[{ dataKey: 'successRate' }]}
        yAxisDomain={[0, 100]}
        yAxisFormatter={(v) => `${v}%`}
      />
      <TrendChart
        title="Token Usage"
        description="Tokens in vs out over time"
        data={tokenData}
        config={chartConfig}
        series={[{ dataKey: 'tokensIn' }, { dataKey: 'tokensOut' }]}
      />
      <TrendChart
        title="Cost Over Time"
        description="Aggregate LLM cost per day"
        data={costData}
        config={chartConfig}
        series={[{ dataKey: 'cost' }]}
        yAxisFormatter={(v: number) => fmtCost(v)}
      />
      {models.length > 0 ? (
        <TrendChart
          title="Tokens per Model"
          description="Token volume by model over time"
          data={modelData}
          config={chartConfig}
          series={models.map((m) => ({ dataKey: m, stackId: 'models' }))}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold">Tokens per Model</h3>
            <p className="text-xs text-text-dim">No model data available</p>
          </div>
          <div className="h-[180px] flex items-center justify-center text-text-dim text-sm">
            No data available
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent charts

const METRIC_OPTIONS = [
  { value: 'successRate', label: 'Success Rate' },
  { value: 'runs', label: 'Runs' },
  { value: 'avgTokensPerRun', label: 'Avg Tokens / Run' },
  { value: 'totalCost', label: 'Total Cost' },
  { value: 'avgDurationMs', label: 'Avg Duration' },
] as const;

function AgentCharts({ agents }: { agents: AgentSummary[] }) {
  const [metric, setMetric] = useState<string>('successRate');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // Chart data for bar chart
  const chartData = useMemo(() => {
    const metricKey = metric as keyof AgentSummary;
    return agents
      .map((a) => ({
        agent: shortModelLabel(a.agent),
        value:
          metricKey === 'avgDurationMs'
            ? (a.avgDurationMs ?? 0) / 1000
            : typeof a[metricKey] === 'number'
              ? (a[metricKey] as number)
              : 0,
        raw: a,
      }))
      .sort((a, b) => b.value - a.value);
  }, [agents, metric]);

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-raised p-8 text-center text-text-dim">
        No agent data available.
      </div>
    );
  }

  const chartConfig = {
    value: {
      label: METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? metric,
      color: 'var(--chart-1)',
    },
  } satisfies ChartConfig;

  const fmt = (v: number) => {
    if (metric === 'successRate') return `${Math.round(v)}%`;
    if (metric === 'avgDurationMs') return fmtDuration(Math.round(v * 1000));
    if (metric === 'avgTokensPerRun') return fmtTokens(Math.round(v));
    if (metric === 'totalCost') return fmtCost(v);
    return String(Math.round(v));
  };

  return (
    <div className="space-y-6">
      {/* Per-agent summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((a) => (
          <button
            key={a.agent}
            onClick={() => setSelectedAgent(selectedAgent === a.agent ? null : a.agent)}
            className={`rounded-lg border p-4 text-left transition-colors ${
              selectedAgent === a.agent
                ? 'border-accent/60 bg-surface-overlay'
                : 'border-border bg-surface-raised hover:border-border-muted'
            }`}
          >
            <p className="text-sm font-medium text-text truncate">{shortModelLabel(a.agent)}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-text-dim">
              <span>
                {a.runs} run{a.runs !== 1 ? 's' : ''}
              </span>
              <span
                className={
                  a.successRate != null && a.successRate >= 80
                    ? 'text-phase-succeeded'
                    : 'text-phase-failed'
                }
              >
                {a.successRate != null ? `${a.successRate}%` : '-'} ok
              </span>
              <span>{fmtTokens(a.totalTokensIn + a.totalTokensOut)} tok</span>
              <span>{fmtCost(a.totalCost)}</span>
              <span>{fmtDuration(a.avgDurationMs)}</span>
            </div>
            {selectedAgent === a.agent && a.models.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border-muted">
                <p className="text-xs text-text-dim mb-1">Models:</p>
                <div className="flex flex-wrap gap-1">
                  {a.models.map((m) => (
                    <span
                      key={m}
                      className="px-1.5 py-0.5 text-xs bg-surface-overlay rounded font-mono text-text-muted"
                    >
                      {shortModelLabel(m)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Metric selector + bar chart */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-muted">Comparison</h2>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="px-2 py-1 text-xs rounded-md border border-border bg-surface-overlay text-text focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {METRIC_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 40, left: 0, bottom: 0 }}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v: number) => {
                  if (metric === 'successRate') return `${v}%`;
                  if (metric === 'avgDurationMs') return `${v}s`;
                  if (metric === 'avgTokensPerRun')
                    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
                  return String(v);
                }}
                width={60}
              />
              <YAxis
                dataKey="agent"
                type="category"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={140}
                tick={(props) => {
                  const { x, y, payload } = props;
                  const label =
                    chartData.find((d) => d.agent === payload.value)?.raw.agent ?? payload.value;
                  return (
                    <text x={x} y={y} dy={4} textAnchor="end" className="text-xs fill-text-dim">
                      {shortModelLabel(label)}
                    </text>
                  );
                }}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--surface-overlay)' }}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(value, _name) =>
                      fmt(typeof value === 'number' ? value : Number(value) || 0)
                    }
                  />
                }
              />
              <Bar dataKey="value" fill="var(--color-value)" radius={0} />
            </BarChart>
          </ChartContainer>
        </div>
      </div>

      {/* Agent detail table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
              <th className="px-4 py-2.5 font-medium">Agent</th>
              <th className="px-4 py-2.5 font-medium">Runs</th>
              <th className="px-4 py-2.5 font-medium">Succeeded</th>
              <th className="px-4 py-2.5 font-medium">Failed</th>
              <th className="px-4 py-2.5 font-medium">Success Rate</th>
              <th className="px-4 py-2.5 font-medium">Avg Tokens</th>
              <th className="px-4 py-2.5 font-medium">Avg Duration</th>
              <th className="px-4 py-2.5 font-medium">Total Cost</th>
              <th className="px-4 py-2.5 font-medium">Tokens In/Out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {agents.map((a) => (
              <tr key={a.agent} className="hover:bg-surface-raised/60 transition-colors">
                <td
                  className="px-4 py-2.5 font-mono text-xs text-text max-w-[160px] truncate"
                  title={a.agent}
                >
                  {shortModelLabel(a.agent)}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-text-muted">{a.runs}</td>
                <td className="px-4 py-2.5 tabular-nums text-phase-succeeded">{a.succeeded}</td>
                <td className="px-4 py-2.5 tabular-nums text-phase-failed">{a.failed}</td>
                <td className="px-4 py-2.5 tabular-nums">
                  <span
                    className={
                      a.successRate != null && a.successRate >= 80
                        ? 'text-phase-succeeded'
                        : 'text-phase-failed'
                    }
                  >
                    {a.successRate != null ? `${a.successRate}%` : '-'}
                  </span>
                </td>
                <td className="px-4 py-2.5 tabular-nums font-mono text-xs text-text-muted">
                  {fmtTokens(a.avgTokensPerRun)}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-text-muted">
                  {fmtDuration(a.avgDurationMs)}
                </td>
                <td className="px-4 py-2.5 tabular-nums font-mono text-xs text-text-muted">
                  {fmtCost(a.totalCost)}
                </td>
                <td className="px-4 py-2.5 tabular-nums font-mono text-xs text-text-muted">
                  {fmtTokens(a.totalTokensIn)} / {fmtTokens(a.totalTokensOut)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs

const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'sessions', label: 'Sessions', icon: List },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'models', label: 'Models', icon: Table2 },
  { id: 'tools', label: 'Tools', icon: Wrench },
] as const;

type TabId = (typeof TABS)[number]['id'];

function Pagination({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-3">
      <span className="text-xs text-text-dim">
        {offset + 1}–{Math.min(offset + limit, total)} of {total} sessions
      </span>
      <div className="flex items-center gap-2">
        <button
          disabled={offset === 0}
          onClick={() => onChange(offset - limit)}
          className="px-3 py-1 text-xs rounded-md border border-border bg-surface-raised text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <span className="text-xs text-text-dim tabular-nums">
          {currentPage} / {totalPages}
        </span>
        <button
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
          className="px-3 py-1 text-xs rounded-md border border-border bg-surface-raised text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view

const DAY_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
  { label: 'All', value: 0 },
];

export default function StatsView() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<TabId>('overview');
  const [page, setPage] = useState(0);
  const [openRunName, setOpenRunName] = useState<string | null>(null);
  const { data, error, isLoading, isFetching } = useStats(days, page);
  const { data: trends } = useTrends(days);

  // Clear open session when pagination/day changes to avoid stale detail panes
  useEffect(() => {
    setOpenRunName(null);
  }, []);

  if (page > 0 && data != null && data.offset >= data.total) {
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-headline-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-text-muted" />
            Stats
          </h1>
          <p className="text-caption-xs text-text-muted">
            {data ? `${data.total} sessions` : 'Loading...'}
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setDays(opt.value);
                setPage(0);
              }}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                days === opt.value
                  ? 'border-accent/60 bg-surface-overlay text-text'
                  : 'border-border-muted text-text-dim hover:border-border hover:text-text-muted'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 border-b border-border overflow-x-auto sm:overflow-visible">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                tab === t.id
                  ? 'border-primary text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {t.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
          <h2 className="text-headline-md mb-1">Failed to load stats</h2>
          <p className="text-caption-xs">{(error as Error).message}</p>
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          <div className="grid grid-cols-7 gap-3">
            {[0, 1, 2, 3, 4, 5, 6].map((k) => (
              <div
                key={k}
                className="rounded-lg border border-border bg-surface-raised p-4 h-20 animate-pulse"
              />
            ))}
          </div>
        </div>
      )}

      {!isLoading && data && data.total === 0 && (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No sessions found in this time window.
        </div>
      )}

      {/* Overview tab */}
      {tab === 'overview' && data && data.total > 0 && (
        <>
          <SummaryCards a={data.summary} />
          {trends && <TrendCharts trends={trends} />}
        </>
      )}

      {/* Sessions tab */}
      {tab === 'sessions' && data && data.total > 0 && (
        <>
          <SessionsTable
            sessions={data.sessions}
            openRunName={openRunName}
            onToggleRun={(name) => {
              setOpenRunName((prev) => (prev === name ? null : name));
            }}
          />
          {/* Session detail view */}
          {openRunName != null && (
            <div id={`session-detail-${openRunName}`} className="mt-4">
              <SessionView
                name={openRunName}
                hasSession={true}
                active={false}
                sseConnected={false}
                eventTick={0}
              />
            </div>
          )}
          <Pagination
            total={data.total}
            limit={data.limit}
            offset={data.offset}
            onChange={(o) => setPage(Math.floor(o / PAGE_SIZE))}
          />
        </>
      )}

      {/* Agents tab */}
      {tab === 'agents' && data && data.total > 0 && <AgentCharts agents={data.agentSummaries} />}

      {/* Models tab */}
      {tab === 'models' && data && data.total > 0 && <ModelBreakdown modelRows={data.modelRows} />}

      {/* Tools tab */}
      {tab === 'tools' && <ToolMetricsView days={days} />}
    </div>
  );
}
