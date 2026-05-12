import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useKanbans } from "../hooks/useKanbans";
import { deleteKanban } from "../lib/api";
import type { OpenCodeKanban } from "../lib/types";

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
  return `${Math.floor(h / 24)}d`;
}

function phaseBadge(phase?: string) {
  if (!phase) return <span className="text-text-dim">-</span>;
  const cls =
    phase === "Active"
      ? "bg-phase-running/20 text-phase-running border-phase-running/30"
      : phase === "Complete"
        ? "bg-zinc-500/20 text-zinc-400 border-zinc-600/30"
        : "bg-surface-overlay/20 text-text-dim border-border-muted";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium border ${cls}`}>
      {phase}
    </span>
  );
}

function KanbanRow({ kanban }: { kanban: OpenCodeKanban }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteKanban(kanban.metadata.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kanbans"] });
    },
  });

  const backlog = kanban.status?.backlog ?? {};
  const columns = ["ready", "in-progress", "review", "rework", "done"];

  return (
    <tr className="hover:bg-surface-raised/60 transition-colors">
      <td className="px-4 py-3 font-medium text-text font-mono text-sm">
        {kanban.metadata.name}
      </td>
      <td className="px-4 py-3 text-text-muted text-sm">
        {kanban.spec.displayName ?? "-"}
      </td>
      <td className="px-4 py-3">{phaseBadge(kanban.status?.phase)}</td>
      <td className="px-4 py-3 text-center font-mono text-xs tabular-nums">
        {(backlog.ready ?? []).length}
      </td>
      <td className="px-4 py-3 text-center font-mono text-xs tabular-nums">
        {kanban.status?.activeWorkers ?? 0}
      </td>
      <td className="px-4 py-3 text-center font-mono text-xs tabular-nums">
        {(backlog["done"] ?? []).length}
      </td>
      <td className="px-4 py-3 text-center font-mono text-xs tabular-nums">
        {kanban.spec.maxParallel ?? 2}
      </td>
      <td className="px-4 py-3 text-text-muted tabular-nums text-xs">
        {age(kanban.metadata.creationTimestamp)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/kanbans/${encodeURIComponent(kanban.metadata.name)}`)}
            className="rounded border border-border-muted px-2 py-1 text-xs text-text-dim hover:border-zinc-500 hover:text-text transition-colors"
          >
            View
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete kanban "${kanban.metadata.name}"?`)) {
                del.mutate();
              }
            }}
            disabled={del.isPending}
            className="rounded border border-border-muted px-2 py-1 text-xs text-text-dim hover:border-phase-failed/50 hover:text-phase-failed transition-colors disabled:opacity-40"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function KanbansPage() {
  const { data: kanbans, error, isLoading } = useKanbans();

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Failed to load kanban boards</h2>
        <p className="text-sm">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Kanban Boards</h1>
          <p className="text-sm text-text-muted">
            Agentic development boards — tasks flow through columns as workers complete them.
          </p>
        </div>
        <Link
          to="/kanbans/new"
          className="rounded-md bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-sm font-medium text-text transition-colors"
        >
          + New Board
        </Link>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="divide-y divide-border-muted">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-4 flex gap-6">
                <div className="h-4 w-32 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-24 rounded bg-surface-overlay animate-pulse" />
                <div className="h-4 w-16 rounded bg-surface-overlay animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : !kanbans || kanbans.length === 0 ? (
        <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
          No kanban boards yet.{" "}
          <Link to="/kanbans/new" className="underline hover:text-text transition-colors">
            Create one
          </Link>{" "}
          to start agentic development with worker tasks flowing through columns.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-text-muted text-left">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Display Name</th>
                <th className="px-4 py-2.5 font-medium">Phase</th>
                <th className="px-4 py-2.5 font-medium text-center">Ready</th>
                <th className="px-4 py-2.5 font-medium text-center">Active</th>
                <th className="px-4 py-2.5 font-medium text-center">Done</th>
                <th className="px-4 py-2.5 font-medium text-center">Max</th>
                <th className="px-4 py-2.5 font-medium">Age</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-muted">
              {kanbans.map((k) => (
                <KanbanRow key={k.metadata.uid ?? k.metadata.name} kanban={k} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
