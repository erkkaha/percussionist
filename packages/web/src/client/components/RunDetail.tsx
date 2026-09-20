import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCopy, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useRun } from '../hooks/useRun';
import { useRunEvents } from '../hooks/useRunEvents';
import { useSession } from '../hooks/useSession';
import { deleteRun, interruptRun } from '../lib/api';
import { deriveRunSummary, type RunSummary } from '../lib/run-summary';
import type { RelatedTask, RunDetail as RunDetailData } from '../lib/types';
import { TERMINAL_PHASES } from '../lib/types';
import LogViewer from './LogViewer';
import ModeBadge from './ModeBadge';
import type { RunView } from './run-terminal/commands';
import type { CommandOutputEntry } from './run-terminal/RunCommandBar';
import RunCommandBar from './run-terminal/RunCommandBar';
import type { LocalEntry } from './run-terminal/TerminalTranscript';
import TerminalTranscript from './run-terminal/TerminalTranscript';
import StatusBadge from './StatusBadge';
import TerminalTab from './TerminalTab';
import TokenCounter from './TokenCounter';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const WORKSPACE_INIT_CONTAINER = 'workspace-init';

const RUN_VIEWS: readonly RunView[] = ['conversation', 'logs', 'status', 'shell'];

/**
 * Legacy `?tab=` deep links map onto the terminal's view modes so old bookmarks
 * keep working after the tab bar was replaced by slash commands.
 */
const LEGACY_TAB_TO_VIEW: Record<string, RunView> = {
  overview: 'status',
  session: 'conversation',
  logs: 'logs',
  terminal: 'shell',
};

/** Read the requested view: `?view=` first, then a legacy `?tab=` fallback. */
function resolveRequestedView(searchParams: URLSearchParams): RunView | null {
  const view = searchParams.get('view');
  if (view && (RUN_VIEWS as readonly string[]).includes(view)) return view as RunView;
  const tab = searchParams.get('tab');
  if (tab && tab in LEGACY_TAB_TO_VIEW) return LEGACY_TAB_TO_VIEW[tab] ?? null;
  return null;
}

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

/** Relative "as of" age for a summary activity timestamp, or null. */
function relativeAge(ms: number | null): string | null {
  if (ms === null) return null;
  const delta = Date.now() - ms;
  if (Number.isNaN(delta) || delta < 0) return null;
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Board deep link for a run's linked task. Null when either the task did not
 * resolve (deleted) or the project is unknown, so callers degrade to plain text
 * instead of rendering a dead link.
 */
function boardTaskLink(project?: string | null, relatedTask?: RelatedTask | null): string | null {
  if (!project || !relatedTask) return null;
  return `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(relatedTask.name)}`;
}

/**
 * RunDetail — the immersive cloud terminal for a single run.
 *
 * The page is one full-viewport shell: a slim header, a single stage, and a
 * persistent command prompt. The old tab bar is gone; functionality is reached
 * with slash commands (`/logs`, `/status`, `/conversation`, `/shell`, …) typed
 * into the prompt, or by deep-linking `?view=` (legacy `?tab=` still maps).
 */
export default function RunDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: run, error, isLoading, isFetching } = useRun(name ?? '');
  const runPhase = run?.status?.phase;
  const runIsActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(name ?? '', runIsActive);
  // Session-derived activity for the summary. Gated on `hasSession` so a run
  // that never started a session does not issue a request that can only 404.
  // Shares the `['session', name]` cache with TerminalTranscript, so viewing
  // both the strip and the conversation does not double-fetch.
  const { data: sessionForSummary } = useSession(name ?? '', !!run?.status?.sessionID);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [logContainer, setLogContainer] = useState<string | undefined>(undefined);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const localEntryIdRef = useRef(0);

  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(name ?? ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigate('/runs');
    },
  });

  const phase = run?.status?.phase;
  const isActive = !!run && (!phase || !TERMINAL_PHASES.has(phase));
  const isFailed = phase === 'Failed';
  const hasSession = !!run?.status?.sessionID;

  // The interactive attach needs an active run whose pod is Running. The claude
  // engine still reaches the `shell` stage so its explanation stays available —
  // the stage branches on the engine and renders the explainer instead of xterm.
  const attachRunning = isActive && !!run?.status?.podName && run?.status?.podPhase === 'Running';

  const requestedView = resolveRequestedView(searchParams);
  const activeView: RunView =
    requestedView && (requestedView !== 'shell' || attachRunning) ? requestedView : 'conversation';

  // Keep ?view= honest: when the requested view is not available (the run left
  // the attachable state) rewrite the param to the fallback so a refresh never
  // asks for a stage that cannot render. Mirrors TaskRunsPanel's reset effect.
  useEffect(() => {
    if (!run) return;
    const rawView = searchParams.get('view');
    const rawTab = searchParams.get('tab');
    if (!rawView && !rawTab) return;
    if (requestedView === activeView) return;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('tab');
        params.set('view', activeView);
        return params;
      },
      { replace: true },
    );
  }, [run, searchParams, requestedView, activeView, setSearchParams]);

  const setView = useCallback(
    (next: RunView) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete('tab');
          params.set('view', next);
          return params;
        },
        // Replace so view toggles do not pollute the back button.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const appendEntry = useCallback((entry: CommandOutputEntry) => {
    localEntryIdRef.current += 1;
    const id = `local-${localEntryIdRef.current}`;
    setLocalEntries((prev) => [
      ...prev,
      { id, kind: entry.kind, text: entry.text, at: Date.now() },
    ]);
  }, []);

  const clearEntries = useCallback(() => setLocalEntries([]), []);

  const invalidate = useCallback(
    (queryKey: readonly unknown[]) => {
      void queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
    },
    [queryClient],
  );

  const refresh = useCallback(() => {
    invalidate(['run', name]);
    invalidate(['session', name]);
    invalidate(['logs', name]);
  }, [invalidate, name]);

  if (!name) return null;

  if (error) {
    return (
      // Pull out of the parent p-6 padding so the shell fills the viewport.
      <div
        className="-m-6 flex flex-col bg-surface-container-lowest font-mono"
        style={{ height: 'calc(100svh - 3.5rem)' }}
      >
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          <BackLink />
          <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
            <h2 className="text-headline-md mb-1">Failed to load run</h2>
            <p className="text-caption-xs">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !run) {
    return (
      <div
        className="-m-6 flex flex-col bg-surface-container-lowest font-mono"
        style={{ height: 'calc(100svh - 3.5rem)' }}
      >
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          <BackLink />
          <DetailSkeleton />
        </div>
      </div>
    );
  }

  // When the run failed on an init container (workspace-init), default the log
  // viewer to that container so the error is immediately visible.
  const failedOnInit = isFailed && run.status?.message?.startsWith('init container');
  const defaultLogContainer = failedOnInit ? WORKSPACE_INIT_CONTAINER : 'bootstrap';
  const effectiveLogContainer = logContainer ?? defaultLogContainer;

  // One derived summary shared by the header strip and the status-view card, so
  // the two can never disagree. Pure derivation: no model prose, only the
  // resolved task, prompt, phase/status timestamps and structured tool parts.
  const summary = deriveRunSummary({
    run,
    relatedTask: run.relatedTask,
    sessionMessages: sessionForSummary?.messages,
    now: Date.now(),
  });

  return (
    // Root stays the established `-m-6` viewport idiom shared with BoardView and
    // ActivityPage, now wearing the terminal surface and monospace font.
    <div
      className="-m-6 flex flex-col bg-surface-container-lowest font-mono"
      style={{ height: 'calc(100svh - 3.5rem)' }}
    >
      {/* Slim header — pinned; only the stage scrolls */}
      <div className="shrink-0 border-b border-border-muted px-4 py-2 space-y-2">
        <div className="flex items-center gap-3 min-w-0">
          <BackLink iconOnly />
          <span className="truncate text-sm font-medium text-text">{run.metadata.name}</span>
          <StatusBadge phase={phase} />
          <LiveDot active={isActive} connected={sseConnected} />
          {isFetching && <span className="text-xs text-text-dim animate-pulse">refreshing</span>}

          <div className="ml-auto flex items-center gap-1.5">
            <TokenCounter tokensIn={run.status?.tokensIn} tokensOut={run.status?.tokensOut} />
            <Link
              to={`/runs/new?copyFrom=${encodeURIComponent(name ?? '')}`}
              aria-label="Copy run"
              title="Copy run"
            >
              <Button variant="ghost" size="icon" aria-label="Copy run" title="Copy run">
                <ClipboardCopy />
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              title="Refresh"
              onClick={refresh}
            >
              <RefreshCw />
            </Button>
            {!confirmDelete ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={isActive ? 'Cancel run' : 'Delete run'}
                title={isActive ? 'Cancel run' : 'Delete run'}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="text-phase-failed" />
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Sure?</span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Confirm'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Summary strip — replaces the bare status.message subtitle with the
            deterministic derived summary (purpose, mode, latest activity + age). */}
        <SummaryStrip summary={summary} relatedTask={run.relatedTask} project={run.spec.project} />

        {/* Failed-run banner — prominent, kept alongside the summary strip */}
        {isFailed && run.status?.message && (
          <div className="rounded border border-phase-failed/40 bg-phase-failed/10 px-3 py-2 flex items-start gap-2">
            <span className="text-phase-failed text-sm leading-none mt-0.5">✕</span>
            <div>
              <p className="text-xs font-medium text-phase-failed">Run failed</p>
              <p className="text-xs text-phase-failed/80 mt-0.5 font-mono">{run.status.message}</p>
            </div>
          </div>
        )}

        {deleteMutation.error && (
          <div className="rounded border border-phase-failed/30 bg-phase-failed/10 px-3 py-2 text-xs text-phase-failed">
            Delete failed: {deleteMutation.error.message}
          </div>
        )}
      </div>

      {/* STAGE — the single panel; only it scrolls, the page never does */}
      <div className="flex flex-1 min-h-0 flex-col">
        {activeView === 'conversation' && (
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <TerminalTranscript
              name={name}
              hasSession={hasSession}
              active={isActive}
              sseConnected={sseConnected}
              eventTick={eventTick}
              localEntries={localEntries}
            />
          </div>
        )}

        {activeView === 'logs' && (
          <div className="flex flex-1 min-h-0 flex-col p-6">
            <LogViewer
              name={name}
              active={isActive}
              defaultContainer={effectiveLogContainer}
              sseConnected={sseConnected}
              eventTick={eventTick}
              fillHeight
            />
          </div>
        )}

        {activeView === 'status' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            <RunOverview run={run} phase={phase} summary={summary} />
          </div>
        )}

        {/* Interactive terminal — attaches to the runner's TUI inside the pod.
            Only the opencode engine has one: attach execs `opencode attach`, and
            the claude engine's runner is a headless HTTP server with no TUI to
            connect to, so the terminal would retry and flicker forever. Explain
            the absence rather than silently dropping the section. */}
        {activeView === 'shell' && (
          <div className="flex flex-1 min-h-0 flex-col p-6">
            {run.spec.engine === 'claude' ? (
              <p className="text-sm text-text-dim">
                Interactive attach is not available for the{' '}
                <code className="font-mono text-xs">claude</code> engine — its runner is a headless
                server with no terminal session. Use the conversation and log views instead.
              </p>
            ) : (
              <TerminalTab runName={name} active={isActive} fillHeight />
            )}
          </div>
        )}
      </div>

      {/* COMMAND BAR — the persistent prompt. Hidden in `shell`: the raw PTY
          owns stdin there, so slash commands cannot be intercepted. */}
      {activeView === 'shell' ? (
        <AttachedBar
          runName={name}
          tty={run.spec.engine !== 'claude'}
          onConversation={() => setView('conversation')}
        />
      ) : (
        <RunCommandBar
          run={run}
          view={activeView}
          setView={setView}
          setLogContainer={setLogContainer}
          appendEntry={appendEntry}
          clearEntries={clearEntries}
          invalidate={invalidate}
          navigate={(to) => navigate(to)}
          confirmCancel={() => deleteMutation.mutate()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell-view bar
//
// Once attached the browser forwards every keystroke to the pod's PTY, so the
// slash-command prompt is hidden. The remaining affordances are a way back to
// the conversation and a Stop that still interrupts the agent's turn. The
// claude engine has no PTY at all — the stage shows an explainer, so the hint
// drops the "keystrokes go to the pod" claim.
function AttachedBar({
  runName,
  tty,
  onConversation,
}: {
  runName: string;
  tty: boolean;
  onConversation: () => void;
}) {
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: () => interruptRun(runName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session', runName] }),
  });

  return (
    <div className="shrink-0 border-t border-border bg-surface px-4 py-2 space-y-2 font-mono">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <span className="text-xs text-text-dim">
          {tty
            ? '⌨ attached — keystrokes go to the pod. Slash commands are unavailable here.'
            : 'No interactive TTY for the claude engine.'}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onConversation}>
            /conversation
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            title="Stop the agent's current turn; the session stays open"
          >
            {stop.isPending ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      </div>
      {stop.error && (
        <p className="text-xs text-phase-failed" role="alert">
          {stop.error.message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function LiveDot({ active, connected }: { active: boolean; connected: boolean }) {
  const state = !active ? 'idle' : connected ? 'live' : 'polling';
  const color = !active
    ? 'bg-text-dim'
    : connected
      ? 'bg-phase-succeeded'
      : 'bg-phase-pending animate-pulse';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-dim">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {state}
    </span>
  );
}

function RunOverview({
  run,
  phase,
  summary,
}: {
  run: RunDetailData;
  phase?: string;
  summary: RunSummary;
}) {
  return (
    <div className="space-y-6">
      {/* Summary — purpose, linked task, mode and latest activity. */}
      <RunSummaryCard summary={summary} relatedTask={run.relatedTask} project={run.spec.project} />

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status card */}
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
              Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Field label="Phase" value={phase ?? 'Unknown'} />
            <Field label="Session ID" value={run.status?.sessionID} mono />
            <Field label="Pod" value={run.status?.podName} mono />
            <Field label="Service" value={run.status?.serviceName} mono />
            <Field label="Created" value={formatTime(run.metadata.creationTimestamp)} />
            <Field label="Started" value={formatTime(run.status?.startedAt)} />
            <Field label="Completed" value={formatTime(run.status?.completedAt)} />
            <Field
              label="Duration"
              value={duration(run.status?.startedAt, run.status?.completedAt)}
            />
            <Field label="Last Event" value={formatTime(run.status?.lastEventAt)} />
          </CardContent>
        </Card>

        {/* Spec card */}
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
              Spec
            </CardTitle>
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
            <Field label="Timeout" value={`${run.spec.timeoutSeconds}s`} />
            <Field label="TTL After Finished" value={`${run.spec.ttlSecondsAfterFinished}s`} />
            {run.spec.source?.git && (
              <>
                <Field label="Git URL" value={run.spec.source.git.url} mono />
                <Field label="Git Ref" value={run.spec.source.git.ref} mono />
                {run.spec.source.git.author && (
                  <Field
                    label="Git Author"
                    value={`${run.spec.source.git.author.name} <${run.spec.source.git.author.email}>`}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Task */}
      {run.spec.task && (
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
              Task
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">{run.spec.task}</p>
          </CardContent>
        </Card>
      )}

      {/* Conditions */}
      {run.status?.conditions && run.status.conditions.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border-muted">
            <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
              Conditions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="table-scroll">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border-muted">
                    <th className="pb-2 pr-4 font-medium">Type</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Reason</th>
                    <th className="pb-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-muted">
                  {run.status.conditions.map((c) => (
                    <tr key={c.type}>
                      <td className="py-2 pr-4 text-text">{c.type}</td>
                      <td className="py-2 pr-4">
                        <span
                          className={
                            c.status === 'True'
                              ? 'text-phase-succeeded'
                              : c.status === 'False'
                                ? 'text-phase-failed'
                                : 'text-phase-pending'
                          }
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-text-muted font-mono text-xs">
                        {c.reason ?? '-'}
                      </td>
                      <td className="py-2 text-text-muted text-xs">{c.message ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Review verdict */}
      {reviewVerdict(run) && (
        <ReviewVerdictCard
          verdict={reviewVerdict(run) as NonNullable<ReturnType<typeof reviewVerdict>>}
        />
      )}
    </div>
  );
}

const NO_SUMMARY_TEXT = 'No summary available — this run has no linked task or prompt.';
const NO_SUMMARY_TITLE =
  'This run has no linked task and no prompt, so there is nothing to summarize.';

/**
 * Header summary strip: purpose (task board link when resolved) + mode badge +
 * latest deterministic activity with its "as of" age. Falls back to the explicit
 * muted no-summary state instead of a blank line.
 */
function SummaryStrip({
  summary,
  relatedTask,
  project,
}: {
  summary: RunSummary;
  relatedTask?: RelatedTask;
  project?: string;
}) {
  if (!summary.hasSummary) {
    return (
      <p className="truncate text-xs text-text-dim italic" title={NO_SUMMARY_TITLE}>
        {NO_SUMMARY_TEXT}
      </p>
    );
  }

  const boardLink = boardTaskLink(project, relatedTask);
  const age = relativeAge(summary.activityAt);
  const purposeClass = 'truncate text-text';

  return (
    <div className="flex items-center gap-2 min-w-0 text-xs">
      {boardLink ? (
        <Link
          to={boardLink}
          className={`${purposeClass} hover:text-white underline-offset-2 hover:underline`}
          title={summary.purpose ?? undefined}
        >
          {summary.purpose}
        </Link>
      ) : (
        <span className={purposeClass} title={summary.purpose ?? undefined}>
          {summary.purpose}
        </span>
      )}
      <ModeBadge interactive={summary.mode === 'interactive'} className="shrink-0" />
      <span
        className={`truncate ${summary.activityIsStale ? 'text-text-dim' : 'text-text-muted'}`}
        title={summary.activity}
      >
        {summary.activity}
      </span>
      {age && <span className="shrink-0 text-text-dim">· {age}</span>}
    </div>
  );
}

/**
 * Status-view Summary card. Shows purpose, the linked task (type/title via the
 * purpose, plus name and phase) with a board link, mode and latest activity.
 * Renders the explicit muted no-summary state when there is no purpose source.
 */
function RunSummaryCard({
  summary,
  relatedTask,
  project,
}: {
  summary: RunSummary;
  relatedTask?: RelatedTask;
  project?: string;
}) {
  const boardLink = boardTaskLink(project, relatedTask);
  const age = relativeAge(summary.activityAt);
  const activityWithAge = age ? `${summary.activity} · ${age}` : summary.activity;

  return (
    <Card>
      <CardHeader className="border-b border-border-muted">
        <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
          Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {summary.hasSummary ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {boardLink ? (
                <Link
                  to={boardLink}
                  className="text-sm text-text hover:text-white underline-offset-2 hover:underline"
                  title={summary.purpose ?? undefined}
                >
                  {summary.purpose}
                </Link>
              ) : (
                <span className="text-sm text-text">{summary.purpose}</span>
              )}
              <ModeBadge interactive={summary.mode === 'interactive'} />
            </div>
            <Field label="Latest activity" value={activityWithAge} title={summary.activity} />
            {relatedTask && (
              <>
                <Field label="Task" value={relatedTask.name} mono />
                <Field label="Task phase" value={relatedTask.phase ?? '-'} />
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-text-dim italic" title={NO_SUMMARY_TITLE}>
            {NO_SUMMARY_TEXT}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BackLink({ iconOnly = false }: { iconOnly?: boolean }) {
  if (iconOnly) {
    return (
      <Link
        to="/runs"
        aria-label="All runs"
        title="All runs"
        className="text-text-dim hover:text-text transition-colors"
      >
        <ArrowLeft size={16} />
      </Link>
    );
  }
  return (
    <Link
      to="/runs"
      className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
    >
      <span>&larr;</span> All runs
    </Link>
  );
}

function Field({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-text-dim w-36 shrink-0">{label}</span>
      <span className={`text-text ${mono ? 'font-mono text-xs' : ''} break-all`} title={title}>
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
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <div key={k} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <div key={k} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

type ReviewVerdictData = {
  action: string;
  diagnosis?: string;
  feedback?: string;
  suggestion?: string;
};

function reviewVerdict(run: {
  metadata: { annotations?: Record<string, string> };
}): ReviewVerdictData | undefined {
  const raw = run.metadata.annotations?.['percussionist.dev/review-verdict'];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ReviewVerdictData;
  } catch {
    return undefined;
  }
}

function ReviewVerdictCard({ verdict }: { verdict: ReviewVerdictData }) {
  const isApproved = verdict.action === 'approve';
  return (
    <Card>
      <CardHeader className="border-b border-border-muted">
        <CardTitle className="font-mono text-xs font-medium uppercase tracking-wide text-text-muted">
          Review Verdict
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            isApproved
              ? 'bg-phase-succeeded/10 text-phase-succeeded'
              : 'bg-phase-failed/10 text-phase-failed'
          }`}
        >
          <span>{isApproved ? '✓' : '✕'}</span>
          <span>{isApproved ? 'Approved' : 'Changes Requested'}</span>
        </div>

        {verdict.diagnosis && (
          <div>
            <p className="text-label-md font-mono uppercase text-text-dim mb-1">Diagnosis</p>
            <p className="text-sm whitespace-pre-wrap text-text leading-relaxed">
              {verdict.diagnosis}
            </p>
          </div>
        )}

        {verdict.feedback && (
          <div>
            <p className="text-label-md font-mono uppercase text-text-dim mb-1">Feedback</p>
            <p className="text-sm whitespace-pre-wrap text-text-muted leading-relaxed">
              {verdict.feedback}
            </p>
          </div>
        )}

        {verdict.suggestion && (
          <div>
            <p className="text-label-md font-mono uppercase text-text-dim mb-1">Suggestion</p>
            <p className="text-sm whitespace-pre-wrap text-text-muted leading-relaxed">
              {verdict.suggestion}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
