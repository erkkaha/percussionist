import { useState } from 'react';
import { useRun } from '../../hooks/useRun';
import { useRunEvents } from '../../hooks/useRunEvents';
import { useTaskRuns } from '../../hooks/useTaskRuns';
import { TERMINAL_PHASES } from '../../lib/types';
import LogViewer from '../LogViewer';
import SessionView from '../SessionView';
import StatusBadge from '../StatusBadge';

interface TaskRunsPanelProps {
  projectName: string;
  taskName: string;
}

type SubTab = 'session' | 'logs';

function age(iso: string | undefined): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function RunSubPanel({ runName }: { runName: string }) {
  const { data: run } = useRun(runName, 5_000);
  const runPhase = run?.status?.phase;
  const isActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(runName, isActive);

  if (!run) {
    return <p className="text-xs text-text-dim p-4">Loading run…</p>;
  }

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

function LogSubPanel({ runName }: { runName: string }) {
  const { data: run } = useRun(runName, 5_000);
  const runPhase = run?.status?.phase;
  const isActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(runName, isActive);

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

export default function TaskRunsPanel({ projectName, taskName }: TaskRunsPanelProps) {
  void projectName;
  const { data: runs, isLoading, error } = useTaskRuns(taskName);
  const [selectedRunName, setSelectedRunName] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('session');
  const selectedRun = runs?.find((r) => r.metadata.name === selectedRunName);

  if (isLoading) {
    return <p className="text-xs text-text-dim p-4">Loading runs…</p>;
  }

  if (error) {
    return <p className="text-xs text-phase-failed p-4">Failed to load runs: {error.message}</p>;
  }

  if (!runs || runs.length === 0) {
    return <p className="text-xs text-text-dim p-4">No runs for this task yet.</p>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Run list header */}
      <div className="shrink-0 px-4 py-2 border-b border-border">
        <p className="text-label-md font-mono uppercase text-text-dim">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Run list table */}
      <div className="shrink-0 overflow-y-auto max-h-48 border-b border-border">
        {runs.map((run) => {
          const name = run.metadata.name;
          const isSelected = selectedRunName === name;
          return (
            <button
              key={name}
              onClick={() => {
                setSelectedRunName(name);
                setSubTab('session');
              }}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-xs transition-colors hover:bg-surface-overlay/30 ${
                isSelected
                  ? 'bg-surface-overlay/50 border-l-2 border-accent'
                  : 'border-l-2 border-transparent'
              }`}
            >
              <span className="font-mono flex-1 truncate text-text">{name}</span>
              <StatusBadge phase={run.status?.phase} />
              <span className="text-text-dim shrink-0">
                {age(run.status?.startedAt ?? run.metadata.creationTimestamp)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Sub-tabs for selected run */}
      {selectedRun && (
        <>
          <div className="shrink-0 flex items-center gap-0 border-b border-border px-4">
            <button
              onClick={() => setSubTab('session')}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                subTab === 'session'
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-dim hover:text-text'
              }`}
            >
              Session
            </button>
            <button
              onClick={() => setSubTab('logs')}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                subTab === 'logs'
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-dim hover:text-text'
              }`}
            >
              Logs
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {selectedRunName && subTab === 'session' ? (
              <RunSubPanel runName={selectedRunName} />
            ) : selectedRunName ? (
              <LogSubPanel runName={selectedRunName} />
            ) : null}
          </div>
        </>
      )}

      {/* No selection */}
      {!selectedRun && runs.length > 0 && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-text-dim/60">
            Select a run above to view its session and logs
          </p>
        </div>
      )}
    </div>
  );
}
