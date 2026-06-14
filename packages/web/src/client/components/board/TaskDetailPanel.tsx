// TaskDetailPanel.tsx — tabbed detail view for a selected task.
// Shows: Overview, Runs (with per-run Session/Logs), Events, Plan (PLAN tasks only).
// Actions: Approve, Request Changes, Retry, Delete.

import { useState, useMemo, memo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  ExternalLink, Check, X, Trash2, Flag, User,
  Wrench, FileText, RefreshCw, MousePointerClick, ArrowRight,
  ChevronDown, ChevronRight, GitCommit as GitCommitIcon,
  History, Sparkles, AlertCircle,
} from "lucide-react";
import { approveTask, requestChangesTask, retryEscalatedTask, deleteBoardTask, fetchPlan, moveTask, retryReviewTask } from "../../lib/api";
import type { Task, Run, DiffCommit, TaskDiffFinding, DiffFindingSeverity } from "../../lib/types";
import {
  DIFF_FINDING_SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_DOT_CLASS,
  SEVERITY_BG_CLASS,
  countBySeverity,
  sortFindings,
  type DiffFindingSort,
} from "../../lib/diff-findings";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

const remarkPlugins = [remarkGfm];

const SEVERITY_RANK: Record<DiffFinding["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function formatFindingForFeedback(finding: DiffFinding): string {
  const anchor = finding.anchors[0];
  const location = anchor ? `${anchor.path}:${anchor.line}` : "unknown location";
  const category = finding.category ? ` (${finding.category})` : "";
  return `- **[${finding.severity}]** ${location}${category} — ${finding.title}\n  ${finding.comment}`;
}

function buildReworkFeedbackFromFindings(findings: DiffFinding[], max = 5): string {
  const sorted = [...findings].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    return scoreB - scoreA;
  });

  return sorted
    .slice(0, max)
    .map((f) => formatFindingForFeedback(f))
    .join("\n\n");
}

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

// ---------------------------------------------------------------------------
// Task description markdown components — tuned for compact board detail display
// ---------------------------------------------------------------------------
const taskDescriptionMarkdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="my-0 text-sm leading-relaxed">{children}</p>,
  pre: ({ children }) => <div className="mb-2">{children}</div>,
  code: ({ children, className }) => {
    const lang = className?.replace("language-", "") ?? "";
    const code = String(children).replace(/\n$/, "");
    if (lang || code.includes("\n")) {
      return <CodeBlock code={code} language={lang} />;
    }
    return <span className="bg-surface-sunken rounded px-1 py-0.5 text-xs font-mono">{children}</span>;
  },
  h1: ({ children }) => <h1 className="text-headline-md font-semibold mt-3 mb-1 text-text">{children}</h1>,
  h2: ({ children }) => <h2 className="text-body-lg font-semibold mt-2 mb-1 text-text">{children}</h2>,
  h3: ({ children }) => <h3 className="text-body-sm font-semibold mt-2 mb-0.5 text-text">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1 text-sm">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  hr: () => <hr className="my-2 border-border-muted" />,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2">
      <table className="border-collapse text-xs w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-raised">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-border-muted">{children}</tbody>,
  tr: ({ children }) => <tr className="hover:bg-surface-overlay/30 transition-colors">{children}</tr>,
  th: ({ children }) => <th className="border border-border px-2 py-1.5 font-semibold text-left">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 text-sm">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80 underline decoration-dotted">
      {children}
    </a>
  ),
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

function CommitDiffList({ commits, findings }: { commits: DiffCommit[]; findings: TaskDiffFinding[] }) {
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
                        findings={findings}
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
  const [severityFilter, setSeverityFilter] = useState<DiffFindingSeverity | "all">("all");
  const [sortBy, setSortBy] = useState<DiffFindingSort>("severity");
  const [showStale, setShowStale] = useState(true);

  const isFirstLoad = status === "pending" && fetchStatus === "fetching";
  if (isFirstLoad) return <p className="text-xs text-text-dim p-4">Loading diff...</p>;
  if (error) return <p className="text-xs text-phase-failed p-4">Failed to load diff: {(error as Error).message}</p>;
  if (!data) return <p className="text-xs text-text-dim p-4">No diff data available.</p>;

  const hasCommits = data.commits && data.commits.length > 0;
  const hasFiles = data.files.length > 0;

  // Auto-switch to commits view when unified is empty but commits exist (merged scenario)
  const effectiveView = !hasFiles && hasCommits ? "commits" : viewMode;

  const afterStale = useMemo(
    () => (showStale ? (data.findings ?? []) : (data.findings ?? []).filter((f) => !f.isStale)),
    [data.findings, showStale],
  );
  const severityCounts = useMemo(() => countBySeverity(afterStale), [afterStale]);
  const findings = useMemo(
    () =>
      sortFindings(
        afterStale.filter((f) => severityFilter === "all" || f.severity === severityFilter),
        sortBy,
      ),
    [afterStale, severityFilter, sortBy],
  );

  const totalFindings = data.findings?.length ?? 0;
  const hasFindings = totalFindings > 0;
  const visibleCount = findings.length;

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="rounded border border-border-muted bg-surface-overlay/30 px-3 py-2 text-xs text-text-dim">
        Base: <span className="font-mono text-text">{data.baseRef}</span>
        {"  "}
        Head: <span className="font-mono text-text">{data.headRef}</span>
        {"  "}
        Default: <span className="font-mono text-text">{data.defaultRef}</span>
      </div>

      {/* Findings summary panel */}
      {hasFindings && (
        <div className="rounded border border-border-muted bg-surface px-3 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 text-text-dim" />
              <span className="text-xs font-medium text-text">
                Findings ({visibleCount})
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                value={severityFilter}
                onValueChange={(v) => setSeverityFilter(v as DiffFindingSeverity | "all")}
              >
                <SelectTrigger className="h-7 w-auto min-w-[7rem] text-xs px-2 py-1">
                  <SelectValue placeholder="All severities" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  {DIFF_FINDING_SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {SEVERITY_LABEL[severity]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={sortBy} onValueChange={(v) => setSortBy(v as DiffFindingSort)}>
                <SelectTrigger className="h-7 w-auto min-w-[6rem] text-xs px-2 py-1">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="severity">Severity</SelectItem>
                  <SelectItem value="score">Score</SelectItem>
                  <SelectItem value="path">Path</SelectItem>
                  <SelectItem value="line">Line</SelectItem>
                </SelectContent>
              </Select>

              <label className="flex items-center gap-1.5 text-xs text-text-dim cursor-pointer">
                <Switch checked={showStale} onCheckedChange={setShowStale} />
                Stale
              </label>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {DIFF_FINDING_SEVERITIES.map((severity) => {
              const count = severityCounts[severity];
              if (count === 0) return null;
              const active = severityFilter === severity;
              return (
                <button
                  key={severity}
                  onClick={() => setSeverityFilter(active ? "all" : severity)}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
                    active ? `border-accent ${SEVERITY_BG_CLASS[severity]}` : SEVERITY_BG_CLASS[severity]
                  }`}
                  title={`Filter ${SEVERITY_LABEL[severity].toLowerCase()} findings`}
                >
                  <span
                    className={`inline-block rounded-full ${SEVERITY_DOT_CLASS[severity]}`}
                    style={{ width: 5, height: 5 }}
                  />
                  {SEVERITY_LABEL[severity]} {count}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
                <FileDiff
                  key={`${file.path}-${file.diff.length}`}
                  filename={file.path}
                  path={file.path}
                  diff={file.diff}
                  findings={findings}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Commits view */}
      {effectiveView === "commits" && hasCommits && (
        <CommitDiffList commits={data.commits!} findings={findings} />
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
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [showReviews, setShowReviews] = useState(false);
  const allRuns = [...(runsData ?? [])]
    .sort((a, b) => {
      const aTime = a.status?.completedAt ?? a.status?.startedAt ?? a.metadata.creationTimestamp ?? "";
      const bTime = b.status?.completedAt ?? b.status?.startedAt ?? b.metadata.creationTimestamp ?? "";
      return bTime.localeCompare(aTime);
    });
  const toggleRun = (name: string) => {
    const next = new Set(expandedRuns);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    setExpandedRuns(next);
  };

  return (
    <div className="space-y-4 px-4 py-3">
      {/* Description */}
      {task.spec.description && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">Description</p>
          <ReactMarkdown remarkPlugins={remarkPlugins} components={taskDescriptionMarkdownComponents}>
            {task.spec.description}
          </ReactMarkdown>
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

      {/* Review history */}
      {task.status?.reviews && task.status.reviews.length > 0 && (
        <div>
          <button
            onClick={() => setShowReviews(!showReviews)}
            className="flex items-center gap-1.5 text-label-md font-mono uppercase text-text-dim mb-1.5 hover:text-text transition-colors"
          >
            <History className="h-3.5 w-3.5" />
            Review History ({task.status.reviews.length})
            {showReviews ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          {showReviews && (
            <div className="space-y-2">
              {task.status.reviews.map((r, i) => {
                const actionLabel = r.action === "approve" ? "Approved" : r.action === "request_changes" ? "Changes Requested" : "Escalated";
                const actionColor = r.action === "approve" ? "text-phase-succeeded border-phase-succeeded/30 bg-phase-succeeded/10"
                  : r.action === "request_changes" ? "text-phase-pending border-phase-pending/30 bg-phase-pending/10"
                  : "text-phase-failed border-phase-failed/30 bg-phase-failed/10";
                return (
                  <div key={i} className="rounded border border-border-muted bg-surface p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${actionColor}`}>
                          {r.action === "approve" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          {actionLabel}
                        </span>
                        {r.attempt !== undefined && (
                          <span className="text-xs text-text-dim">attempt #{r.attempt}</span>
                        )}
                      </div>
                      <span className="text-xs text-text-dim shrink-0">
                        {formatReviewTime(r.reviewedAt)}
                      </span>
                    </div>
                    {r.diagnosis && (
                      <p className="text-xs text-text leading-relaxed">{r.diagnosis}</p>
                    )}
                    {r.feedback && (
                      <p className="text-xs text-text-muted leading-relaxed">{r.feedback}</p>
                    )}
                    {r.reviewRunName && (
                      <Link
                        to={`/runs/${encodeURIComponent(r.reviewRunName)}`}
                        className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {r.reviewRunName}
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Runs collapsible list */}
      {allRuns.length > 0 && (
        <div>
          <p className="text-label-md font-mono uppercase text-text-dim mb-1.5">
            Runs ({allRuns.length})
          </p>
          <div className="space-y-1">
            {allRuns.map((run) => {
              const isOpen = expandedRuns.has(run.metadata.name);
              const startedAt = run.status?.startedAt ?? run.metadata.creationTimestamp ?? "";
              const completedAt = run.status?.completedAt;
              const minutesAgo = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
              const timeStr = minutesAgo < 1 ? "just now"
                : minutesAgo < 60 ? `${minutesAgo}m ago`
                : `${Math.floor(minutesAgo / 60)}h ago`;
              const duration = startedAt ? (() => {
                const startMs = new Date(startedAt).getTime();
                const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
                const secs = Math.round((endMs - startMs) / 1000);
                if (secs < 60) return `${secs}s`;
                return `${Math.floor(secs / 60)}m ${secs % 60}s`;
              })() : null;
              const hasTokens = run.status?.tokensIn !== undefined || run.status?.tokensOut !== undefined;

              return (
                <div key={run.metadata.name} className="rounded border border-border-muted bg-surface overflow-hidden">
                  <button
                    onClick={() => toggleRun(run.metadata.name)}
                    className="flex items-center gap-2 w-full px-3 py-2 hover:bg-surface-overlay/30 transition-colors text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-text-dim" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-dim" />
                    )}
                    <span className="font-mono text-xs text-text-dim shrink-0">
                      {run.metadata.name}
                    </span>
                    <StatusBadge phase={run.status?.phase} />
                    <span className="text-xs text-text-dim">{run.spec?.agent}</span>
                    <span className="text-xs text-text-dim ml-auto">{timeStr}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border-muted px-3 py-2 space-y-2">
                      {run.status?.message ? (
                        <ReactMarkdown remarkPlugins={remarkPlugins} components={taskDescriptionMarkdownComponents}>
                          {run.status.message}
                        </ReactMarkdown>
                      ) : (
                        <p className="text-xs text-text-dim italic">No output</p>
                      )}
                      {(hasTokens || duration) && (
                        <div className="flex items-center gap-3 text-xs text-text-dim">
                          {hasTokens && (
                            <span>Tokens: {run.status?.tokensIn ?? 0} in / {run.status?.tokensOut ?? 0} out</span>
                          )}
                          {duration && <span>Duration: {duration}</span>}
                        </div>
                      )}
                      <Link
                        to={`/runs/${encodeURIComponent(run.metadata.name)}`}
                        className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
                      >
                        Open run page &rarr;
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
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

function formatReviewTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
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

  const retryReviewMutation = useMutation({
    mutationFn: () => retryReviewTask(projectName, taskName),
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
              {task.status?.phase === "awaiting-human" && worker?.reviewRunName && task.spec.type === "BUILD" && (
                <button
                  onClick={() => retryReviewMutation.mutate()}
                  disabled={retryReviewMutation.isPending}
                  className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text transition-colors disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {retryReviewMutation.isPending ? "Retrying…" : "Retry Review"}
                </button>
              )}
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-label-md font-mono uppercase text-text-dim">Review feedback</p>
              {(() => {
                const items = task.status?.diffFindings?.items;
                if (!items || items.length === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      const findingsText = buildReworkFeedbackFromFindings(items, 5);
                      const prefix = requestChangesComment.trim()
                        ? `${requestChangesComment.trim()}\n\n`
                        : "";
                      setRequestChangesComment(`${prefix}${findingsText}`);
                    }}
                    className="flex items-center gap-1 text-xs text-text-dim hover:text-text transition-colors"
                  >
                    <Sparkles className="h-3 w-3" />
                    Insert top findings ({items.length})
                  </button>
                );
              })()}
            </div>
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
