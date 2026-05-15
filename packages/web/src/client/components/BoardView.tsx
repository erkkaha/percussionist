// BoardView.tsx — kanban board embedded in an OpenCodeProject.
//
// Route: /projects/:name/board
// Reads board spec + status from GET /api/projects/:name/board
// and renders a columnar view with worker status.

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchBoard, addBoardTask, deleteBoardTask, fetchAgents, patchBoardSpec, retryEscalatedTask, fetchNextTaskId, approveTask, requestChangesTask } from "../lib/api";
import type { BoardTask, ManagerMetrics } from "../lib/types";
import { useBoardNotifications } from "../hooks/useBoardNotifications";

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
  const [taskType, setTaskType] = useState<"PLAN" | "BUILD">("PLAN");

  // Fetch next task ID based on selected type.
  const { data: nextId = "" } = useQuery({
    queryKey: ["nextTaskId", projectName, taskType],
    queryFn: () => fetchNextTaskId(projectName, taskType),
    enabled: showAddTask,
  });
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskAgent, setTaskAgent] = useState("");
  const [taskPriority, setTaskPriority] = useState<"high" | "medium" | "low">("medium");
  const [addError, setAddError] = useState<string | null>(null);

  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesTaskId, setRequestChangesTaskId] = useState("");
  const [requestChangesComment, setRequestChangesComment] = useState("");

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
      queryClient.invalidateQueries({ queryKey: ["nextTaskId", projectName] });
      setShowAddTask(false);
      setTaskTitle(""); setTaskDesc(""); setTaskAgent(""); setAddError(null);
    },
    onError: (e) => setAddError((e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBoardTask(projectName, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) =>
      retryEscalatedTask(projectName, id, data?.status.workers ?? [], data?.status.backlog ?? {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const approveMutation = useMutation({
    mutationFn: (taskId: string) => approveTask(projectName, taskId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const requestChangesMutation = useMutation({
    mutationFn: ({ taskId, comment }: { taskId: string; comment: string }) =>
      requestChangesTask(projectName, taskId, comment),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board", projectName] });
      setShowRequestChanges(false);
      setRequestChangesTaskId("");
      setRequestChangesComment("");
    },
  });

  // Notify on worker status transitions (must be called before early returns per React rules).
  useBoardNotifications(projectName, data?.status.workers ?? []);

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
          className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] px-3 py-1.5 text-sm font-medium text-text transition-colors"
        >
          {showAddTask ? "Cancel" : "+ Add Task"}
        </button>
      </div>

      {/* Add task form */}
      {showAddTask && (
        <div className="rounded-md border border-border bg-surface p-4 space-y-3 max-w-lg">
          <h2 className="text-sm font-semibold">Add Task</h2>
          <div className="space-y-2">
            <label className="text-xs text-text-dim">Task Type</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value="PLAN"
                  checked={taskType === "PLAN"}
                  onChange={(e) => setTaskType(e.target.value as "PLAN" | "BUILD")}
                  className="cursor-pointer"
                />
                <span className="text-sm">PLAN</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value="BUILD"
                  checked={taskType === "BUILD"}
                  onChange={(e) => setTaskType(e.target.value as "PLAN" | "BUILD")}
                  className="cursor-pointer"
                />
                <span className="text-sm">BUILD</span>
              </label>
            </div>
            {nextId && (
              <p className="text-xs text-text-dim font-mono">Next ID: {nextId}</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3">
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
                if (!taskTitle.trim() || !taskAgent) {
                  setAddError("Title and agent are required");
                  return;
                }
                addMutation.mutate({
                  id: nextId,
                  type: taskType,
                  title: taskTitle.trim(),
                  description: taskDesc.trim() || undefined,
                  agent: taskAgent,
                  priority: taskPriority,
                });
              }}
              disabled={addMutation.isPending}
              className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] disabled:opacity-40 px-3 py-1.5 text-sm font-medium text-text transition-colors"
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
                  const isBuildTask = task?.type === "BUILD";
                  const reviewerDecisionKnown = worker?.reviewApproved !== undefined || !!worker?.reviewFeedback;
                  const canApproveNow = !isBuildTask || worker?.reviewApproved === true;
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
                          className="text-xs text-text-dim hover:text-text transition-colors underline"
                        >
                          {worker.runName}
                        </Link>
                      )}
                      {col === "review" && isBuildTask && worker?.reviewRunName && (
                        <Link
                          to={`/runs/${encodeURIComponent(worker.reviewRunName)}`}
                          className="text-xs text-text-dim hover:text-text transition-colors underline"
                          title="Agent reviewer run"
                        >
                          reviewer: {worker.reviewRunName}
                        </Link>
                      )}
                      {col === "review" && isBuildTask && worker?.mergeRunName && (
                        <Link
                          to={`/runs/${encodeURIComponent(worker.mergeRunName)}`}
                          className="text-xs text-text-dim hover:text-text transition-colors underline"
                          title="Merge run"
                        >
                          merge: {worker.mergeRunName}
                        </Link>
                      )}
                      {col === "review" && isBuildTask && !reviewerDecisionKnown && !worker?.reviewRunName && (
                        <p className="text-xs text-text-dim">
                          Agent review status: not started. If this persists, add reviewer agent to board roster.
                        </p>
                      )}
                      {col === "review" && isBuildTask && worker?.reviewRunName && !reviewerDecisionKnown && (
                        <p className="text-xs text-text-dim">Agent review in progress.</p>
                      )}
                      {col === "review" && isBuildTask && worker?.reviewApproved === true && (
                        <p className="text-xs text-phase-running">Agent review approved. Ready for human approve.</p>
                      )}
                      {col === "review" && isBuildTask && worker?.reviewFeedback && (
                        <p className="text-xs text-phase-failed whitespace-pre-wrap">Agent review feedback: {worker.reviewFeedback}</p>
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
                          className="text-xs text-text-dim hover:text-text disabled:opacity-40 transition-colors"
                          title="Reset retries and move back to ready"
                        >
                          {retryMutation.isPending && retryMutation.variables === id ? "Retrying…" : "↺ Retry"}
                        </button>
                      )}
                      {col === "review" && (
                        <div className="flex gap-2 mt-1">
                          <button
                            onClick={() => approveMutation.mutate(id)}
                            disabled={approveMutation.isPending || !canApproveNow}
                            className="text-xs text-text-dim hover:text-text disabled:opacity-40 transition-colors font-medium"
                            title={canApproveNow ? "Approve this task" : "Wait for agent review approval first"}
                          >
                            {approveMutation.isPending && approveMutation.variables === id ? "Approving…" : "✓ Approve"}
                          </button>
                          <button
                            onClick={() => {
                              setRequestChangesTaskId(id);
                              setShowRequestChanges(true);
                            }}
                            className="text-xs text-text-dim hover:text-phase-failed transition-colors"
                            title="Request changes"
                          >
                            ✕ Request Changes
                          </button>
                        </div>
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

      {/* Request Changes Modal */}
      {showRequestChanges && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="rounded-md border border-border bg-surface p-4 space-y-3 max-w-md w-full mx-4">
            <h2 className="text-sm font-semibold">Request Changes for {requestChangesTaskId}</h2>
            <textarea
              placeholder="Enter your review comments..."
              value={requestChangesComment}
              onChange={(e) => setRequestChangesComment(e.target.value)}
              rows={5}
              className="w-full rounded border border-border bg-surface-raised px-2 py-1.5 text-sm resize-y"
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowRequestChanges(false);
                  setRequestChangesTaskId("");
                  setRequestChangesComment("");
                }}
                className="rounded-md border border-border hover:bg-surface-raised px-3 py-1.5 text-sm font-medium text-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!requestChangesComment.trim()) {
                    return;
                  }
                  requestChangesMutation.mutate({
                    taskId: requestChangesTaskId,
                    comment: requestChangesComment.trim(),
                  });
                }}
                disabled={requestChangesMutation.isPending || !requestChangesComment.trim()}
                className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] disabled:opacity-40 px-3 py-1.5 text-sm font-medium text-text transition-colors"
              >
                {requestChangesMutation.isPending ? "Submitting…" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
