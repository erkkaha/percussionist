import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { BarChart3, List, Table2, Users, Wrench } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { authHeaders } from "../lib/auth";
import TokenCounter from "./TokenCounter";
import ToolMetricsView from "./ToolMetricsView";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "./ui/chart";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types matching /api/stats/export response

interface MessageRow {
  id: string;
  sessionId: string;
  idx: number;
  role: string | null;
  content: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: string | null;
  completedAt: string | null;
}

interface ToolCallRow {
  id: string;
  sessionId: string;
  messageIdx: number;
  tool: string;
  args: string | null;
  success: boolean | null;
  error: string | null;
  durationMs: number | null;
}

interface FileOpRow {
  sessionId: string;
  messageIdx: number;
  filePath: string;
  operation: string;
}

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
  error: string | null;
  createdAt: string | null;
  messages: MessageRow[];
  toolCalls: ToolCallRow[];
  fileOps: FileOpRow[];
}

// Content part types embedded in message content JSON
interface ContentPart {
  type: string;
  tool?: string;
  text?: string;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
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
  return model.includes("/") ? model.split("/").pop()! : model;
}

function durationMs(s: StatSession): number | null {
  if (!s.startedAt || !s.completedAt) return null;
  const ms = new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime();
  return isNaN(ms) ? null : ms;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "-";
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

// Resolve the model for a session: run row first, fallback to user message.
function resolveModel(s: StatSession): string {
  if (s.model) return s.model;
  const userMsg = s.messages.find((m) => m.role === "user");
  if (userMsg?.model) return userMsg.model;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Fetch hook

function useStats(days: number) {
  return useQuery<StatSession[]>({
    queryKey: ["stats", days],
    queryFn: async () => {
      const url = days === 0 ? "/api/stats/export?days=0" : `/api/stats/export?days=${days}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<StatSession[]>;
    },
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Derived analytics

interface Analytics {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  avgDurationMs: number | null;
  modelRows: { model: string; runs: number; tokensIn: number; tokensOut: number }[];
}

function computeAnalytics(sessions: StatSession[]): Analytics {
  const total = sessions.length;
  const succeeded = sessions.filter((s) => s.phase === "Succeeded").length;
  const failed = sessions.filter((s) => s.phase === "Failed").length;
  const totalTokensIn = sessions.reduce((a, s) => a + (s.tokensIn ?? 0), 0);
  const totalTokensOut = sessions.reduce((a, s) => a + (s.tokensOut ?? 0), 0);

  // Avg duration — only sessions with both timestamps
  const durations = sessions.map(durationMs).filter((d): d is number => d !== null);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  // Model breakdown
  const modelMap = new Map<string, { runs: number; tokensIn: number; tokensOut: number }>();
  for (const s of sessions) {
    const model = resolveModel(s);
    const existing = modelMap.get(model) ?? { runs: 0, tokensIn: 0, tokensOut: 0 };
    modelMap.set(model, {
      runs: existing.runs + 1,
      tokensIn: existing.tokensIn + (s.tokensIn ?? 0),
      tokensOut: existing.tokensOut + (s.tokensOut ?? 0),
    });
  }
  const modelRows = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokensIn - a.tokensIn);

  return {
    total, succeeded, failed,
    successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
    totalTokensIn, totalTokensOut, avgDurationMs,
    modelRows,
  };
}

// ---------------------------------------------------------------------------
// Agent analytics

interface AgentSummary {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  avgTokensPerRun: number;
  avgDurationMs: number | null;
  models: string[];
}

function computeAgentAnalytics(sessions: StatSession[]): AgentSummary[] {
  const agentMap = new Map<string, {
    runs: number; succeeded: number; failed: number;
    tokensIn: number; tokensOut: number; durationSum: number; durationCount: number;
    models: Set<string>;
  }>();

  for (const s of sessions) {
    const agent = s.agent ?? "unknown";
    const existing = agentMap.get(agent) ?? {
      runs: 0, succeeded: 0, failed: 0,
      tokensIn: 0, tokensOut: 0, durationSum: 0, durationCount: 0,
      models: new Set<string>(),
    };

    existing.runs++;
    if (s.phase === "Succeeded") existing.succeeded++;
    else if (s.phase === "Failed") existing.failed++;
    existing.tokensIn += s.tokensIn ?? 0;
    existing.tokensOut += s.tokensOut ?? 0;
    const d = durationMs(s);
    if (d !== null) { existing.durationSum += d; existing.durationCount++; }
    if (s.model) existing.models.add(s.model);
    agentMap.set(agent, existing);
  }

  return [...agentMap.entries()]
    .map(([agent, v]) => ({
      agent,
      runs: v.runs,
      succeeded: v.succeeded,
      failed: v.failed,
      successRate: v.runs > 0 ? Math.round((v.succeeded / v.runs) * 100) : null,
      totalTokensIn: v.tokensIn,
      totalTokensOut: v.tokensOut,
      avgTokensPerRun: v.runs > 0 ? Math.round((v.tokensIn + v.tokensOut) / v.runs) : 0,
      avgDurationMs: v.durationCount > 0 ? Math.round(v.durationSum / v.durationCount) : null,
      models: [...v.models],
    }))
    .sort((a, b) => b.runs - a.runs);
}

// ---------------------------------------------------------------------------
// Summary cards

function SummaryCards({ a }: { a: Analytics }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <MetricCard label="Total Runs" value={a.total} />
      <MetricCard label="Succeeded" value={a.succeeded} color="text-phase-succeeded" />
      <MetricCard label="Failed" value={a.failed} color="text-phase-failed" />
      <MetricCard
        label="Success Rate"
        value={a.successRate != null ? `${a.successRate}%` : "-"}
        color={a.successRate != null && a.successRate >= 80 ? "text-phase-succeeded" : "text-phase-failed"}
      />
      <MetricCard label="Avg Duration" value={fmtDuration(a.avgDurationMs)} />
      <MetricCard label="Tokens In / Out" value={`${fmtTokens(a.totalTokensIn)} / ${fmtTokens(a.totalTokensOut)}`} mono />
    </div>
  );
}

function MetricCard({
  label, value, color = "text-text", mono = false,
}: {
  label: string; value: string | number; color?: string; mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <p className="text-xs text-text-dim mb-1">{label}</p>
      <p className={`font-semibold ${color} ${mono ? "font-mono text-sm mt-1" : "text-2xl"}`}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model breakdown

function ModelBreakdown({ modelRows }: { modelRows: Analytics["modelRows"] }) {
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
              <th className="px-4 py-2.5 font-medium w-1/3">Token Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {modelRows.map(({ model, runs, tokensIn, tokensOut }) => {
              const total = tokensIn + tokensOut;
              const inPct = total > 0 ? (tokensIn / total) * 100 : 0;
              const outPct = total > 0 ? (tokensOut / total) * 100 : 0;
              const barWidth = maxTokens > 0 ? (total / maxTokens) * 100 : 0;
              return (
                <tr key={model} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-text max-w-[200px] truncate" title={model}>
                    {model}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted">{runs}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted font-mono text-xs">
                    {fmtTokens(tokensIn)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-text-muted font-mono text-xs">
                    {fmtTokens(tokensOut)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div
                      className="flex h-2 overflow-hidden bg-surface-overlay"
                      style={{ width: `${barWidth}%`, minWidth: "20px" }}
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

function SessionsTable({ sessions }: { sessions: StatSession[] }) {
  const sorted = [...sessions].sort((a, b) => {
    const at = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bt - at;
  });

  return (
    <section>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Phase</th>
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 font-medium">Tokens</th>
              <th className="px-4 py-2.5 font-medium">Duration</th>
              <th className="px-4 py-2.5 font-medium">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {sorted.map((s) => (
              <tr key={s.id} className="hover:bg-surface-raised/60 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-text">{s.name}</div>
                  {s.task && (
                    <div className="text-xs text-text-dim mt-0.5 truncate max-w-xs" title={s.task}>
                      {s.task}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge phase={s.phase as string | undefined} />
                </td>
                <td className="px-4 py-3 text-text-muted font-mono text-xs max-w-[160px] truncate" title={resolveModel(s)}>
                  {resolveModel(s)}
                </td>
                <td className="px-4 py-3">
                  <TokenCounter tokensIn={s.tokensIn} tokensOut={s.tokensOut} />
                </td>
                <td className="px-4 py-3 text-text-muted tabular-nums">
                  {fmtDuration(durationMs(s))}
                </td>
                <td className="px-4 py-3 text-text-muted tabular-nums">
                  {fmtAge(s.startedAt)}
                </td>
              </tr>
            ))}
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
    queryKey: ["stats-trends", days],
    queryFn: async () => {
      const url = days === 0 ? "/api/stats/trends?days=0" : `/api/stats/trends?days=${days}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<TrendsResponse>;
    },
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Trend charts

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface TrendChartProps {
  title: string;
  description: string;
  data: Array<Record<string, unknown>>;
  config: ChartConfig;
  series: Array<{ dataKey: string; stackId?: string }>;
  type: "area" | "line";
  yAxisDomain?: [number, number];
  yAxisFormatter?: (v: number) => string;
}

function TrendChart({ title, description, data, config, series, type, yAxisDomain, yAxisFormatter }: TrendChartProps) {
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
          {type === "area" ? (
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
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
                tickFormatter={yAxisFormatter ?? ((v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                width={55}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(label, payload) => {
                      if (!payload.length) return String(label);
                      const p = payload[0] as Record<string, unknown>;
                      const time = (p?.payload as Record<string, unknown>)?.time as number | undefined;
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
                  <Area
                    key={s.dataKey}
                    dataKey={s.dataKey}
                    type="monotone"
                    fill={color}
                    fillOpacity={s.stackId ? 0.85 : 0.35}
                    stroke={color}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                    stackId={s.stackId}
                  />
                );
              })}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(t: number) => fmtDate(new Date(t).toISOString())}
                minTickGap={40}
              />
              <YAxis
                type="number"
                domain={yAxisDomain}
                allowDataOverflow
                ticks={yAxisDomain ? [0, 20, 40, 60, 80, 100] : undefined}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={yAxisFormatter ?? ((v: number) => `${v}%`)}
                width={48}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(label, payload) => {
                      if (!payload.length) return String(label);
                      const p = payload[0] as Record<string, unknown>;
                      const time = (p?.payload as Record<string, unknown>)?.time as number | undefined;
                      return time ? fmtDate(new Date(time).toISOString()) : String(label);
                    }}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {series.map((s) => (
                <Line
                  key={s.dataKey}
                  dataKey={s.dataKey}
                  type="monotone"
                  stroke={`var(--color-${s.dataKey})`}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      )}
    </div>
  );
}

function TrendCharts({ trends }: { trends: TrendsResponse }) {
  const { trendPoints, modelTrendPoints } = trends;

  // Build chart data with time as Unix ms
  const runsData = useMemo(() =>
    trendPoints.map((p) => ({
      time: new Date(p.date).getTime(),
      succeeded: p.succeeded,
      failed: p.failed,
    })),
    [trendPoints]
  );

  const successRateData = useMemo(() =>
    trendPoints.map((p) => ({
      time: new Date(p.date).getTime(),
      successRate: p.successRate,
    })),
    [trendPoints]
  );

  const tokenData = useMemo(() =>
    trendPoints.map((p) => ({
      time: new Date(p.date).getTime(),
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
    })),
    [trendPoints]
  );

  // Build model trend data
  const modelData = useMemo(() => {
    if (modelTrendPoints.length === 0) return [];
    return modelTrendPoints.map((p) => {
      const { date, ...rest } = p;
      return { time: new Date(date).getTime(), ...rest };
    });
  }, [modelTrendPoints]);

  const models = modelTrendPoints.length > 0
    ? Object.keys(modelTrendPoints[0]!).filter((k) => k !== "date")
    : [];

  const chartConfig: ChartConfig = {
    succeeded: { label: "Succeeded", color: "var(--chart-1)" },
    failed: { label: "Failed", color: "var(--chart-2)" },
    successRate: { label: "Success Rate", color: "var(--chart-1)" },
    tokensIn: { label: "Tokens In", color: "var(--chart-1)" },
    tokensOut: { label: "Tokens Out", color: "var(--chart-2)" },
    ...Object.fromEntries(models.map((m, i) => [m, { label: shortModelLabel(m), color: `var(--chart-${(i % 5) + 1})` }])),
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <TrendChart
        title="Runs"
        description="Succeeded vs failed runs over time"
        data={runsData}
        config={chartConfig}
        series={[
          { dataKey: "succeeded" },
          { dataKey: "failed" },
        ]}
        type="area"
      />
      <TrendChart
        title="Success Rate"
        description="Percentage of successful runs"
        data={successRateData}
        config={chartConfig}
        series={[{ dataKey: "successRate" }]}
        type="line"
        yAxisDomain={[0, 100]}
        yAxisFormatter={(v) => `${v}%`}
      />
      <TrendChart
        title="Token Usage"
        description="Tokens in vs out over time"
        data={tokenData}
        config={chartConfig}
        series={[
          { dataKey: "tokensIn" },
          { dataKey: "tokensOut" },
        ]}
        type="area"
      />
      {models.length > 0 ? (
        <TrendChart
          title="Tokens per Model"
          description="Token volume by model over time"
          data={modelData}
          config={chartConfig}
          series={models.map((m) => ({ dataKey: m, stackId: "models" }))}
          type="area"
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
  { value: "successRate", label: "Success Rate" },
  { value: "runs", label: "Runs" },
  { value: "avgTokensPerRun", label: "Avg Tokens / Run" },
  { value: "avgDurationMs", label: "Avg Duration" },
] as const;

function AgentCharts({ agents }: { agents: AgentSummary[] }) {
  const [metric, setMetric] = useState<string>("successRate");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-raised p-8 text-center text-text-dim">
        No agent data available.
      </div>
    );
  }

  // Chart data for bar chart
  const chartData = useMemo(() => {
    const metricKey = metric as keyof AgentSummary;
    return agents.map((a) => ({
      agent: shortModelLabel(a.agent),
      value: metricKey === "avgDurationMs" ? (a.avgDurationMs ?? 0) / 1000 : typeof a[metricKey] === "number" ? a[metricKey] as number : 0,
      raw: a,
    })).sort((a, b) => b.value - a.value);
  }, [agents, metric]);

  const chartConfig = {
    value: {
      label: METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? metric,
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig;

  const fmt = (v: number) => {
    if (metric === "successRate") return `${Math.round(v)}%`;
    if (metric === "avgDurationMs") return fmtDuration(Math.round(v * 1000));
    if (metric === "avgTokensPerRun") return fmtTokens(Math.round(v));
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
                ? "border-accent/60 bg-surface-overlay"
                : "border-border bg-surface-raised hover:border-border-muted"
            }`}
          >
            <p className="text-sm font-medium text-text truncate">{shortModelLabel(a.agent)}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-text-dim">
              <span>{a.runs} run{a.runs !== 1 ? "s" : ""}</span>
              <span className={a.successRate != null && a.successRate >= 80 ? "text-phase-succeeded" : "text-phase-failed"}>
                {a.successRate != null ? `${a.successRate}%` : "-"} ok
              </span>
              <span>{fmtTokens(a.totalTokensIn + a.totalTokensOut)} tok</span>
              <span>{fmtDuration(a.avgDurationMs)}</span>
            </div>
            {selectedAgent === a.agent && a.models.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border-muted">
                <p className="text-xs text-text-dim mb-1">Models:</p>
                <div className="flex flex-wrap gap-1">
                  {a.models.map((m) => (
                    <span key={m} className="px-1.5 py-0.5 text-xs bg-surface-overlay rounded font-mono text-text-muted">
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
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 40, left: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v: number) => {
                  if (metric === "successRate") return `${v}%`;
                  if (metric === "avgDurationMs") return `${v}s`;
                  if (metric === "avgTokensPerRun") return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
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
                  const label = chartData.find((d) => d.agent === payload.value)?.raw.agent ?? payload.value;
                  return (
                    <text x={x} y={y} dy={4} textAnchor="end" className="text-xs fill-text-dim">
                      {shortModelLabel(label)}
                    </text>
                  );
                }}
              />
              <ChartTooltip
                cursor={{ fill: "var(--surface-overlay)" }}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(value, _name) => fmt(typeof value === "number" ? value : Number(value) || 0)}
                  />
                }
              />
              <Bar
                dataKey="value"
                fill="var(--color-value)"
                radius={[0, 3, 3, 0]}
              />
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
              <th className="px-4 py-2.5 font-medium">Tokens In/Out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {agents.map((a) => (
              <tr key={a.agent} className="hover:bg-surface-raised/60 transition-colors">
                <td className="px-4 py-2.5 font-mono text-xs text-text max-w-[160px] truncate" title={a.agent}>
                  {shortModelLabel(a.agent)}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-text-muted">{a.runs}</td>
                <td className="px-4 py-2.5 tabular-nums text-phase-succeeded">{a.succeeded}</td>
                <td className="px-4 py-2.5 tabular-nums text-phase-failed">{a.failed}</td>
                <td className="px-4 py-2.5 tabular-nums">
                  <span className={a.successRate != null && a.successRate >= 80 ? "text-phase-succeeded" : "text-phase-failed"}>
                    {a.successRate != null ? `${a.successRate}%` : "-"}
                  </span>
                </td>
                <td className="px-4 py-2.5 tabular-nums font-mono text-xs text-text-muted">
                  {fmtTokens(a.avgTokensPerRun)}
                </td>
                <td className="px-4 py-2.5 tabular-nums text-text-muted">
                  {fmtDuration(a.avgDurationMs)}
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
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "sessions", label: "Sessions", icon: List },
  { id: "agents", label: "Agents", icon: Users },
  { id: "models", label: "Models", icon: Table2 },
  { id: "tools", label: "Tools", icon: Wrench },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ---------------------------------------------------------------------------
// Main view

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

export default function StatsView() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<TabId>("overview");
  const { data: sessions, error, isLoading, isFetching } = useStats(days);
  const { data: trends } = useTrends(days);

  const analytics = sessions ? computeAnalytics(sessions) : null;
  const agentSummaries = useMemo(() => sessions ? computeAgentAnalytics(sessions) : null, [sessions]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-headline-lg">Stats</h1>
          <p className="text-caption-xs text-text-muted">
            {sessions ? `${sessions.length} sessions` : "Loading..."}
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                days === opt.value
                  ? "border-accent/60 bg-surface-overlay text-text"
                  : "border-border-muted text-text-dim hover:border-border hover:text-text-muted"
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
                "flex items-center gap-1.5 shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
                tab === t.id
                  ? "border-primary text-text"
                  : "border-transparent text-text-muted hover:text-text",
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
          <div className="grid grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-surface-raised p-4 h-20 animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {analytics && sessions && sessions.length === 0 && (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No sessions found in this time window.
        </div>
      )}

      {/* Overview tab */}
      {tab === "overview" && analytics && sessions && sessions.length > 0 && (
        <>
          <SummaryCards a={analytics} />
          {trends && <TrendCharts trends={trends} />}
        </>
      )}

      {/* Sessions tab */}
      {tab === "sessions" && analytics && sessions && sessions.length > 0 && (
        <SessionsTable sessions={sessions} />
      )}

      {/* Agents tab */}
      {tab === "agents" && agentSummaries && sessions && sessions.length > 0 && (
        <AgentCharts agents={agentSummaries} />
      )}

      {/* Models tab */}
      {tab === "models" && analytics && sessions && sessions.length > 0 && (
        <ModelBreakdown modelRows={analytics.modelRows} />
      )}

      {/* Tools tab */}
      {tab === "tools" && (
        <ToolMetricsView days={days} />
      )}
    </div>
  );
}
