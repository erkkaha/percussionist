// BoardView.tsx — kanban board embedded in an OpenCodeProject.
//
// Route: /projects/:name/board
// Reads board spec + status from GET /api/projects/:name/board
// and renders a columnar view with worker status.

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchBoard, addBoardTask, deleteBoardTask, fetchAgents, patchBoardSpec, retryEscalatedTask } from "../lib/api";
import type { BoardTask, ManagerMetrics } from "../lib/types";

const DEFAULT_COLUMNS = ["ready", "in-progress", "review", "rework", "done"];

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

function MetricsBadge({ metrics }: { metrics: ManagerMetrics }) {
  return (
    <div className="flex items-center gap-3 text-xs mt-1.5 flex-wrap">
      {metrics.lastReconcileAt && (
        <>
          <span title={new Date(metrics.lastReconcileAt).toISOString()}>
            Last reconcile: {formatRelative(metrics.lastReconcileAt)} ({formatDuration(metrics.lastReconcileDurationMs ?? 0)})
          </span>
          {" · "}
        </>
      )}
      <span>Tasks pulled: {metrics.tasksPulled}</span>
      {" · "}
      <span>Workers monitored: {metrics.workersMonitored}</span>
      {" · "}
      <span>Reworked: {metrics.tasksReworked}</span>
      {metrics.lastReconcileResult === "error" && (
        <>
          {" · "}
          <span className="text-phase-failed">{metrics.lastError ?? "error"}</span>
        </>
      )}
    </div>
  );
}

export default function BoardView() {
  const { name } = useParams<{ name: string }>();
  const projectName = name!;
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["board", projectName],
    queryFn: () => fetchBoard(projectName),
    refetchInterval: 10_000,
  });

  // All ClusterAgents available in the cluster — used for the agent dropdown.
  const { data: clusterAgents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
  });

  const [showAddTask, setShowAddTask] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskAgent, setTaskAgent] = useState("");
  const [taskPriority, setTaskPriority] = useState<"high" | "medium" | "low">("medium");
  const [addError, setAddError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: async (task: BoardTask) => {
      // If this agent isn't in the board roster yet, add it first.
      if (!roster.includes(task.agent)) {
        const updatedAgents = [...(spec.agents ?? []), { name: task.agent }];
        await patchBoardSpec(projectName, { agents: updatedAgents });
      }
      return addBoardTask(projectName, task);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board", projectName] });
      setShowAddTask(false);
      setTaskId(""); setTaskTitle(""); setTaskDesc(""); setTaskAgent(""); setAddError(null);
    },
    onError: (e) => setAddError((e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBoardTask(projectName, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) =>
      retryEscalatedTask(projectName, id, data?.status.workers, data?.status.backlog),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  if (isLoading) return <p className="text-sm text-text-dim">Loading board…</p>;
  if (error || !data) return <p className="text-sm text-phase-failed">Failed to load board.</p>;

  const { spec, status } = data;
  const columns = status.columns ?? DEFAULT_COLUMNS;
  const backlog = status.backlog ?? {};
  const workers = status.workers ?? [];
  const tasks = spec.tasks ?? [];
  const roster = (spec.agents ?? []).map((a) => a.name);

  function taskById(id: string) { return tasks.find((t) => t.id === id); }
  function workerByTask(id: string) { return workers.find((w) => w.taskId === id); }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-text-dim">
            <Link to="/projects" className="hover:text-text transition-colors">Projects</Link>
            <span>/</span>
            <Link to={`/projects/${encodeURIComponent(projectName)}/edit`} className="hover:text-text transition-colors">
              {projectName}
            </Link>
            <span>/</span>
            <span className="text-text">Board</span>
          </div>
          <h1 className="text-xl font-semibold mt-1">{projectName} — Board</h1>
          <p className="text-sm text-text-dim mt-0.5">
            Team: {roster.join(", ") || "(no agents configured)"}
            {" · "}Max parallel: {spec.maxParallel ?? 2}
            {" · "}Phase: {spec.phase ?? "Active"}
          </p>
          {status.managerMetrics && <MetricsBadge metrics={status.managerMetrics} />}
        </div>
        <button
          onClick={() => setShowAddTask((v) => !v)}
          className="rounded-md bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-sm font-medium text-text transition-colors"
        >
          {showAddTask ? "Cancel" : "+ Add Task"}
        </button>
      </div>

      {/* Add task form */}
      {showAddTask && (
        <div className="rounded-md border border-border bg-surface p-4 space-y-3 max-w-lg">
          <h2 className="text-sm font-semibold">Add Task</h2>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="ID (e.g. F-104)"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm font-mono"
            />
            <select
              value={taskAgent}
              onChange={(e) => setTaskAgent(e.target.value)}
              className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm"
            >
              <option value="">— agent —</option>
              {clusterAgents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </div>
          <input
            placeholder="Title"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            className="w-full rounded border border-border bg-surface-raised px-2 py-1.5 text-sm"
          />
          <textarea
            placeholder="Description (optional)"
            value={taskDesc}
            onChange={(e) => setTaskDesc(e.target.value)}
            rows={3}
            className="w-full rounded border border-border bg-surface-raised px-2 py-1.5 text-sm resize-y"
          />
          <div className="flex items-center gap-3">
            <select
              value={taskPriority}
              onChange={(e) => setTaskPriority(e.target.value as "high" | "medium" | "low")}
              className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm"
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <button
              onClick={() => {
                if (!taskId.trim() || !taskTitle.trim() || !taskAgent) {
                  setAddError("ID, title, and agent are required");
                  return;
                }
                addMutation.mutate({
                  id: taskId.trim(),
                  title: taskTitle.trim(),
                  description: taskDesc.trim() || undefined,
                  agent: taskAgent,
                  priority: taskPriority,
                });
              }}
              disabled={addMutation.isPending}
              className="rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 px-3 py-1.5 text-sm font-medium text-text transition-colors"
            >
              {addMutation.isPending ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && <p className="text-xs text-phase-failed">{addError}</p>}
        </div>
      )}

      {/* Board columns */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col) => {
          const taskIds = backlog[col] ?? [];
          return (
            <div key={col} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-dim">{col}</h3>
                <span className="text-xs text-text-dim tabular-nums">{taskIds.length}</span>
              </div>
              <div className="space-y-2 min-h-[8rem]">
                {taskIds.map((id) => {
                  const task = taskById(id);
                  const worker = workerByTask(id);
                  return (
                    <div
                      key={id}
                      className="rounded-md border border-border bg-surface p-2.5 space-y-1 group relative"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="text-xs font-mono text-text-dim">{id}</span>
                        {task?.priority && (
                          <span className={`text-[10px] px-1 rounded ${
                            task.priority === "high" ? "text-phase-failed bg-phase-failed/10" :
                            task.priority === "low" ? "text-text-dim bg-surface-overlay" :
                            "text-phase-running bg-phase-running/10"
                          }`}>
                            {task.priority}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-text leading-snug">{task?.title ?? id}</p>
                      {task?.description && (
                        <details className="text-xs text-text-dim">
                          <summary className="cursor-pointer line-clamp-2 list-none hover:text-text transition-colors [&::-webkit-details-marker]:hidden">
                            {task.description}
                          </summary>
                          <p className="mt-1 whitespace-pre-wrap">{task.description}</p>
                        </details>
                      )}
                      {task?.agent && (
                        <p className="text-xs text-text-dim">{task.agent}</p>
                      )}
                      {worker?.runName && (
                        <Link
                          to={`/runs/${encodeURIComponent(worker.runName)}`}
                          className="text-xs text-zinc-400 hover:text-text transition-colors underline"
                        >
                          {worker.runName}
                        </Link>
                      )}
                      {worker?.status === "Escalated" && (
                        <details className="text-xs text-phase-failed">
                          <summary className="cursor-pointer list-none hover:opacity-80 transition-opacity [&::-webkit-details-marker]:hidden flex items-center gap-1.5">
                            <span>Escalated</span>
                            {worker.escalation && <span className="text-text-dim">(show reason)</span>}
                          </summary>
                          {worker.escalation && (
                            <p className="mt-1 whitespace-pre-wrap text-text-dim">{worker.escalation}</p>
                          )}
                        </details>
                      )}
                      {worker?.status === "Escalated" && (
                        <button
                          onClick={() => retryMutation.mutate(id)}
                          disabled={retryMutation.isPending}
                          className="text-xs text-zinc-400 hover:text-text disabled:opacity-40 transition-colors"
                          title="Reset retries and move back to ready"
                        >
                          {retryMutation.isPending && retryMutation.variables === id ? "Retrying…" : "↺ Retry"}
                        </button>
                      )}
                      <button
                        onClick={() => deleteMutation.mutate(id)}
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-xs text-text-dim hover:text-phase-failed transition-all"
                        title="Remove task"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {taskIds.length === 0 && (
                  <p className="text-xs text-text-dim italic">empty</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
