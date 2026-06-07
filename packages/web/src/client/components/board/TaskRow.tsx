// TaskRow.tsx — compact clickable task row for the list panel.

import { Wrench, FileText, Flag, User, MessageSquarePlus } from "lucide-react";
import type { Task } from "../../lib/types";
import { useChat } from "../../lib/chat-context";

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
  projectName: string;
}

export function TaskRow({ task, col, isSelected, onClick, projectName }: TaskRowProps) {
  const worker = task.status?.worker;
  const isBuild = task.spec.type === "BUILD";
  const colColor = COLUMN_COLORS[col] ?? "bg-surface-overlay text-text-dim";
  const lastActivity = worker?.completedAt ?? worker?.startedAt ?? task.metadata.creationTimestamp;

  const { injectTask } = useChat();

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md px-3 py-2.5 transition-colors border group ${
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

            {/* Phase badge (in-progress column) */}
            {col === "in-progress" && task.status?.phase && (
              <span className="text-label-md font-mono uppercase text-phase-running flex items-center gap-0.5">
                {task.status.phase}
              </span>
            )}

            {/* Escalated */}
            {col !== "in-progress" && worker?.status === "Escalated" && (
              <span className="text-label-md font-mono uppercase text-phase-failed">escalated</span>
            )}

            {/* Succeeded */}
            {col !== "in-progress" && worker?.status === "Succeeded" && (
              <span className="text-label-md font-mono uppercase text-phase-succeeded">succeeded</span>
            )}

            {/* Failed */}
            {col !== "in-progress" && worker?.status === "Failed" && (
              <span className="text-label-md font-mono uppercase text-phase-failed">failed</span>
            )}

            {/* Waiting for prerequisite */}
            {col === "blocked" && task.status?.blockedReason && (
              <span className="text-label-md font-mono uppercase text-phase-failed" title={task.status.blockedReason}>
                {task.status.blockedReason}
              </span>
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

          {/* Waiting phase status message */}
          {task.status?.phase === "awaiting-children" && task.childProgress && (
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-label-md font-mono text-text-dim/60">
                {task.childProgress.completed}/{task.childProgress.total} child BUILD tasks complete
              </span>
              {/* Progress bar */}
              <div className="h-1 w-16 bg-surface-overlay rounded-full overflow-hidden">
                <div
                  className="h-full bg-phase-pending transition-all"
                  style={{ width: `${task.childProgress.total > 0 ? (task.childProgress.completed / task.childProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {task.status?.phase === "awaiting-feature-merge" && (
            <div className="pt-0.5">
              <span className="text-label-md font-mono text-text-dim/60">
                Merging feature branch to target
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-0.5 shrink-0 flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); injectTask(task, projectName); }}
            className="opacity-70 group-hover:opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded text-text-dim hover:text-accent md:opacity-0 md:group-hover:opacity-60 md:hover:opacity-100"
            title="Inject task into chat"
            aria-label="Inject task into chat"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
          {isSelected && (
            <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </button>
  );
}
