// TaskDetailPanel.tsx — tabbed detail view for a selected task.
// Shows: Overview, Session (live), Logs, Plan (PLAN tasks only).
// Actions: Approve, Request Changes, Retry, Delete.

import { useState, memo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  ExternalLink, Check, X, Trash2, Flag, User,
  Wrench, FileText, RefreshCw, MousePointerClick, ArrowRight,
} from "lucide-react";
import { useRun } from "../../hooks/useRun";
import { useRunEvents } from "../../hooks/useRunEvents";
import { approveTask, requestChangesTask, retryEscalatedTask, deleteBoardTask, fetchPlan, moveTask } from "../../lib/api";
import { TERMINAL_PHASES } from "../../lib/types";
import type { Task } from "../../lib/types";
import SessionView from "../SessionView";
import LogViewer from "../LogViewer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../CodeBlock";
import type React from "react";

const remarkPlugins = [remarkGfm];

type Tab = "overview" | "session" | "logs" | "plan";

interface TaskDetailPanelProps {
  task: Task;
  col: string;
  projectName: string;
  approvals: Record<string, { approved: boolean; requestChanges: boolean }> | undefined;
  onDeleted: () => void;
}

// ---------------------------------------------------------------------------
// Run sub-panel — fetches and displays run info with session/logs
// ---------------------------------------------------------------------------
function RunPanel({ runName, tab }: { runName: string; tab: "session" | "logs" }) {
  const { data: run } = useRun(runName, 5_000);
  const runPhase = run?.status?.phase;
  const isActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(runName, isActive);

  if (!run) return <p className="text-xs text-text-dim p-4">Loading run…</p>;

  if (tab === "session") {
    return (
      <div className="px-4 py-3">
        <SessionView
          name={runName}
          hasSession={!!run.status?.sessionID}
          active={isActive}
          sseConnected={sseConnected}
          eventTick={eventTick}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <LogViewer
        name={runName}
        active={isActive}
        sseConnected={sseConnected}
        eventTick={eventTick}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan content — renders markdown plan artifact
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Stable markdown component overrides — defined outside render to avoid
// new object references causing ReactMarkdown to re-render the entire tree.
// ---------------------------------------------------------------------------
const planMarkdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="my-0">{children}</p>,
  pre: ({ children }) => <div className="mb-2">{children}</div>,
  code: ({ children, className }) => {
    const lang = className?.replace("language-", "") ?? "";
    const code = String(children).replace(/\n$/, "");
    if (lang || code.includes("\n")) {
      return <CodeBlock code={code} language={lang} />;
    }
    return <span className="bg-surface-sunken rounded px-1 py-0.5 text-xs font-mono">{children}</span>;
  },
  h1: ({ children }) => <h1 className="text-2xl font-bold mt-4 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-semibold mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-semibold mt-2 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-base font-semibold mt-2 mb-0.5">{children}</h4>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2">
      <table className="border-collapse text-xs w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-raised">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-border-muted">{children}</tbody>,
  tr: ({ children }) => <tr className="hover:bg-surface-overlay/30 transition-colors">{children}</tr>,
  th: ({ children }) => <th className="border border-border px-2 py-1.5 font-semibold text-left">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
};

function PlanContent({ projectName, taskName }: { projectName: string; taskName: string }) {
  const { data, status, fetchStatus, error } = useQuery({
    queryKey: ["plan", projectName, taskName],
    queryFn: () => fetchPlan(projectName, taskName),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const isFirstLoad = status === "pending" && fetchStatus === "fetching";

  if (isFirstLoad) return <p className="text-xs text-text-dim p-4">Loading plan…</p>;
  if (error) return <p className="text-xs text-phase-failed p-4">Failed to load plan: {(error as Error).message}</p>;
  if (!data?.content) return <p className="text-xs text-text-dim p-4">No plan artifact found.</p>;

  return (
    <div className="prose prose-sm prose-invert max-w-none px-4 py-3">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={planMarkdownComponents}
      >
        {data.content}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab content
// ---------------------------------------------------------------------------
function OverviewContent({ task, col, projectName }: { task: Task; col: string; projectName: string }) {
  const worker = task.status?.worker;
  const runs = [
    worker?.runName ? { label: "Run", name: worker.runName } : null,
    worker?.reviewRunName ? { label: "Reviewer", name: worker.reviewRunName } : null,
    worker?.mergeRunName ? { label: "Merge", name: worker.mergeRunName } : null,
  ].filter(Boolean) as Array<{ label: string; name: string }>;

  return (
    <div className="space-y-4 px-4 py-3">
      {/* Description */}
      {task.spec.description && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">Description</p>
          <p className="text-sm whitespace-pre-wrap leading-relaxed text-text">{task.spec.description}</p>
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <MetaRow label="Type" value={task.spec.type} />
        <MetaRow label="Column" value={col} />
        <MetaRow label="Priority" value={task.spec.priority ?? "medium"} />
        {task.spec.agent && <MetaRow label="Agent" value={task.spec.agent} />}
        {worker?.retryCount !== undefined && <MetaRow label="Retries" value={String(worker.retryCount)} />}
        {worker?.status && <MetaRow label="Worker" value={worker.status} />}
        {worker?.gitBranch && <MetaRow label="Branch" value={worker.gitBranch} mono />}
        {worker?.reviewApproved !== undefined && (
          <MetaRow label="Agent review" value={worker.reviewApproved ? "approved" : "rejected"} />
        )}
      </div>

      {/* Agent review feedback */}
      {worker?.reviewFeedback && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">Agent Review Feedback</p>
          <p className="text-sm whitespace-pre-wrap text-phase-failed/80 leading-relaxed">{worker.reviewFeedback}</p>
        </div>
      )}

      {/* Run links */}
      {runs.length > 0 && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">Runs</p>
          <div className="space-y-1">
            {runs.map(({ label, name }) => (
              <Link
                key={name}
                to={`/runs/${encodeURIComponent(name)}`}
                className="flex items-center gap-1.5 text-sm text-text-dim hover:text-text transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono text-xs">{name}</span>
                <span className="text-text-dim/50 text-xs">({label})</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Plan link for PLAN tasks */}
      {task.spec.type === "PLAN" && worker?.runName && (
        <Link
          to={`/projects/${encodeURIComponent(projectName)}/plans/${encodeURIComponent(task.metadata.name)}`}
          className="flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 transition-colors"
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          View plan artifact (full page)
        </Link>
      )}
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-label-md font-mono uppercase text-text-dim">{label}</p>
      <p className={`text-sm ${mono ? "font-mono text-xs" : ""} truncate text-text`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
function TaskDetailPanelInner({
  task,
  col,
  projectName,
  approvals,
  onDeleted,
}: TaskDetailPanelProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [requestChangesComment, setRequestChangesComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const taskName = task.metadata.name;
  const worker = task.status?.worker;
  const isBuild = task.spec.type === "BUILD";
  const isPlan = task.spec.type === "PLAN";
  const approvalState = approvals?.[taskName];
  const alreadyApproved = approvalState?.approved === true;
  const primaryRunName = worker?.runName;

  const invalidateBoard = () => queryClient.invalidateQueries({ queryKey: ["board", projectName] });

  const approveMutation = useMutation({
    mutationFn: () => approveTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const requestChangesMutation = useMutation({
    mutationFn: (comment: string) => requestChangesTask(projectName, taskName, comment),
    onSuccess: () => { invalidateBoard(); setShowRequestChanges(false); setRequestChangesComment(""); },
  });

  const retryMutation = useMutation({
    mutationFn: () => retryEscalatedTask(projectName, taskName),
    onSuccess: invalidateBoard,
  });

  const promoteIdeaMutation = useMutation({
    mutationFn: () => moveTask(projectName, taskName, "backlog"),
    onSuccess: invalidateBoard,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteBoardTask(projectName, taskName),
    onSuccess: () => { invalidateBoard(); onDeleted(); },
  });

  const availableTabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    ...(primaryRunName ? [{ id: "session" as Tab, label: "Session" }] : []),
    ...(primaryRunName ? [{ id: "logs" as Tab, label: "Logs" }] : []),
    ...(isPlan && primaryRunName ? [{ id: "plan" as Tab, label: "Plan" }] : []),
  ];

  // If current tab is not available (e.g. run just removed), reset
  const activeTab = availableTabs.find((t) => t.id === tab) ? tab : "overview";

  return (
    <div className="flex flex-col h-full min-h-0 border-l border-border">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border space-y-2">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            {isBuild
              ? <Wrench className="h-4 w-4 text-accent" />
              : <FileText className="h-4 w-4 text-phase-pending" />
            }
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base leading-snug">{task.spec.title}</h2>
            <p className="text-xs font-mono text-text-dim mt-0.5">{taskName}</p>
          </div>
        </div>

        {/* Meta badges */}
        <div className="flex items-center gap-2 flex-wrap">
          {worker?.status && (
            <span className="text-label-md font-mono uppercase text-text-dim bg-surface-overlay px-2 py-0.5 rounded">
              {worker.status}
            </span>
          )}
          {task.spec.priority && task.spec.priority !== "medium" && (
            <span className={`text-label-md font-mono uppercase px-1.5 py-0.5 rounded flex items-center gap-0.5 ${
              task.spec.priority === "high" ? "text-phase-failed bg-phase-failed/10" : "text-text-dim bg-surface-overlay"
            }`}>
              <Flag className="h-2.5 w-2.5" />{task.spec.priority}
            </span>
          )}
          {task.spec.agent && (
            <span className="text-xs text-text-dim flex items-center gap-1">
              <User className="h-3 w-3" />{task.spec.agent}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {col === "ideas" && (
            <button
              onClick={() => promoteIdeaMutation.mutate()}
              disabled={promoteIdeaMutation.isPending}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text transition-colors disabled:opacity-40"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              {promoteIdeaMutation.isPending ? "Promoting…" : "Promote to Backlog"}
            </button>
          )}

          {col === "review" && (
            <>
              <button
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending || alreadyApproved}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  alreadyApproved
                    ? "bg-phase-succeeded/20 text-phase-succeeded border border-phase-succeeded/30 cursor-default"
                    : "bg-surface-container-high hover:bg-surface-container-highest text-text disabled:opacity-40"
                }`}
              >
                <Check className="h-3.5 w-3.5" />
                {alreadyApproved ? "Approved" : approveMutation.isPending ? "Approving…" : "Approve"}
              </button>
              <button
                onClick={() => setShowRequestChanges(true)}
                className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-phase-failed hover:border-phase-failed/40 transition-colors"
              >
                <X className="h-3.5 w-3.5" /> Request Changes
              </button>
            </>
          )}

          {(worker?.status === "Failed" || worker?.status === "Escalated") && (
            <button
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text transition-colors disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {retryMutation.isPending ? "Retrying…" : "Retry"}
            </button>
          )}

          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-phase-failed hover:border-phase-failed/40 transition-colors ml-auto"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-dim">Delete task?</span>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="rounded-md bg-phase-failed/20 border border-phase-failed/40 px-2 py-1 text-xs text-phase-failed hover:bg-phase-failed/30 transition-colors disabled:opacity-50"
              >
                {deleteMutation.isPending ? "Deleting…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-text-dim hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Request Changes inline form */}
        {showRequestChanges && (
          <div className="space-y-2 border border-border rounded-md p-3 bg-surface">
            <p className="text-xs font-medium">Review feedback</p>
            <textarea
              placeholder="Describe required changes…"
              value={requestChangesComment}
              onChange={(e) => setRequestChangesComment(e.target.value)}
              rows={4}
              className="w-full rounded border border-border bg-surface-raised px-2 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-border"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowRequestChanges(false); setRequestChangesComment(""); }}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-dim hover:text-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (requestChangesComment.trim()) {
                    requestChangesMutation.mutate(requestChangesComment.trim());
                  }
                }}
                disabled={requestChangesMutation.isPending || !requestChangesComment.trim()}
                className="rounded-md bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 px-3 py-1.5 text-xs font-medium text-text transition-colors"
              >
                {requestChangesMutation.isPending ? "Submitting…" : "Submit"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      {availableTabs.length > 1 && (
        <div className="shrink-0 flex items-center gap-0 border-b border-border px-4 overflow-x-auto">
          {availableTabs.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === id
                  ? "border-accent text-text"
                  : "border-transparent text-text-dim hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content — scrollable */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "overview" && (
          <OverviewContent task={task} col={col} projectName={projectName} />
        )}
        {activeTab === "session" && primaryRunName && (
          <RunPanel runName={primaryRunName} tab="session" />
        )}
        {activeTab === "logs" && primaryRunName && (
          <RunPanel runName={primaryRunName} tab="logs" />
        )}
        {isPlan && (
          <div className={activeTab === "plan" ? "" : "hidden"}>
            <PlanContent projectName={projectName} taskName={taskName} />
          </div>
        )}
      </div>
    </div>
  );
}

export const TaskDetailPanel = memo(TaskDetailPanelInner, (prev, next) => {
  return (
    prev.task.metadata.resourceVersion === next.task.metadata.resourceVersion &&
    prev.col === next.col &&
    prev.projectName === next.projectName &&
    prev.approvals === next.approvals &&
    prev.onDeleted === next.onDeleted
  );
});

// ---------------------------------------------------------------------------
// Empty state — shown when no task is selected
// ---------------------------------------------------------------------------
export function TaskDetailEmpty() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8 border-l border-border">
      <MousePointerClick className="h-8 w-8 text-text-dim mb-3 opacity-40" />
      <p className="text-sm text-text-dim">Select a task to view details</p>
      <p className="text-xs text-text-dim/60 mt-1">Session, logs, and plan artifacts will appear here</p>
    </div>
  );
}
