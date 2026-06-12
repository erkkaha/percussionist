import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ListFilter, TrendingUp } from "lucide-react";
import StatusBadge from "./StatusBadge";
import TokenCounter from "./TokenCounter";
import { authHeaders } from "../lib/auth";

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

interface SessionsResponse {
  sessions: StatSession[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Helpers

function resolveModel(s: StatSession): string {
  return s.resolvedModel ?? s.model ?? "unknown";
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

function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return "-";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Fetch hook

const PAGE_SIZE = 50;

function useStats(days: number, page: number) {
  return useQuery<SessionsResponse>({
    queryKey: ["stats", days, page],
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
// Day selector options

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

// ---------------------------------------------------------------------------
// Pagination component

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

export default function SessionList() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(0);
  const { data, error, isLoading, isFetching } = useStats(days, page);

  // Clear to page 0 when days or pagination context changes
  if (page > 0 && data != null && data.offset >= data.total) {
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-headline-lg flex items-center gap-2">
            <ListFilter className="w-5 h-5 text-text-muted" />
            Sessions
          </h1>
          <p className="text-caption-xs text-text-muted">
            {data ? `${data.total} sessions` : "Loading..."}
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setDays(opt.value); setPage(0); }}
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

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
          <h2 className="text-headline-md mb-1">Failed to load sessions</h2>
          <p className="text-caption-xs">{(error as Error).message}</p>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg border border-border bg-surface-raised animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && data && data.total === 0 && (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No sessions found in this time window.
        </div>
      )}

      {/* Sessions table */}
      {!isLoading && data && data.total > 0 && (
        <>
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
                {data.sessions.map((s) => (
                  <Link
                    key={s.id}
                    to={`/sessions/${encodeURIComponent(s.name)}`}
                    className="block hover:bg-surface-raised/60 transition-colors"
                  >
                    <tr className="focus:outline-none">
                      <td className="px-4 py-3">
                        <div className="font-medium text-text flex items-center gap-2">
                          {s.name}
                        </div>
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
                      <td className="px-4 py-3 text-text-muted tabular-nums font-mono text-xs">
                        {fmtCost(s.cost)}
                      </td>
                      <td className="px-4 py-3 text-text-muted tabular-nums">
                        {fmtDuration(durationMs(s))}
                      </td>
                      <td className="px-4 py-3 text-text-muted tabular-nums">
                        {fmtAge(s.startedAt)}
                      </td>
                    </tr>
                  </Link>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <Pagination
            total={data.total}
            limit={data.limit}
            offset={data.offset}
            onChange={(o) => setPage(Math.floor(o / PAGE_SIZE))}
          />
        </>
      )}
    </div>
  );
}
