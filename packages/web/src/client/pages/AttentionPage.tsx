// AttentionPage.tsx — global "Needs attention" HITL inbox.
//
// Lists every task in the namespace parked on a human decision
// (awaiting-human / waiting-for-input / failed) from the server-authoritative
// GET /api/attention endpoint. Read-only: each row links straight to the task
// on its project board using the same URL shape as Web Push. Inline quick
// actions live in a follow-up BUILD task.

import { FileText, Inbox, User, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAttention } from '../hooks/useAttention';
import { projectColor } from '../lib/project-color';
import type { AttentionItem, AttentionPhase } from '../lib/types';

// Same terse relative-time helper as TaskRow.tsx, so ages read identically on
// the board and in the inbox.
function age(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Reason-badge tone per phase: questions are amber, failures red, and tasks
// parked on approval get the neutral accent color.
const REASON_TONE: Record<AttentionPhase, string> = {
  'waiting-for-input': 'text-amber-400',
  failed: 'text-phase-failed',
  'awaiting-human': 'text-accent',
};

function TypeIcon({ type }: { type: AttentionItem['type'] }) {
  return type === 'BUILD' ? (
    <Wrench className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
  ) : (
    <FileText className="h-3.5 w-3.5 shrink-0 text-phase-pending" aria-hidden="true" />
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const color = projectColor(item.project);
  return (
    <div className="flex items-start gap-3 border-b border-border/50 last:border-0 px-4 py-3 hover:bg-surface-raised/40 transition-colors">
      {/* PLAN/BUILD type icon */}
      <div className="mt-0.5">
        <TypeIcon type={item.type} />
      </div>

      {/* Title + metadata */}
      <div className="flex-1 min-w-0 space-y-1">
        <Link
          to={item.url}
          className="block text-sm font-medium text-text hover:text-accent transition-colors truncate"
          title={item.title}
        >
          {item.title}
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Project chip — deterministic accent color, links to the board. */}
          <Link
            to={`/projects/${encodeURIComponent(item.project)}/board`}
            className="text-label-md font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 truncate max-w-[140px]"
            style={{ color, borderColor: color }}
            title={item.project}
          >
            {item.project}
          </Link>

          <span className={`text-label-md font-mono uppercase ${REASON_TONE[item.phase]}`}>
            {item.reason}
          </span>

          {item.agent && (
            <span className="text-label-md font-mono uppercase text-text-dim flex items-center gap-0.5">
              <User className="h-2.5 w-2.5" aria-hidden="true" />
              {item.agent}
            </span>
          )}
        </div>
        {item.detail && (
          <p className="text-xs text-text-dim truncate" title={item.detail}>
            {item.detail}
          </p>
        )}
      </div>

      {/* Relative age */}
      <span className="text-xs text-text-muted shrink-0 mt-0.5" title={item.since}>
        {age(item.since)}
      </span>
    </div>
  );
}

interface ProjectGroup {
  project: string;
  items: AttentionItem[];
}

/**
 * Group the items by project while preserving the server's oldest-first order:
 * a project's first appearance fixes its group position, and items keep their
 * relative order inside the group. Re-sorts defensively so a caller that hands
 * over an unsorted list still renders oldest-first.
 */
function groupByProject(items: AttentionItem[]): ProjectGroup[] {
  const sorted = [...items].sort((a, b) => {
    if (a.since === b.since) return 0;
    return a.since < b.since ? -1 : 1;
  });
  const groups = new Map<string, AttentionItem[]>();
  for (const item of sorted) {
    const existing = groups.get(item.project);
    if (existing) existing.push(item);
    else groups.set(item.project, [item]);
  }
  return Array.from(groups.entries()).map(([project, grouped]) => ({
    project,
    items: grouped,
  }));
}

export default function AttentionPage() {
  const { data, isLoading, error } = useAttention();
  const items = data?.items ?? [];
  const groups = useMemo(() => groupByProject(items), [items]);
  const count = data?.count ?? items.length;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header — title, live count, helper text. */}
      <header className="mb-4 space-y-1">
        <div className="flex items-center gap-2.5">
          <Inbox className="w-4 h-4 text-text-muted" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-text">Needs attention</h1>
          {data && count > 0 && (
            <span className="text-label-md font-mono uppercase text-text-muted">
              {count} waiting
            </span>
          )}
        </div>
        <p className="text-xs text-text-dim">
          Tasks across all projects parked on a human decision, oldest first.
        </p>
      </header>

      {/* States match BoardView conventions. */}
      {isLoading && !data && <p className="text-sm text-text-dim p-4">Loading…</p>}
      {error && !data && (
        <p className="text-sm text-phase-failed p-4">Failed to load attention items.</p>
      )}
      {!isLoading && !error && items.length === 0 && (
        <p className="text-sm text-text-dim p-4">Nothing needs your attention.</p>
      )}

      {/* Rows grouped by project, group header links to that project's board. */}
      {groups.map((group) => (
        <section key={group.project} className="mb-4">
          <div className="flex items-center gap-2 px-4 py-1.5 bg-surface-raised/40 border-b border-border/50">
            <Link
              to={`/projects/${encodeURIComponent(group.project)}/board`}
              className="text-label-md font-mono uppercase text-text-muted hover:text-text transition-colors truncate"
              title={group.project}
            >
              {group.project}
            </Link>
            <span className="text-label-md font-mono uppercase text-text-dim">
              {group.items.length}
            </span>
          </div>
          <div className="rounded-md border border-border overflow-hidden">
            {group.items.map((item) => (
              <AttentionRow key={item.taskName} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
