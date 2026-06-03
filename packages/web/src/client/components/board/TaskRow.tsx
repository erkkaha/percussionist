// TaskRow.tsx — compact clickable task row for the list panel.

import { Wrench, FileText, Flag, User, ExternalLink } from "lucide-react";
import type { Task } from "../../lib/types";

function age(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const COLUMN_COLORS: Record<string, string> = {
  ideas: "bg-text-dim/20 text-text-dim",
  backlog: "bg-text-dim/20 text-text-dim",
  blocked: "bg-phase-failed/20 text-phase-failed",
  "in-progress": "bg-phase-running/20 text-phase-running",
  review: "bg-accent/20 text-accent",
  done: "bg-phase-succeeded/20 text-phase-succeeded",
};

interface TaskRowProps {
  task: Task;
  col: string;
  isSelected: boolean;
  onClick: () => void;
}

export function TaskRow({ task, col, isSelected, onClick }: TaskRowProps) {
  const worker = task.status?.worker;
  const isBuild = task.spec.type === "BUILD";
  const colColor = COLUMN_COLORS[col] ?? "bg-surface-overlay text-text-dim";
  const lastActivity = worker?.completedAt ?? worker?.startedAt ?? task.metadata.creationTimestamp;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md px-3 py-2.5 transition-colors border ${
        isSelected
          ? "bg-surface-overlay border-border"
          : "bg-transparent border-transparent hover:bg-surface-overlay hover:border-border/50"
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Type icon */}
        <div className="mt-0.5 shrink-0">
          {isBuild ? (
            <Wrench className="h-3.5 w-3.5 text-accent" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-phase-pending" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium leading-snug truncate pr-1">{task.spec.title}</p>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Column badge */}
            <span className={`text-label-md font-mono uppercase px-1.5 py-0.5 rounded-sm ${colColor}`}>
              {col}
            </span>

            {/* Priority */}
            {task.spec.priority && task.spec.priority !== "medium" && (
              <span className={`text-label-md font-mono uppercase flex items-center gap-0.5 ${
                task.spec.priority === "high" ? "text-phase-failed" : "text-text-dim"
              }`}>
                <Flag className="h-2.5 w-2.5" />
                {task.spec.priority}
              </span>
            )}

            {/* Agent */}
            {task.spec.agent && (
              <span className="text-label-md font-mono uppercase text-text-dim flex items-center gap-0.5">
                <User className="h-2.5 w-2.5" />
                {task.spec.agent}
              </span>
            )}

            {/* Active run indicator */}
            {worker?.runName && col === "in-progress" && (
              <span className="text-label-md font-mono uppercase text-phase-running flex items-center gap-0.5">
                <ExternalLink className="h-2.5 w-2.5" />
                running
              </span>
            )}

            {/* Escalated */}
            {worker?.status === "Escalated" && (
              <span className="text-label-md font-mono uppercase text-phase-failed">escalated</span>
            )}

            {/* Succeeded */}
            {worker?.status === "Succeeded" && (
              <span className="text-label-md font-mono uppercase text-phase-succeeded">succeeded</span>
            )}

            {/* Failed */}
            {worker?.status === "Failed" && (
              <span className="text-label-md font-mono uppercase text-phase-failed">failed</span>
            )}
          </div>

          {/* Bottom row: parent ref + timestamp */}
          {(task.spec.parentTaskRef || lastActivity) && (
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              {task.spec.parentTaskRef && (
                <span className="text-label-md font-mono uppercase text-text-dim/70">
                  from: {task.spec.parentTaskRef}
                </span>
              )}
              {lastActivity && (
                <span className="text-label-md font-mono uppercase text-text-dim/40">
                  {age(lastActivity)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Selection indicator */}
        {isSelected && (
          <div className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-accent" />
        )}
      </div>
    </button>
  );
}
