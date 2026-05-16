import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import StatusBadge from "./StatusBadge";
import TokenCounter from "./TokenCounter";

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
// Helpers

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

// Parse tool calls from embedded message content parts (fallback when
// toolCalls array is empty — older dispatcher versions stored them inline).
function extractToolsFromMessages(messages: MessageRow[]): string[] {
  const tools: string[] = [];
  for (const m of messages) {
    if (!m.content) continue;
    try {
      const parts = JSON.parse(m.content) as ContentPart[];
      for (const p of parts) {
        if (p.type === "tool" && p.tool) tools.push(p.tool);
      }
    } catch { /* not JSON */ }
  }
  return tools;
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
      const res = await fetch(url);
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
  toolCounts: { tool: string; count: number }[];
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

  // Tool usage — from toolCalls array, fallback to inline message parsing
  const toolMap = new Map<string, number>();
  for (const s of sessions) {
    const tools = s.toolCalls.length > 0
      ? s.toolCalls.map((t) => t.tool)
      : extractToolsFromMessages(s.messages);
    for (const t of tools) toolMap.set(t, (toolMap.get(t) ?? 0) + 1);
  }
  const toolCounts = [...toolMap.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

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
    toolCounts, modelRows,
  };
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
// Tool usage

function ToolUsage({ toolCounts }: { toolCounts: Analytics["toolCounts"] }) {
  if (toolCounts.length === 0) return null;
  const max = toolCounts[0]?.count ?? 1;
  return (
    <section>
      <h2 className="text-sm font-semibold text-text-muted mb-3">Tool Usage</h2>
      <div className="rounded-lg border border-border bg-surface-raised overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              <th className="px-4 py-2.5 font-medium">Tool</th>
              <th className="px-4 py-2.5 font-medium">Calls</th>
              <th className="px-4 py-2.5 font-medium w-1/2">Distribution</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-muted">
            {toolCounts.map(({ tool, count }) => (
              <tr key={tool} className="hover:bg-surface-raised/60">
                <td className="px-4 py-2.5 font-mono text-xs text-text">{tool}</td>
                <td className="px-4 py-2.5 tabular-nums text-text-muted">{count}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-surface-overlay rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full bg-[#d97706] rounded-full"
                        style={{ width: `${(count / max) * 100}%` }}
                      />
                    </div>
                  </div>
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
                      className="flex h-2 rounded-full overflow-hidden bg-surface-overlay"
                      style={{ width: `${barWidth}%`, minWidth: "20px" }}
                      title={`In: ${fmtTokens(tokensIn)} (${inPct.toFixed(0)}%) / Out: ${fmtTokens(tokensOut)} (${outPct.toFixed(0)}%)`}
                    >
                      <div className="bg-[#d97706]" style={{ width: `${inPct}%` }} />
                      <div className="bg-[#5c4a3a]" style={{ width: `${outPct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-text-dim border-t border-border-muted">
          Bar: <span className="text-text-dim">■</span> tokens in &nbsp;
          <span className="text-text-muted">■</span> tokens out
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tokens per run bar chart

function TokensChart({ sessions }: { sessions: StatSession[] }) {
  const sorted = [...sessions]
    .filter((s) => (s.tokensIn ?? 0) + (s.tokensOut ?? 0) > 0)
    .sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut))
    .slice(0, 20); // top 20 to keep it readable

  if (sorted.length === 0) return null;

  const first = sorted[0];
  const maxTokens = first ? first.tokensIn + first.tokensOut : 1;

  return (
    <section>
      <h2 className="text-sm font-semibold text-text-muted mb-3">
        Tokens per Run {sessions.length > 20 && <span className="font-normal text-text-dim">(top 20)</span>}
      </h2>
      <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-2">
        {sorted.map((s) => {
          const total = s.tokensIn + s.tokensOut;
          const inPct = (s.tokensIn / maxTokens) * 100;
          const outPct = (s.tokensOut / maxTokens) * 100;
          return (
            <div key={s.id} className="flex items-center gap-3 text-xs">
              <div className="w-32 shrink-0 truncate text-text-muted font-mono" title={s.name}>
                {s.name}
              </div>
              <div className="flex-1 flex h-3 rounded-sm overflow-hidden bg-surface-overlay gap-px">
                <div
                  className="bg-[#d97706] rounded-l-sm"
                  style={{ width: `${inPct}%` }}
                  title={`In: ${fmtTokens(s.tokensIn)}`}
                />
                <div
                  className="bg-[#5c4a3a] rounded-r-sm"
                  style={{ width: `${outPct}%` }}
                  title={`Out: ${fmtTokens(s.tokensOut)}`}
                />
              </div>
              <div className="w-16 shrink-0 text-right tabular-nums text-text-dim">
                {fmtTokens(total)}
              </div>
            </div>
          );
        })}
        <p className="text-xs text-text-dim pt-1">
          <span className="text-text-dim">■</span> tokens in &nbsp;
          <span className="text-text-muted">■</span> tokens out
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
      <h2 className="text-sm font-semibold text-text-muted mb-3">Sessions</h2>
      <div className="rounded-lg border border-border overflow-hidden">
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
// Main view

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

export default function StatsView() {
  const [days, setDays] = useState(30);
  const { data: sessions, error, isLoading, isFetching } = useStats(days);

  const analytics = sessions ? computeAnalytics(sessions) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Stats</h1>
          <p className="text-sm text-text-muted">
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

      {error && (
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
          <h2 className="text-lg font-semibold mb-1">Failed to load stats</h2>
          <p className="text-sm">{(error as Error).message}</p>
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

      {analytics && sessions && (
        <>
          <SummaryCards a={analytics} />

          {sessions.length === 0 ? (
            <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
              No sessions found in this time window.
            </div>
          ) : (
            <>
              {/* Two-column section: tool usage + model breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ToolUsage toolCounts={analytics.toolCounts} />
                <ModelBreakdown modelRows={analytics.modelRows} />
              </div>

              <TokensChart sessions={sessions} />
              <SessionsTable sessions={sessions} />
            </>
          )}
        </>
      )}
    </div>
  );
}
