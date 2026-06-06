import { useState } from "react";
import { Link } from "react-router-dom";
import { useRuns } from "../hooks/useRuns";
import { useRunsEvents } from "../hooks/useRunsEvents";
import StatusBadge from "./StatusBadge";
import TokenCounter from "./TokenCounter";
import OpenOpencodeButton from "./OpenOpencodeButton";
import type { RunPhase, Run } from "../lib/types";
import { TERMINAL_PHASES } from "../lib/types";
import { Button } from "./ui/button";
const ALL_PHASES: RunPhase[] = [
  "Pending",
  "Initializing",
  "Running",
  "Succeeded",
  "Failed",
  "Cancelled",
];

function age(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

type SortField = "name" | "phase" | "age" | "tokensIn";
type SortDir = "asc" | "desc";

export default function RunList() {
  const { connected: runsSseConnected, eventTick } = useRunsEvents();
  void eventTick;
  const { data: runs, error, isLoading, isFetching } = useRuns(
    runsSseConnected ? false : 5_000,
  );
  const [phaseFilter, setPhaseFilter] = useState<RunPhase | "All">("All");
  const [sortField, setSortField] = useState<SortField>("age");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "age" ? "desc" : "asc");
    }
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u2191" : " \u2193";
  }

  const filtered =
    runs?.filter(
      (r) => phaseFilter === "All" || r.status?.phase === phaseFilter,
    ) ?? [];

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortField) {
      case "name":
        return dir * a.metadata.name.localeCompare(b.metadata.name);
      case "phase":
        return dir * (a.status?.phase ?? "").localeCompare(b.status?.phase ?? "");
      case "tokensIn":
        return dir * ((a.status?.tokensIn ?? 0) - (b.status?.tokensIn ?? 0));
      case "age": {
        const aTime = new Date(a.metadata.creationTimestamp ?? 0).getTime();
        const bTime = new Date(b.metadata.creationTimestamp ?? 0).getTime();
        return dir * (aTime - bTime);
      }
      default:
        return 0;
    }
  });

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Failed to load runs</h2>
        <p className="text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Runs</h1>
          <p className="text-sm text-text-muted">
            {runs ? `${runs.length} total` : "Loading..."}
            {isFetching && !isLoading && (
              <span className="ml-2 text-text-dim animate-pulse">refreshing</span>
            )}
          </p>
          <p className="text-xs text-text-dim mt-0.5">
            Updates: {runsSseConnected ? "live stream" : "polling fallback"}
          </p>
        </div>
        <Link
          to="/runs/new"
        >
          <Button variant="secondary" size="sm">+ New Run</Button>
        </Link>
      </div>

      {/* Phase filter */}
      <div className="flex gap-1.5 flex-wrap">
        <FilterButton
          active={phaseFilter === "All"}
          onClick={() => setPhaseFilter("All")}
          count={runs?.length}
        >
          All
        </FilterButton>
        {ALL_PHASES.map((p) => {
          const count = runs?.filter((r) => r.status?.phase === p).length;
          return (
            <FilterButton
              key={p}
              active={phaseFilter === p}
              onClick={() => setPhaseFilter(p)}
              count={count}
            >
              {p}
            </FilterButton>
          );
        })}
      </div>

      {/* Table */}
      {isLoading ? (
        <TableSkeleton />
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          {runs?.length === 0
            ? "No Runs in this namespace."
            : `No runs matching phase "${phaseFilter}".`}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
                <Th onClick={() => handleSort("name")}>
                  Name{sortIndicator("name")}
                </Th>
                <Th onClick={() => handleSort("phase")}>
                  Phase{sortIndicator("phase")}
                </Th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Session</th>
                <Th onClick={() => handleSort("tokensIn")}>
                  Tokens{sortIndicator("tokensIn")}
                </Th>
                <Th onClick={() => handleSort("age")}>
                  Age{sortIndicator("age")}
                </Th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted">
              {sorted.map((run) => (
                <RunRow key={run.metadata.uid ?? run.metadata.name} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function RunRow({ run }: { run: Run }) {
  const phase = run.status?.phase;
  const isActive = !phase || !TERMINAL_PHASES.has(phase);
  const isFailed = phase === "Failed";
  const errorMsg = isFailed ? run.status?.message : undefined;
  return (
    <tr className="hover:bg-surface-raised/60 transition-colors">
      <td className="px-4 py-3">
        <Link
          to={`/runs/${encodeURIComponent(run.metadata.name)}`}
          className="font-medium text-text hover:text-white underline-offset-2 hover:underline"
        >
          {run.metadata.name}
        </Link>
        {errorMsg && (
          <p className="text-xs text-phase-failed/80 mt-0.5 font-mono truncate max-w-xs" title={errorMsg}>
            {errorMsg}
          </p>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusBadge phase={run.status?.phase} title={errorMsg} />
      </td>
      <td className="px-4 py-3 text-text-muted">{run.spec.agent ?? "-"}</td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">
        {run.spec.model ?? "-"}
      </td>
      <td className="px-4 py-3 text-text-muted font-mono text-xs">
        {run.status?.sessionID ? truncate(run.status.sessionID, 16) : "-"}
      </td>
      <td className="px-4 py-3">
        <TokenCounter
          tokensIn={run.status?.tokensIn}
          tokensOut={run.status?.tokensOut}
        />
      </td>
      <td className="px-4 py-3 text-text-muted tabular-nums">
        {age(run.metadata.creationTimestamp)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {isActive && <AttachButton name={run.metadata.name} namespace={run.metadata.namespace} />}
          <OpenOpencodeButton run={run} compact />
          <Link to={`/runs/new?copyFrom=${encodeURIComponent(run.metadata.name)}`}>
            <Button variant="outline" size="sm">Copy</Button>
          </Link>
        </div>
      </td>
    </tr>
  );
}

function Th({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <th
      className="px-4 py-2.5 font-medium cursor-pointer select-none hover:text-text transition-colors"
      onClick={onClick}
    >
      {children}
    </th>
  );
}

function FilterButton({
  children,
  active,
  onClick,
  count,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent/60 bg-surface-overlay text-text"
          : "border-border-muted text-text-dim hover:border-border hover:text-text-muted"
      }`}
    >
      {children}
      {count != null && (
        <span className="ml-1 text-text-dim">{count}</span>
      )}
    </Button>
  );
}

function TableSkeleton() {
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <div className="divide-y divide-border-muted">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="px-4 py-4 flex gap-6">
            <div className="h-4 w-32 rounded bg-surface-overlay animate-pulse" />
            <div className="h-4 w-20 rounded bg-surface-overlay animate-pulse" />
            <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
            <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse" />
            <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

const DEFAULT_NAMESPACE = "percussionist";

function attachCommand(name: string, namespace: string | undefined): string {
  const ns = namespace ?? DEFAULT_NAMESPACE;
  return ns === DEFAULT_NAMESPACE
    ? `beatctl attach ${name}`
    : `beatctl attach ${name} -n ${ns}`;
}

function AttachButton({ name, namespace }: { name: string; namespace?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const cmd = attachCommand(name, namespace);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      title={`Copy: ${attachCommand(name, namespace)}`}
      className={`px-2 py-1 text-xs font-medium transition-colors ${
        copied
          ? "border-phase-succeeded/40 text-phase-succeeded bg-phase-succeeded/10"
          : "border-border-muted text-text-dim hover:border-border hover:text-text-muted"
      }`}
    >
      {copied ? "Copied!" : "Attach"}
    </Button>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}
