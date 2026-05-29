// BoardHeader.tsx — project info, metrics badge, and Add Task button.

import { Link } from "react-router-dom";
import type { ManagerMetrics } from "../../lib/types";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 10_000) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface BoardHeaderProps {
  projectName: string;
  roster: string[];
  maxParallel: number | undefined;
  phase: string | undefined;
  sseConnected: boolean;
  metrics: ManagerMetrics | undefined;
  onAddTask: () => void;
  showAddTask: boolean;
}

export function BoardHeader({
  projectName,
  roster,
  maxParallel,
  phase,
  sseConnected,
  metrics,
  onAddTask,
  showAddTask,
}: BoardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 shrink-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-text-dim flex-wrap">
          <Link to="/projects" className="hover:text-text transition-colors shrink-0">Projects</Link>
          <span>/</span>
          <Link to={`/projects/${encodeURIComponent(projectName)}/edit`} className="hover:text-text transition-colors truncate max-w-[12rem]">
            {projectName}
          </Link>
          <span>/</span>
          <span className="text-text shrink-0">Board</span>
        </div>
        <h1 className="text-xl font-semibold mt-1 truncate">{projectName}</h1>
        <p className="text-sm text-text-dim mt-0.5 flex flex-wrap items-center gap-x-1">
          <span>Team:</span>
          {roster.length > 0 ? (
            <span className="truncate">{roster.join(", ")}</span>
          ) : (
            <Link to={`/projects/${encodeURIComponent(projectName)}/edit`} className="underline hover:text-text transition-colors">
              add agents to roster
            </Link>
          )}
          <span className="text-text-dim/50">·</span>
          <span>Parallel: {maxParallel ?? 2}</span>
          <span className="text-text-dim/50">·</span>
          <span>Phase: {phase ?? "Active"}</span>
        </p>
        <p className="text-xs text-text-dim mt-0.5">
          {sseConnected ? "● live" : "○ polling"}
        </p>
        {metrics && (
          <div className="flex items-center gap-3 text-xs mt-1 flex-wrap text-text-dim">
            {metrics.lastReconcileAt && (
              <span title={new Date(metrics.lastReconcileAt).toISOString()}>
                Reconciled {formatRelative(metrics.lastReconcileAt)} ({formatDuration(metrics.lastReconcileDurationMs ?? 0)})
              </span>
            )}
            <span>Pulled: {metrics.tasksPulled}</span>
            <span>Monitored: {metrics.workersMonitored}</span>
            {metrics.lastReconcileResult === "error" && (
              <span className="text-phase-failed">{metrics.lastError ?? "error"}</span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onAddTask}
        className="shrink-0 rounded-md bg-surface-container-high hover:bg-surface-container-highest px-3 py-1.5 text-sm font-medium text-text transition-colors"
      >
        {showAddTask ? "Cancel" : "+ Add Task"}
      </button>
    </div>
  );
}
