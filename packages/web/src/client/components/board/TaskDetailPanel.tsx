// TaskDetailPanel.tsx — tabbed detail view for a selected task.
// Shows: Overview, Runs (with per-run Session/Logs), Events, Plan (PLAN tasks only).
// Actions: Approve, Request Changes, Retry, Delete.

import { useState, memo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  ExternalLink, Check, X, Trash2, Flag, User,
  Wrench, FileText, RefreshCw, MousePointerClick, ArrowRight,
  ChevronDown, ChevronRight, GitCommit as GitCommitIcon,
} from "lucide-react";
import { approveTask, requestChangesTask, retryEscalatedTask, deleteBoardTask, fetchPlan, moveTask } from "../../lib/api";
import type { Task, Run, DiffCommit } from "../../lib/types";
import { useTaskRuns } from "../../hooks/useTaskRuns";
import { useTaskDiff } from "../../hooks/useTaskDiff";
import StatusBadge from "../StatusBadge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../CodeBlock";
import TaskRunsPanel from "./TaskRunsPanel";
import TaskEventsPanel from "./TaskEventsPanel";
import { FileDiff } from "../FileDiff";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

const remarkPlugins = [remarkGfm];

type Tab = "overview" | "runs" | "events" | "plan" | "diff";

interface TaskDetailPanelProps {
  task: Task;
  col: string;
  projectName: string;
  approvals: Record<string, { approved: boolean; requestChanges: boolean }> | undefined;
  onDeleted: () => void;
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
  h1: ({ children }) => <h1 className="text-headline-lg font-bold mt-4 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-headline-md font-semibold mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-body-lg font-semibold mt-2 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-body-sm font-semibold mt-2 mb-0.5">{children}</h4>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  hr: () => <hr className="my-3 border-border-muted" />,
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
    <div className="text-xs max-w-none px-4 py-3" style={{ fontSize: "12px", lineHeight: "1.5" }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={planMarkdownComponents}
      >
        {data.content}
      </ReactMarkdown>
    </div>
  );
}

type DiffViewMode = "unified" | "commits";

function CommitDiffList({ commits }: { commits: DiffCommit[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (sha: string) => {
    const next = new Set(expanded);
    if (next.has(sha)) {
      next.delete(sha);
    } else {
      next.add(sha);
    }
    setExpanded(next);
  };

  return (
    <div className="space-y-1">
      {commits.map((commit) => {
        const isOpen = expanded.has(commit.sha);
        return (
          <div key={commit.sha} className="rounded border border-border-muted bg-surface overflow-hidden">
            <button
              onClick={() => toggle(commit.sha)}
              className="flex items-center gap-2 w-full px-3 py-2 hover:bg-surface-overlay/30 transition-colors text-left"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-text-dim" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-text-dim" />
              )}
              <GitCommitIcon className="h-4 w-4 shrink-0 text-accent" />
              <span className="font-mono text-xs text-text-dim shrink-0">{commit.sha.slice(0, 7)}</span>
              <span className="text-sm text-text flex-1 truncate">{commit.subject}</span>
              <span className="text-xs text-text-dim shrink-0">
                {commit.files.length} {commit.files.length === 1 ? "file" : "files"}
              </span>
            </button>

            {isOpen && (
              <div className="border-t border-border-muted">
                {commit.body && (
                  <div className="px-3 py-2 text-xs text-text-dim whitespace-pre-wrap border-b border-border-muted bg-surface-overlay/20">
                    {commit.body}
                  </div>
                )}
                {commit.files.length > 0 ? (
                  <div className="space-y-1 p-2">
                    {commit.files.map((file) => (
                      <FileDiff
                        key={`${file.path}-${file.diff.length}`}
                        filename={file.path}
                        path={file.path}
                        diff={file.diff}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs text-text-dim italic">
                    No file changes in this commit
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiffContent({ projectName, taskName }: { projectName: string; taskName: string }) {
  const { data, status, fetchStatus, error } = useTaskDiff(projectName, taskName, true);
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");

  const isFirstLoad = status === "pending" && fetchStatus === "fetching";
  if (isFirstLoad) return <p className="text-xs text-text-dim p-4">Loading diff...</p>;
  if (error) return <p className="text-xs text-phase-failed p-4">Failed to load diff: {(error as Error).message}</p>;
  if (!data) return <p className="text-xs text-text-dim p-4">No diff data available.</p>;

  const hasCommits = data.commits && data.commits.length > 0;
  const hasFiles = data.files.length > 0;

  // Auto-switch to commits view when unified is empty but commits exist (merged scenario)
  const effectiveView = !hasFiles && hasCommits ? "commits" : viewMode;

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="rounded border border-border-muted bg-surface-overlay/30 px-3 py-2 text-xs text-text-dim">
        Base: <span className="font-mono text-text">{data.baseRef}</span>
        {"  "}
        Head: <span className="font-mono text-text">{data.headRef}</span>
        {"  "}
        Default: <span className="font-mono text-text">{data.defaultRef}</span>
      </div>

      {/* View toggle */}
      {hasCommits && (
        <div className="flex items-center gap-1 border-b border-border-muted pb-2">
          <button
            onClick={() => setViewMode("unified")}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              effectiveView === "unified"
                ? "bg-surface-raised text-text font-medium"
                : "text-text-dim hover:text-text"
            }`}
          >
            Unified
          </button>
          <button
            onClick={() => setViewMode("commits")}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              effectiveView === "commits"
                ? "bg-surface-raised text-text font-medium"
                : "text-text-dim hover:text-text"
            }`}
          >
            Commits ({data.commits!.length})
          </button>
        </div>
      )}

      {/* Unified view */}
      {effectiveView === "unified" && (
        <>
          {!hasFiles && (
            <div className="rounded border border-border-muted bg-surface px-3 py-2 text-xs text-text-dim">
              {data.reason ?? "No file changes detected."}
            </div>
          )}
          {hasFiles && (
            <div className="space-y-2">
              {data.files.map((file) => (
                <FileDiff key={`${file.path}-${file.diff.length}`} filename={file.path} path={file.path} diff={file.diff} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Commits view */}
      {effectiveView === "commits" && hasCommits && (
        <CommitDiffList commits={data.commits!} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab content
// ---------------------------------------------------------------------------
function OverviewContent({ task, col, projectName }: { task: Task; col: string; projectName: string }) {
  const worker = task.status?.worker;
  const { data: runsData } = useTaskRuns(task.metadata.name);
  const latestRun = [...(runsData ?? [])]
    .sort((a, b) => {
      const aTime = a.status?.completedAt ?? a.status?.startedAt ?? a.metadata.creationTimestamp ?? "";
      const bTime = b.status?.completedAt ?? b.status?.startedAt ?? b.metadata.creationTimestamp ?? "";
      return bTime.localeCompare(aTime);
    })[0];
  const runLinks = [
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

      {/* Latest run output */}
      {latestRun?.status?.message && (
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-label-md font-mono uppercase text-text-dim">Latest Run</p>
            <StatusBadge phase={latestRun.status.phase} />
          </div>
          <div className="rounded-md border border-border-muted bg-surface-overlay px-3 py-2 space-y-1">
            <Link
              to={`/runs/${encodeURIComponent(latestRun.metadata.name)}`}
              className="flex items-center gap-1.5 text-xs font-mono text-text-dim hover:text-text transition-colors"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {latestRun.metadata.name}
            </Link>
            <p className="text-sm whitespace-pre-wrap leading-relaxed text-text">{latestRun.status.message}</p>
          </div>
        </div>
      )}

      {/* Run links */}
      {runLinks.length > 0 && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">Runs</p>
          <div className="space-y-1">
            {runLinks.map(({ label, name }) => (
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

      {/* Child task progress (awaiting-children only) */}
      {task.status?.phase === "awaiting-children" && task.childProgress && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">
            Child Tasks ({task.childProgress.completed}/{task.childProgress.total} complete)
          </p>
          <div className="space-y-1">
            {task.childProgress.childRefs.map((childName) => (
              <button
                key={childName}
                onClick={() => {
                  // Update URL query param to show child task detail
                  const url = new URL(window.location.href);
                  url.searchParams.set("task", childName);
                  window.history.pushState({}, "", url);
                  // Trigger a popstate event so React Router picks it up
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
                className="flex items-center gap-1.5 text-sm text-text-dim hover:text-text transition-colors w-full text-left"
              >
                <Wrench className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono text-xs">{childName}</span>
              </button>
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
      <p className={`text-xs ${mono ? "font-mono" : ""} truncate text-text`}>{value}</p>
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
  const canShowDiff = task.status?.phase === "done"
    || task.status?.phase === "awaiting-human"
    || task.status?.phase === "rework-requested"
    || task.status?.phase === "succeeded"
    || task.status?.phase === "reviewing"
    || task.status?.phase === "awaiting-merge"
    || task.status?.phase === "failed";
  const approvalState = approvals?.[taskName];
  const alreadyApproved = approvalState?.approved === true;

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
    { id: "runs", label: "Runs" },
    { id: "events", label: "Events" },
    ...(isPlan ? [{ id: "plan" as Tab, label: "Plan" }] : []),
    ...(canShowDiff ? [{ id: "diff" as Tab, label: "Diff" }] : []),
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
            <h2 className="text-body-lg font-semibold leading-snug">{task.spec.title}</h2>
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
            <p className="text-label-md font-mono uppercase text-text-dim">Review feedback</p>
            <Textarea
              placeholder="Describe required changes…"
              value={requestChangesComment}
              onChange={(e) => setRequestChangesComment(e.target.value)}
              rows={4}
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
        {activeTab === "runs" && (
          <TaskRunsPanel projectName={projectName} taskName={taskName} />
        )}
        {activeTab === "events" && (
          <TaskEventsPanel projectName={projectName} taskName={taskName} />
        )}
        {isPlan && (
          <div className={activeTab === "plan" ? "" : "hidden"}>
            <PlanContent projectName={projectName} taskName={taskName} />
          </div>
        )}
        {canShowDiff && (
          <div className={activeTab === "diff" ? "" : "hidden"}>
            <DiffContent projectName={projectName} taskName={taskName} />
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
