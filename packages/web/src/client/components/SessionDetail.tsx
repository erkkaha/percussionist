import { Link, useParams } from 'react-router-dom';
import { useRun } from '../hooks/useRun';
import { useRunEvents } from '../hooks/useRunEvents';
import { useSessionStat } from '../hooks/useSessionStat';
import { type RunPhase, TERMINAL_PHASES } from '../lib/types';
import { skeletonKeys } from '../lib/utils';
import ErrorBoundary from './ErrorBoundary';
import SessionView from './SessionView';
import StatusBadge from './StatusBadge';
import TokenCounter from './TokenCounter';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

function formatTime(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function duration(start: string | undefined, end: string | undefined): string {
  if (!start) return '-';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (Number.isNaN(ms) || ms < 0) return '-';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function BackLink() {
  return (
    <Link
      to="/sessions"
      className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
    >
      <span>&larr;</span> All sessions
    </Link>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-text-dim w-36 shrink-0">{label}</span>
      <span className={`text-text ${mono ? 'font-mono text-xs' : ''} break-all`}>
        {value ?? '-'}
      </span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-64 rounded bg-surface-overlay animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-3">
          {skeletonKeys(6).map((key) => (
            <div key={key} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-3">
          {skeletonKeys(6).map((key) => (
            <div key={key} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SessionDetail() {
  const { name } = useParams<{ name: string }>();
  const runName = name ?? '';

  // The stats-DB row is the durable source of truth: it outlives the Run CR
  // (deleted after runTTLDays), so the detail page renders from it first and
  // treats the live Run CR purely as enrichment for pod/spec fields and live
  // session polling. A 404 from the Run CR is expected for old sessions and
  // must never blank the page.
  const stat = useSessionStat(runName);
  const statRow = stat.data;

  // A terminal stat means the Run CR (if any) is historical — no point polling
  // it. For an active run we keep the live polling that drives phase changes.
  const runPolling =
    statRow?.phase && TERMINAL_PHASES.has(statRow.phase as RunPhase) ? false : 3_000;
  const {
    data: run,
    error: runError,
    isLoading: runLoading,
    isFetching: runFetching,
  } = useRun(runName, runPolling);

  const runPhase = run?.status?.phase;
  const runIsActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(runName, runIsActive);

  // Both sources gone → genuinely nothing to show.
  if (stat.error && runError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
          <h2 className="text-headline-md mb-1">Failed to load session</h2>
          <p className="text-caption-xs">{(stat.error as Error).message}</p>
        </div>
      </div>
    );
  }

  // Nothing resolved yet.
  if ((stat.isLoading && runLoading) || (!statRow && !run)) {
    return (
      <div className="space-y-4">
        <BackLink />
        <DetailSkeleton />
      </div>
    );
  }

  // Merge the stat row with the Run CR. The stat is authoritative for the
  // summary fields; the Run CR fills in pod/service/spec details only when it
  // still exists. `runMissing` is true once the run fetch settled with no CR
  // (deleted after runTTLDays) — we still render the DB record.
  const displayName = statRow?.name ?? run?.metadata.name ?? runName;
  const phase = statRow?.phase ?? run?.status?.phase;
  const isActive = !!run && (!phase || !TERMINAL_PHASES.has(phase as RunPhase));
  const runMissing = !run && !runLoading;
  const startedAt = statRow?.startedAt ?? run?.status?.startedAt;
  const completedAt = statRow?.completedAt ?? run?.status?.completedAt;

  // The session card needs a session ID to attempt loading the conversation.
  // For an existing run that means `status.sessionID`; for a deleted run the
  // stats row proves a session existed, so let SessionView try the DB replay.
  const hasSession = !!run?.status?.sessionID || (runMissing && !!statRow);

  return (
    <div className="space-y-6">
      {/* Navigation */}
      <BackLink />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-headline-lg">{displayName}</h1>
            <StatusBadge phase={phase} />
            {runFetching && <span className="text-xs text-text-dim animate-pulse">refreshing</span>}
          </div>
          {run?.status?.message && !isActive && (
            <p className="text-sm text-text-muted">{run.status.message}</p>
          )}
          {statRow?.error && <p className="text-sm text-phase-failed">{statRow.error}</p>}
        </div>
        <div className="flex items-center gap-3">
          <TokenCounter
            tokensIn={statRow?.tokensIn ?? run?.status?.tokensIn}
            tokensOut={statRow?.tokensOut ?? run?.status?.tokensOut}
          />
        </div>
      </div>

      {/* Archived notice — shown when the Run CR is unavailable (typically
          deleted by the run TTL controller). The summary below comes from the
          stats DB; the conversation is restored from stored messages when they
          exist. */}
      {runMissing && (
        <div
          className="rounded border border-border-muted bg-surface-overlay/30 px-4 py-3 text-xs text-text-muted"
          data-testid="archived-notice"
        >
          The Run CR for this run is no longer available (deleted after the run TTL) — live pod and
          spec details are missing. Summary below is from the stats database; the conversation is
          restored from stored messages when available.
        </div>
      )}

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status card */}
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="text-sm font-medium text-text-muted">Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Field label="Phase" value={phase ?? 'Unknown'} />
            <Field label="Session ID" value={statRow?.id ?? run?.status?.sessionID} mono />
            <Field label="Pod" value={run?.status?.podName} mono />
            {run?.status?.serviceName && (
              <Field label="Service" value={run.status.serviceName} mono />
            )}
            <Field
              label="Created"
              value={formatTime(statRow?.createdAt ?? run?.metadata.creationTimestamp)}
            />
            <Field label="Started" value={formatTime(startedAt)} />
            <Field label="Completed" value={formatTime(completedAt)} />
            <Field label="Duration" value={duration(startedAt, completedAt)} />
          </CardContent>
        </Card>

        {/* Spec card — enrichment from the live Run CR only. */}
        {run ? (
          <Card>
            <CardHeader className="border-b border-border-muted">
              <CardTitle className="text-sm font-medium text-text-muted">Spec</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Field label="Image" value={run.spec.image} mono />
              <Field label="Agent" value={run.spec.agent} />
              {run.spec.agents && run.spec.agents.length > 0 && (
                <div className="flex items-baseline gap-3 text-sm">
                  <span className="text-text-dim w-36 shrink-0">Inline Agents</span>
                  <div className="flex flex-wrap gap-1.5">
                    {run.spec.agents.map((a) => (
                      <span
                        key={a.name}
                        className="inline-flex items-center rounded bg-surface-overlay px-2 py-0.5 text-xs font-mono text-text-muted"
                      >
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <Field label="Model" value={run.spec.model} mono />
              <Field label="Interactive" value={run.spec.interactive ? 'Yes' : 'No'} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="border-b border-border-muted">
              <CardTitle className="text-sm font-medium text-text-muted">Spec</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-text-dim">
                Live run metadata unavailable — the Run CR was deleted after the run TTL.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Task */}
      {run?.spec.task && (
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="text-sm font-medium text-text-muted">Task</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{run.spec.task}</p>
          </CardContent>
        </Card>
      )}

      {/* Session conversation */}
      <Card>
        <CardHeader className="border-b border-border-muted">
          <CardTitle className="text-sm font-medium text-text-muted">Session</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorBoundary
            fallback={
              <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-4 text-sm text-phase-failed">
                Could not load this session&apos;s conversation.
              </div>
            }
          >
            <SessionView
              name={runName}
              hasSession={hasSession}
              active={isActive}
              sseConnected={sseConnected}
              eventTick={eventTick}
            />
          </ErrorBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
