// board/FindingsPanel.tsx — board-level findings panel.
//
// Displays agent-reported findings (bugs, security, performance, debt) surfaced
// via the report_unrelated_issue MCP tool. Shows severity badges, categories, and action buttons.

import {
  ArrowRight,
  BookOpen,
  Bug,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileCode,
  Gauge,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { usePromoteFindingToTask, useUpdateFinding } from '../../hooks/useFindings';
import { isClosedFindingStatus } from '../../lib/findings';
import type { Finding } from '../../lib/types';

const FINDING_SEVERITIES: Finding['severity'][] = ['critical', 'high', 'medium', 'low'];
const _FINDING_CATEGORIES: Finding['category'][] = [
  'bug',
  'security',
  'performance',
  'debt',
  'docs',
  'other',
];
const _FINDING_STATUSES: Finding['status'][] = [
  'triaged',
  'in-progress',
  'resolved',
  'wontfix',
  'duplicate',
];

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SEVERITY_DOT: Record<Finding['severity'], string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

const SEVERITY_BG: Record<Finding['severity'], string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
};

const CATEGORY_ICON: Record<Finding['category'], typeof Bug> = {
  bug: Bug,
  security: ShieldAlert,
  performance: Gauge,
  debt: FileCode,
  docs: BookOpen,
  other: CircleDot,
};

const _CATEGORY_LABEL: Record<Finding['category'], string> = {
  bug: 'Bug',
  security: 'Security',
  performance: 'Performance',
  debt: 'Debt',
  docs: 'Docs',
  other: 'Other',
};

const STATUS_LABEL: Record<Finding['status'], string> = {
  new: 'New',
  triaged: 'Triaged',
  'in-progress': 'In Progress',
  resolved: 'Resolved',
  duplicate: 'Duplicate',
  wontfix: "Won't Fix",
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface FindingsPanelProps {
  findings: Finding[];
  projectName: string;
  onClose?: () => void;
}

export function FindingsPanel({ findings, projectName, onClose }: FindingsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Finding['severity'] | 'all'>('all');
  const [hideClosed, setHideClosed] = useState(false);
  const updateFindingMutation = useUpdateFinding(projectName);
  const promoteMutation = usePromoteFindingToTask(projectName);

  const filtered =
    severityFilter === 'all' ? findings : findings.filter((f) => f.severity === severityFilter);

  const visible = hideClosed ? filtered.filter((f) => !isClosedFindingStatus(f.status)) : filtered;

  const setStatus = (id: string, status: Finding['status']) =>
    updateFindingMutation.mutate({ id, req: { status } });

  const counts = FINDING_SEVERITIES.reduce<Record<string, number>>((acc, sev) => {
    acc[sev] = findings.filter((f) => f.severity === sev).length;
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-text shrink-0">Findings ({findings.length})</h2>
          <button
            onClick={() => setHideClosed((v) => !v)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border transition-colors shrink-0 ${
              hideClosed
                ? 'border-accent bg-surface-overlay text-text'
                : 'border-border bg-surface text-text-dim hover:text-text'
            }`}
          >
            {hideClosed ? 'Show closed' : 'Hide closed'}
          </button>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {findings.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 pb-2 shrink-0 flex-wrap">
          <button
            onClick={() => setSeverityFilter('all')}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
              severityFilter === 'all'
                ? 'border-accent bg-surface-overlay text-text'
                : 'border-border bg-surface text-text-dim hover:text-text'
            }`}
          >
            All {findings.length}
          </button>
          {FINDING_SEVERITIES.map((sev) =>
            (counts[sev] ?? 0) > 0 ? (
              <button
                key={sev}
                onClick={() => setSeverityFilter(severityFilter === sev ? 'all' : sev)}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
                  severityFilter === sev ? `border-accent ${SEVERITY_BG[sev]}` : SEVERITY_BG[sev]
                }`}
              >
                <span
                  className={`inline-block rounded-full ${SEVERITY_DOT[sev]}`}
                  style={{ width: 5, height: 5 }}
                />
                {SEVERITY_LABEL[sev]} {counts[sev]}
              </button>
            ) : null,
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {findings.length === 0 ? (
          <div className="text-center py-8">
            <Bug className="h-8 w-8 mx-auto text-text-dim/30 mb-2" />
            <p className="text-sm text-text-dim">No findings reported yet.</p>
            <p className="text-xs text-text-dim/60 mt-1">
              Agents report issues outside their own task via the{' '}
              <code className="text-xs bg-surface-overlay px-1 rounded">
                report_unrelated_issue
              </code>{' '}
              tool. Comments a reviewer left on a diff are not here — they are on the task.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-xs text-text-dim py-4 text-center">
            {hideClosed && findings.some((f) => isClosedFindingStatus(f.status))
              ? 'All findings in this view are closed — clear "Hide closed" to see them.'
              : `No ${severityFilter === 'all' ? '' : `${severityFilter} `}findings.`}
          </p>
        ) : (
          visible.map((f) => {
            const isExpanded = expandedId === f.id;
            const CategoryIcon = CATEGORY_ICON[f.category] ?? CircleDot;

            return (
              <div
                key={f.id}
                className={`rounded-md border transition-colors ${
                  isExpanded
                    ? 'border-border bg-surface-overlay'
                    : 'border-border/50 hover:border-border'
                }`}
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : f.id)}
                  className="w-full flex items-start gap-2 p-2.5 text-left"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0 text-text-dim" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-text-dim" />
                  )}
                  <CategoryIcon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-text-dim" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase border ${SEVERITY_BG[f.severity]}`}
                      >
                        {SEVERITY_LABEL[f.severity]}
                      </span>
                      <span className="text-[10px] text-text-dim uppercase">{f.category}</span>
                      {f.occurrences > 1 && (
                        <span className="text-[10px] text-text-dim">x{f.occurrences}</span>
                      )}
                    </div>
                    <p className="text-sm text-text mt-0.5 line-clamp-2">{f.title}</p>
                    {f.filePath && (
                      <p className="text-[10px] text-text-dim mt-0.5 truncate font-mono">
                        {f.filePath}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center shrink-0">
                    <span
                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        f.status === 'triaged'
                          ? 'text-yellow-400 bg-yellow-500/10'
                          : f.status === 'in-progress'
                            ? 'text-blue-400 bg-blue-500/10'
                            : f.status === 'resolved'
                              ? 'text-green-400 bg-green-500/10'
                              : f.status === 'wontfix'
                                ? 'text-gray-400 bg-gray-500/10'
                                : f.status === 'duplicate'
                                  ? 'text-gray-400 bg-gray-500/10'
                                  : 'text-text-dim bg-surface-overlay'
                      }`}
                    >
                      {STATUS_LABEL[f.status] ?? f.status}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-2.5 pb-2.5 pt-0 border-t border-border/30 mt-0 space-y-2">
                    <p className="text-xs text-text-dim whitespace-pre-wrap">{f.description}</p>
                    {f.snippet && (
                      <pre className="text-[10px] text-text-dim bg-surface-overlay rounded p-2 overflow-x-auto font-mono max-h-32">
                        {f.snippet.slice(0, 500)}
                      </pre>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-text-dim">
                      {f.source.task && <span>Task: {f.source.task}</span>}
                      {f.source.run && <span>Run: {f.source.run}</span>}
                      {f.source.agent && <span>Agent: {f.source.agent}</span>}
                      {f.taskRef && (
                        <a
                          href={`?task=${encodeURIComponent(f.taskRef)}`}
                          className="text-accent hover:underline inline-flex items-center gap-0.5"
                        >
                          Task: {f.taskRef} <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                      {f.clusterId && <span>Cluster: {f.clusterId.slice(0, 12)}</span>}
                      <span>{formatRelative(f.triagedAt ?? f.createdAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/30">
                      {isClosedFindingStatus(f.status) ? (
                        <button
                          type="button"
                          disabled={updateFindingMutation.isPending}
                          onClick={() => setStatus(f.id, 'triaged')}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border bg-surface text-text-dim hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Reopen
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={updateFindingMutation.isPending}
                            onClick={() => setStatus(f.id, 'resolved')}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border bg-surface text-text-dim hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            disabled={updateFindingMutation.isPending}
                            onClick={() => setStatus(f.id, 'wontfix')}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border bg-surface text-text-dim hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Won't Fix
                          </button>
                          <button
                            type="button"
                            disabled={updateFindingMutation.isPending}
                            onClick={() => setStatus(f.id, 'duplicate')}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border bg-surface text-text-dim hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Duplicate
                          </button>
                          {!f.taskRef && (
                            <button
                              type="button"
                              disabled={promoteMutation.isPending}
                              onClick={() => promoteMutation.mutate({ id: f.id })}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border bg-surface text-text-dim hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {promoteMutation.isPending ? (
                                'Promoting…'
                              ) : (
                                <>
                                  <ArrowRight className="h-3 w-3" /> Promote to Task
                                </>
                              )}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
