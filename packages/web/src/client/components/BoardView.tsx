// BoardView.tsx — kanban board embedded in an Project.
//
// Route: /projects/:name/board
// Reads board columns from GET /api/projects/:name/board
// Returns: { settings, columns: Record<string, Task[]>, approvals, status }

import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Wrench, Flag, User, ExternalLink, Trash2, Check, X, ChevronDown } from "lucide-react";
import { fetchBoard, addBoardTask, deleteBoardTask, retryEscalatedTask, approveTask, requestChangesTask } from "../lib/api";
import type { Task, ManagerMetrics } from "../lib/types";
import { useBoardNotifications } from "../hooks/useBoardNotifications";
import { useBoardEvents } from "../hooks/useBoardEvents";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";

interface TaskCardProps {
  task: Task;
  col: string;
  approvals: Record<string, { approved: boolean; requestChanges: boolean }> | undefined;
  deleteMutation: { mutate: (name: string) => void; isPending: boolean; variables: string | undefined };
  retryMutation: { mutate: (name: string) => void; isPending: boolean; variables: string | undefined };
  approveMutation: { mutate: (taskName: string) => void; isPending: boolean; variables: string | undefined };
  requestChangesMutation: { mutate: ({ taskId, comment }: { taskId: string; comment: string }) => void; isPending: boolean; variables: { taskId: string; comment: string } | undefined };
  projectName: string;
  setShowRequestChanges: (v: boolean) => void;
  setRequestChangesTaskId: (id: string) => void;
}

function TaskCard({
  task, col, approvals,
  deleteMutation, retryMutation, approveMutation, requestChangesMutation,
  setShowRequestChanges, setRequestChangesTaskId,
}: TaskCardProps) {
  const taskName = task.metadata.name;
  const worker = task.status?.worker;
  const isBuildTask = task.spec.type === "BUILD";
  const reviewerDecisionKnown = worker?.reviewApproved !== undefined || !!worker?.reviewFeedback;
  const approvalState = approvals?.[taskName];
  const alreadyApproved = approvalState?.approved === true;
  const canApproveNow = !alreadyApproved;

  return (
    <Card className="group relative">
      <CardHeader className="space-y-0 p-3 pb-2">
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-mono text-text-dim flex items-center gap-1">
            {task.spec.type === "BUILD" ? (
              <Wrench className="h-3 w-3 text-accent" />
            ) : (
              <FileText className="h-3 w-3 text-phase-pending" />
            )}
            {taskName}
          </span>
          {task.spec.priority && (
            <span className={`text-[10px] px-1.5 py-0 rounded flex items-center gap-0.5 font-medium ${
              task.spec.priority === "high" ? "text-phase-failed bg-phase-failed/10" :
              task.spec.priority === "low" ? "text-text-dim bg-surface-overlay" :
              "text-phase-running bg-phase-running/10"
            }`}>
              <Flag className="h-2.5 w-2.5" />
              {task.spec.priority}
            </span>
          )}
        </div>
        <CardTitle className="flex items-start justify-between gap-2 text-sm">
          <span className="leading-snug flex-1">{task.spec.title}</span>
          <button
            onClick={() => deleteMutation.mutate(taskName)}
            className="opacity-0 group-hover:opacity-100 shrink-0 text-text-dim hover:text-phase-failed transition-all p-0.5"
            title="Remove task"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </CardTitle>
        {task.spec.agent && (
          <CardDescription className="flex items-center gap-1">
            <User className="h-3 w-3" />
            {task.spec.agent}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="p-3 pt-0 space-y-2">
        {/* Description with expand affordance */}
        {task.spec.description && (
          <details className="text-xs text-text-dim group/desc">
            <summary className="cursor-pointer line-clamp-2 list-none hover:text-text transition-colors flex items-center gap-1 [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-3 w-3 shrink-0 transition-transform duration-200 group-open/desc:rotate-180" />
              <span>Show more</span>
            </summary>
            <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{task.spec.description}</p>
          </details>
        )}

        {/* Run links */}
        {worker?.runName && (
          <Link
            to={`/runs/${encodeURIComponent(worker.runName)}`}
            className="text-xs text-text-dim hover:text-text transition-colors underline flex items-center gap-1 block"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            {worker.runName}
          </Link>
        )}
        {col === "review" && isBuildTask && worker?.reviewRunName && (
          <Link
            to={`/runs/${encodeURIComponent(worker.reviewRunName)}`}
            className="text-xs text-text-dim hover:text-text transition-colors underline flex items-center gap-1 block"
            title="Agent reviewer run"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            reviewer: {worker.reviewRunName}
          </Link>
        )}
        {col === "review" && isBuildTask && worker?.mergeRunName && (
          <Link
            to={`/runs/${encodeURIComponent(worker.mergeRunName)}`}
            className="text-xs text-text-dim hover:text-text transition-colors underline flex items-center gap-1 block"
            title="Merge run"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            merge: {worker.mergeRunName}
          </Link>
        )}

        {/* Review status */}
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

        {/* Escalation */}
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

        {/* Retry button */}
        {worker?.status === "Escalated" && (
          <button
            onClick={() => retryMutation.mutate(taskName)}
            disabled={retryMutation.isPending}
            className="text-xs text-text-dim hover:text-text disabled:opacity-40 transition-colors"
            title="Reset retries and move back to ready"
          >
            {retryMutation.isPending && retryMutation.variables === taskName ? "Retrying…" : "↺ Retry"}
          </button>
        )}

        {/* Approve / Request Changes */}
        {col === "review" && (
          <div className="flex gap-2">
            <button
              onClick={() => approveMutation.mutate(taskName)}
              disabled={(approveMutation.isPending || approveMutation.variables === taskName) || !canApproveNow}
              className="text-xs text-text-dim hover:text-text disabled:opacity-40 transition-colors font-medium flex items-center gap-1"
              title={alreadyApproved ? "Already approved" : (canApproveNow ? "Approve this task" : "Wait for agent review approval first")}
            >
              {alreadyApproved
                ? <><Check className="h-3 w-3" /> Approved</>
                : (approveMutation.isPending && approveMutation.variables === taskName ? "Approving…" : <><Check className="h-3 w-3" /> Approve</>)
              }
            </button>
            <button
              onClick={() => {
                setRequestChangesTaskId(taskName);
                setShowRequestChanges(true);
              }}
              className="text-xs text-text-dim hover:text-phase-failed transition-colors flex items-center gap-1"
              title="Request changes"
            >
              <X className="h-3 w-3" /> Request Changes
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const DEFAULT_COLUMNS = ["backlog", "blocked", "ready", "in-progress", "review", "rework", "done"];

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
  const { connected: boardSseConnected, eventTick } = useBoardEvents(projectName, true);

  const { data, isLoading, error } = useQuery({
    queryKey: ["board", projectName],
    queryFn: () => fetchBoard(projectName),
    refetchInterval: boardSseConnected ? false : 10_000,
    staleTime: 5_000,
  });

  // Refetch when SSE signals a board change — without changing the query key
  // (which would drop cached data and cause a loading flicker).
  useEffect(() => {
    if (eventTick > 0) {
      void queryClient.invalidateQueries({ queryKey: ["board", projectName] });
    }
  }, [eventTick, projectName, queryClient]);

  const [showAddTask, setShowAddTask] = useState(false);
  const [taskType, setTaskType] = useState<"PLAN" | "BUILD">("PLAN");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskAgent, setTaskAgent] = useState("");
  const [taskPriority, setTaskPriority] = useState<"high" | "medium" | "low">("medium");
  const [addError, setAddError] = useState<string | null>(null);

  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesTaskId, setRequestChangesTaskId] = useState("");
  const [requestChangesComment, setRequestChangesComment] = useState("");

  // All tasks flat — for notifications.
  const allTasks: Task[] = data ? Object.values(data.columns).flat() : [];

  const addMutation = useMutation({
    mutationFn: async (task: { type: string; title: string; description?: string; agent: string; priority?: string }) =>
      addBoardTask(projectName, task),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board", projectName] });
      setShowAddTask(false);
      setTaskTitle(""); setTaskDesc(""); setTaskAgent(""); setAddError(null);
    },
    onError: (e) => setAddError((e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (taskName: string) => deleteBoardTask(projectName, taskName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const retryMutation = useMutation({
    mutationFn: (taskName: string) => retryEscalatedTask(projectName, taskName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", projectName] }),
  });

  const approveMutation = useMutation({
    mutationFn: (taskName: string) => approveTask(projectName, taskName),
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

  // Notify on worker status transitions.
  useBoardNotifications(projectName, allTasks);

  if (isLoading && !data) return <p className="text-sm text-text-dim">Loading board…</p>;
  if (error && !data) return <p className="text-sm text-phase-failed">Failed to load board.</p>;
  if (!data) return <p className="text-sm text-phase-failed">Failed to load board.</p>;

  const { settings, columns, approvals, status } = data;
  const columnKeys = DEFAULT_COLUMNS;
  const roster = (settings.agents ?? []).map((a: { name: string }) => a.name);

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
            Team: {roster.length > 0 ? roster.join(", ") : (
              <span>
                (no agents configured —{" "}
                <Link to={`/projects/${encodeURIComponent(projectName)}/edit`} className="underline hover:text-text transition-colors">
                  add agents to the project roster
                </Link>
                )
              </span>
            )}
            {" · "}Max parallel: {settings.maxParallel ?? 2}
            {" · "}Phase: {settings.phase ?? "Active"}
          </p>
          <p className="text-xs text-text-dim mt-1">
            Updates: {boardSseConnected ? "live stream" : "polling fallback"}
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
          </div>
          <div className="grid grid-cols-1 gap-3">
            {roster.length === 0 ? (
              <p className="text-xs text-phase-failed">
                No agents in project roster.{" "}
                <Link to={`/projects/${encodeURIComponent(projectName)}/edit`} className="underline hover:opacity-80">
                  Add agents to the project first.
                </Link>
              </p>
            ) : (
              <select
                value={taskAgent}
                onChange={(e) => setTaskAgent(e.target.value)}
                className="rounded border border-border bg-surface-raised px-2 py-1.5 text-sm"
              >
                <option value="">— agent —</option>
                {roster.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            )}
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
                  type: taskType,
                  title: taskTitle.trim(),
                  description: taskDesc.trim() || undefined,
                  agent: taskAgent,
                  priority: taskPriority,
                });
              }}
              disabled={addMutation.isPending && addMutation.variables !== undefined}
              className="rounded-md bg-[#5c4a3a] hover:bg-[#6b5948] disabled:opacity-40 px-3 py-1.5 text-sm font-medium text-text transition-colors"
            >
              {addMutation.isPending ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && <p className="text-xs text-phase-failed">{addError}</p>}
        </div>
      )}

      {/* Board columns */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columnKeys.length}, minmax(0, 1fr))` }}>
        {columnKeys.map((col) => {
          const colTasks = columns[col] ?? [];
          return (
            <div key={col} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-dim">{col}</h3>
                <span className="text-xs text-text-dim tabular-nums">{colTasks.length}</span>
              </div>
              <div className="space-y-2 min-h-[8rem]">
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.metadata.name}
                    task={task}
                    col={col}
                    approvals={approvals}
                    deleteMutation={deleteMutation}
                    retryMutation={retryMutation}
                    approveMutation={approveMutation}
                    requestChangesMutation={requestChangesMutation}
                    projectName={projectName}
                    setShowRequestChanges={setShowRequestChanges}
                    setRequestChangesTaskId={setRequestChangesTaskId}
                  />
                ))}
                {colTasks.length === 0 && (
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
                  if (!requestChangesComment.trim()) return;
                  requestChangesMutation.mutate({
                    taskId: requestChangesTaskId,
                    comment: requestChangesComment.trim(),
                  });
                }}
                disabled={(requestChangesMutation.isPending || requestChangesMutation.variables?.taskId === requestChangesTaskId) || !requestChangesComment.trim()}
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
