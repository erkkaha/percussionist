import { useParams, Link } from "react-router-dom";
import { useRun } from "../hooks/useRun";
import StatusBadge from "./StatusBadge";
import TokenCounter from "./TokenCounter";
import LogViewer from "./LogViewer";
import SessionView from "./SessionView";
import { TERMINAL_PHASES } from "../lib/types";

function formatTime(iso: string | undefined): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function duration(start: string | undefined, end: string | undefined): string {
  if (!start) return "-";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (Number.isNaN(ms) || ms < 0) return "-";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

export default function RunDetail() {
  const { name } = useParams<{ name: string }>();
  const { data: run, error, isLoading, isFetching } = useRun(name!);

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-6 text-phase-failed">
          <h2 className="text-lg font-semibold mb-1">Failed to load run</h2>
          <p className="text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !run) {
    return (
      <div className="space-y-4">
        <BackLink />
        <DetailSkeleton />
      </div>
    );
  }

  const phase = run.status?.phase;
  const isActive = !phase || !TERMINAL_PHASES.has(phase);

  return (
    <div className="space-y-6">
      {/* Navigation */}
      <BackLink />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold">{run.metadata.name}</h1>
            <StatusBadge phase={phase} />
            {isFetching && (
              <span className="text-xs text-text-dim animate-pulse">refreshing</span>
            )}
          </div>
          {run.status?.message && (
            <p className="text-sm text-text-muted">{run.status.message}</p>
          )}
        </div>
        <TokenCounter
          tokensIn={run.status?.tokensIn}
          tokensOut={run.status?.tokensOut}
        />
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status card */}
        <Card title="Status">
          <Field label="Phase" value={phase ?? "Unknown"} />
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
        </Card>

        {/* Spec card */}
        <Card title="Spec">
          <Field label="Image" value={run.spec.image} mono />
          <Field label="Agent" value={run.spec.agent} />
          <Field label="Model" value={run.spec.model} mono />
          <Field
            label="Interactive"
            value={run.spec.interactive ? "Yes" : "No"}
          />
          <Field label="Timeout" value={`${run.spec.timeoutSeconds}s`} />
          <Field
            label="TTL After Finished"
            value={`${run.spec.ttlSecondsAfterFinished}s`}
          />
          {run.spec.source?.git && (
            <>
              <Field label="Git URL" value={run.spec.source.git.url} mono />
              <Field label="Git Ref" value={run.spec.source.git.ref} mono />
            </>
          )}
        </Card>
      </div>

      {/* Task */}
      {run.spec.task && (
        <Card title="Task">
          <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
            {run.spec.task}
          </p>
        </Card>
      )}

      {/* Conditions */}
      {run.status?.conditions && run.status.conditions.length > 0 && (
        <Card title="Conditions">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-border-muted">
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Reason</th>
                  <th className="pb-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-muted">
                {run.status.conditions.map((c, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-4 text-text">{c.type}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          c.status === "True"
                            ? "text-phase-succeeded"
                            : c.status === "False"
                              ? "text-phase-failed"
                              : "text-phase-pending"
                        }
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-text-muted font-mono text-xs">
                      {c.reason ?? "-"}
                    </td>
                    <td className="py-2 text-text-muted text-xs">
                      {c.message ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Session conversation */}
      <Card title="Session">
        <SessionView
          name={name!}
          hasSession={!!run.status?.sessionID}
          active={isActive}
        />
      </Card>

      {/* Logs */}
      <Card title="Logs">
        <LogViewer name={name!} active={isActive} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors"
    >
      <span>&larr;</span> All runs
    </Link>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised">
      <div className="border-b border-border-muted px-4 py-2.5">
        <h2 className="text-sm font-medium text-text-muted">{title}</h2>
      </div>
      <div className="p-4 space-y-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-text-dim w-36 shrink-0">{label}</span>
      <span
        className={`text-text ${mono ? "font-mono text-xs" : ""} break-all`}
      >
        {value ?? "-"}
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
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 rounded bg-surface-overlay animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
