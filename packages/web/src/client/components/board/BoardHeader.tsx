// BoardHeader.tsx — project info, metrics badge, and Add Task button.

import type { Finding } from '@percussionist/api';
import { Bug } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ManagerMetrics } from '../../lib/types';
import { Button } from '../ui/button';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 10_000) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

interface BoardHeaderProps {
  projectName: string;
  roster: string[];
  maxParallel: number | undefined;
  phase: string | undefined;
  sseConnected: boolean;
  metrics: ManagerMetrics | undefined;
  findings: Finding[] | undefined;
  onAddTask: () => void;
  showAddTask: boolean;
  onToggleFindings: () => void;
  showFindings: boolean;
  authWarning?: string;
}

export function BoardHeader({
  projectName,
  roster,
  maxParallel,
  phase,
  sseConnected,
  metrics,
  findings,
  onAddTask,
  showAddTask,
  onToggleFindings,
  showFindings,
}: BoardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 shrink-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-text-dim flex-wrap">
          <Link to="/projects" className="hover:text-text transition-colors shrink-0">
            Projects
          </Link>
          <span>/</span>
          <Link
            to={`/projects/${encodeURIComponent(projectName)}/edit`}
            className="hover:text-text transition-colors truncate max-w-[12rem]"
          >
            {projectName}
          </Link>
          <span>/</span>
          <span className="text-text shrink-0">Board</span>
        </div>
        <h1 className="text-headline-lg mt-1 truncate">{projectName}</h1>
        <p className="text-caption-xs text-text-dim mt-0.5 flex flex-wrap items-center gap-x-1">
          <span>Team:</span>
          {roster.length > 0 ? (
            <span className="truncate">{roster.join(', ')}</span>
          ) : (
            <Link
              to={`/projects/${encodeURIComponent(projectName)}/edit`}
              className="underline hover:text-text transition-colors"
            >
              add agents to roster
            </Link>
          )}
          <span className="text-text-dim/50">·</span>
          <span>Parallel: {maxParallel ?? 2}</span>
          <span className="text-text-dim/50">·</span>
          <span>Phase: {phase ?? 'Active'}</span>
          {authWarning && (
            <>
              <span className="text-text-dim/50">·</span>
              <span className="text-phase-failed" title={authWarning}>
                ⚠ Auth needed
              </span>
            </>
          )}
        </p>
        <p className="text-xs text-text-dim mt-0.5">{sseConnected ? '● live' : '○ polling'}</p>
        {metrics && (
          <div className="flex items-center gap-3 text-xs mt-1 flex-wrap text-text-dim">
            {metrics.lastReconcileAt && (
              <span title={new Date(metrics.lastReconcileAt).toISOString()}>
                Reconciled {formatRelative(metrics.lastReconcileAt)} (
                {formatDuration(metrics.lastReconcileDurationMs ?? 0)})
              </span>
            )}
            <span>Pulled: {metrics.tasksPulled}</span>
            <span>Monitored: {metrics.workersMonitored}</span>
            {metrics.lastReconcileResult === 'error' && (
              <span className="text-phase-failed">{metrics.lastError ?? 'error'}</span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          onClick={onToggleFindings}
          variant={showFindings ? 'default' : 'secondary'}
          size="sm"
          className="gap-1.5"
        >
          <Bug className="h-3.5 w-3.5" />
          Findings{findings && findings.length > 0 ? ` (${findings.length})` : ''}
        </Button>
        <Button onClick={onAddTask} variant="secondary" size="sm">
          {showAddTask ? 'Cancel' : '+ Add Task'}
        </Button>
      </div>
    </div>
  );
}
