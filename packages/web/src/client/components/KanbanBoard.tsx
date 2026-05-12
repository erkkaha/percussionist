import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useKanban } from "../hooks/useKanbans";
import { patchKanbanStatus, deleteKanban } from "../lib/api";
import type { OpenCodeKanban, WorkerStatus, KanbanTask } from "../lib/types";

const COLUMNS = ["ready", "in-progress", "review", "rework", "done"] as const;

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

function priorityBadge(priority?: string) {
  if (!priority || priority === "medium") return null;
  const cls =
    priority === "high"
      ? "text-phase-failed bg-phase-failed/10 border-phase-failed/20"
      : "text-text-dim bg-surface-overlay/50 border-border-muted";
  return (
    <span className={`inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wider border ${cls}`}>
      {priority}
    </span>
  );
}

function workerStatusBadge(status?: string) {
  if (!status) return null;
  const cls =
    status === "Running"
      ? "text-phase-running bg-phase-running/10"
      : status === "Succeeded"
        ? "bg-green-700/20 text-green-400"
        : status === "Failed"
          ? "text-phase-failed bg-phase-failed/10"
          : "text-orange-400 bg-orange-500/10";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function nextColumn(col: string): string | null {
  const idx = COLUMNS.indexOf(col as (typeof COLUMNS)[number]);
  if (idx < 0 || idx >= COLUMNS.length - 1) return null;
  return COLUMNS[idx + 1] as string;
}

function prevColumn(col: string): string | null {
  const idx = COLUMNS.indexOf(col as (typeof COLUMNS)[number]);
  if (idx <= 0) return null;
  return COLUMNS[idx - 1] as string;
}

function TaskCard({
  taskId,
  title,
  priority,
  worker,
  column,
  onMove,
}: {
  taskId: string;
  title: string;
  priority?: string;
  worker?: WorkerStatus;
  column: string;
  onMove: (taskId: string, fromCol: string, toCol: string) => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-xs text-text-dim">{taskId}</span>
        {priorityBadge(priority)}
      </div>

      {/* Title */}
      <p className="text-sm font-medium text-text leading-snug">{title}</p>

      {/* Worker info */}
      {worker && (
        <div className="space-y-1.5 pt-1 border-t border-border-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-dim font-medium uppercase tracking-wider">Worker</span>
            {workerStatusBadge(worker.status)}
          </div>

          {/* Run link */}
          {worker.runName && (
            <Link
              to={`/runs/${encodeURIComponent(worker.runName)}`}
              className="block text-xs font-mono text-text-muted hover:text-text truncate transition-colors"
              title={worker.runName}
            >
              {worker.runName}
            </Link>
          )}

          {/* Escalation */}
          {worker.escalation && (
            <details className="group mt-1">
              <summary className="text-xs text-orange-400 cursor-pointer hover:text-orange-300 flex items-center gap-1">
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Escalated (retry {worker.retryCount ?? "?"})
              </summary>
              <pre className="mt-1 text-xs text-orange-300/80 whitespace-pre-wrap bg-orange-500/5 rounded p-2 border border-orange-500/20 font-mono">
                {worker.escalation}
              </pre>
            </details>
          )}

          {/* Branch */}
          {worker.branch && (
            <p className="text-[10px] text-text-dim font-mono truncate" title={worker.branch}>
              branch: {worker.branch}
            </p>
          )}
        </div>
      )}

      {/* Move buttons */}
      <div className="flex items-center gap-1 pt-1 border-t border-border-muted">
        {prevColumn(column) && (
          <button
            onClick={() => onMove(taskId, column, prevColumn(column)!)}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-text-dim hover:text-text border border-border-muted hover:border-zinc-500 transition-colors"
          >
            ← Back
          </button>
        )}
        {nextColumn(column) && (
          <button
            onClick={() => onMove(taskId, column, nextColumn(column)!)}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-700 hover:bg-zinc-600 text-text transition-colors"
          >
            {worker ? `→ ${nextColumn(column)}` : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}

function Column({
  name,
  tasks,
  workers,
  onMove,
}: {
  name: string;
  tasks: KanbanTask[];
  workers: WorkerStatus[];
  onMove: (taskId: string, fromCol: string, toCol: string) => void;
}) {
  const workerMap = new Map<string, WorkerStatus>();
  for (const w of workers ?? []) {
    if (w.status === "Running" || w.status === "Escalated") {
      workerMap.set(w.taskId, w);
    }
  }

  // Tasks in this column that are NOT currently running elsewhere.
  const visibleTasks = tasks.filter((t) => !workerMap.has(t.id));

  return (
    <div className="shrink-0 w-64 flex flex-col">
      {/* Column header */}
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted capitalize">
          {name.replace("-", " ")}
        </h3>
        <span className="rounded-full bg-surface-overlay px-1.5 py-0.5 text-[10px] font-mono text-text-dim tabular-nums">
          {visibleTasks.length}
        </span>
      </div>

      {/* Column body */}
      <div className="flex-1 space-y-2 overflow-y-auto pr-1 pb-4 min-h-[100px]">
        {visibleTasks.map((task) => (
          <TaskCard
            key={task.id}
            taskId={task.id}
            title={task.title}
            priority={task.priority}
            worker={workerMap.get(task.id)}
            column={name}
            onMove={onMove}
          />
        ))}

        {/* Running workers that belong to this column */}
        {(workers ?? [])
          .filter((w: WorkerStatus) => w.status === "Running" && tasks.some((t: KanbanTask) => t.id === w.taskId))
          .map((worker: WorkerStatus) => {
            const task = tasks.find((t: KanbanTask) => t.id === worker.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={worker.taskId}
                taskId={worker.taskId}
                title={task.title}
                priority={task.priority}
                worker={worker}
                column={name}
                onMove={onMove}
              />
            );
          })}

        {/* Escalated workers */}
        {(workers ?? [])
          .filter((w: WorkerStatus) => w.status === "Escalated" && tasks.some((t: KanbanTask) => t.id === w.taskId))
          .map((worker: WorkerStatus) => {
            const task = tasks.find((t: KanbanTask) => t.id === worker.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={worker.taskId}
                taskId={worker.taskId}
                title={task.title}
                priority={task.priority}
                worker={worker}
                column={name}
                onMove={onMove}
              />
            );
          })}

        {/* Succeeded workers in review/done columns */}
        {(workers ?? [])
          .filter((w: WorkerStatus) => w.status === "Succeeded" && tasks.some((t: KanbanTask) => t.id === w.taskId))
          .map((worker: WorkerStatus) => {
            const task = tasks.find((t: KanbanTask) => t.id === worker.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={worker.taskId}
                taskId={worker.taskId}
                title={task.title}
                priority={task.priority}
                worker={worker}
                column={name}
                onMove={onMove}
              />
            );
          })}

        {/* Failed workers */}
        {(workers ?? [])
          .filter((w: WorkerStatus) => w.status === "Failed" && tasks.some((t: KanbanTask) => t.id === w.taskId))
          .map((worker: WorkerStatus) => {
            const task = tasks.find((t: KanbanTask) => t.id === worker.taskId);
            if (!task) return null;
            return (
              <TaskCard
                key={worker.taskId}
                taskId={worker.taskId}
                title={task.title}
                priority={task.priority}
                worker={worker}
                column={name}
                onMove={onMove}
              />
            );
          })}

        {visibleTasks.length === 0 && !workers?.some((w: WorkerStatus) => tasks.some((t: KanbanTask) => t.id === w.taskId)) && (
          <div className="rounded-lg border border-border-muted bg-surface-overlay/30 p-4 text-center">
            <p className="text-xs text-text-dim">Empty</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard() {
  const pathParts = window.location.pathname.split("/kanbans/");
  const name = pathParts[1] ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (!name) {
    return (
      <div className="rounded-lg border border-border-muted bg-surface-raised p-8 text-center text-text-muted">
        No kanban board specified.{" "}
        <Link to="/kanbans" className="underline hover:text-text transition-colors">
          Back to boards
        </Link>
      </div>
    );
  }

  const { data: kanban, error, isLoading } = useKanban(name);

  const moveMutation = useMutation({
    mutationFn: ({ taskId, fromCol, toCol }: { taskId: string; fromCol: string; toCol: string }) => {
      if (!kanban) throw new Error("No kanban loaded");
      const backlog = { ...(kanban.status?.backlog ?? {}) };
      // Remove from source column
      backlog[fromCol] = (backlog[fromCol] ?? []).filter((id: string) => id !== taskId);
      // Add to target column
      backlog[toCol] = [...(backlog[toCol] ?? []), taskId];
      return patchKanbanStatus(kanban.metadata.name, { backlog });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kanban", name] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteKanban(name),
    onSuccess: () => {
      navigate("/kanbans");
    },
  });

  function handleMove(taskId: string, fromCol: string, toCol: string) {
    moveMutation.mutate({ taskId, fromCol, toCol });
  }

  if (error) {
    return (
      <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
        <h2 className="text-lg font-semibold mb-1">Failed to load kanban board</h2>
        <p className="text-sm">{error.message}</p>
      </div>
    );
  }

  if (isLoading || !kanban) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-48 rounded bg-surface-overlay animate-pulse" />
          <div className="h-5 w-16 rounded bg-surface-overlay animate-pulse" />
        </div>
        <div className="flex gap-4 overflow-x-auto">
          {COLUMNS.map((col) => (
            <div key={col} className="shrink-0 w-64 space-y-2">
              <div className="h-4 w-20 rounded bg-surface-overlay animate-pulse" />
              <div className="h-32 rounded-lg border border-border-muted bg-surface-raised/50" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const status = kanban.status ?? {};
  const backlog = status.backlog ?? {};
  const workers = status.workers ?? [];
  const escalations = status.escalations ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            {kanban.spec.displayName || kanban.metadata.name}
            <span className="font-mono text-sm font-normal text-text-dim">{kanban.metadata.name}</span>
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Phase: {phaseBadge(status.phase)} · Max parallel: {kanban.spec.maxParallel ?? 2}
          </p>
        </div>

        {/* Escalations summary */}
        {escalations.length > 0 && (
          <details className="group">
            <summary className="text-sm text-orange-400 cursor-pointer hover:text-orange-300 flex items-center gap-1.5 font-medium">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {escalations.length} escalation{escalations.length > 1 ? "s" : ""}
            </summary>
            <div className="mt-2 space-y-2">
              {escalations.map((esc, i) => (
                <pre key={i} className="text-xs text-orange-300/80 whitespace-pre-wrap bg-orange-500/5 rounded p-3 border border-orange-500/20 font-mono">
                  {esc}
                </pre>
              ))}
            </div>
          </details>
        )}

        {/* Actions */}
        <button
          onClick={() => {
            if (confirm(`Delete kanban "${kanban.metadata.name}"?`)) {
              deleteMutation.mutate();
            }
          }}
          disabled={deleteMutation.isPending}
          className="shrink-0 rounded border border-border-muted px-2.5 py-1.5 text-xs font-medium text-text-dim hover:border-phase-failed/50 hover:text-phase-failed transition-colors disabled:opacity-40"
        >
          {deleteMutation.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>

      {/* Board columns */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <Column
            key={col}
            name={col}
            tasks={(backlog[col] ?? []).map((taskId: string) => kanban.spec.tasks?.find((t: KanbanTask) => t.id === taskId)).filter(Boolean) as KanbanTask[]}
            workers={workers.filter((w: WorkerStatus) => {
              const task = kanban.spec.tasks?.find((t: KanbanTask) => t.id === w.taskId);
              if (!task) return false;
              // Show worker in the column where its task currently lives.
              for (const c of COLUMNS) {
                if ((backlog[c] ?? []).includes(w.taskId)) return c === col;
              }
              return false;
            })}
            onMove={handleMove}
          />
        ))}
      </div>

      {/* Task list (fallback for tasks not in any column) */}
      {kanban.spec.tasks?.filter((t: KanbanTask) => !COLUMNS.some((c: string) => (backlog[c] ?? []).includes(t.id))).length ? (
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2">Unassigned tasks</h3>
          <ul className="space-y-1">
            {kanban.spec.tasks.filter((t: KanbanTask) => !COLUMNS.some((c: string) => (backlog[c] ?? []).includes(t.id))).map((task: KanbanTask) => (
              <li key={task.id} className="flex items-center justify-between text-sm py-1.5 border-b border-border-muted last:border-0">
                <span>
                  <span className="font-mono text-xs text-text-dim mr-2">{task.id}</span>
                  {task.title}
                </span>
                <button
                  onClick={() => handleMove(task.id, "", "ready")}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-700 hover:bg-zinc-600 text-text transition-colors"
                >
                  Add to Ready
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
