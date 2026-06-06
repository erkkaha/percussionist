import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRun } from "../hooks/useRun";
import { useRunEvents } from "../hooks/useRunEvents";
import { deleteRun } from "../lib/api";
import StatusBadge from "./StatusBadge";
import TokenCounter from "./TokenCounter";
import LogViewer from "./LogViewer";
import SessionView from "./SessionView";
import { TERMINAL_PHASES } from "../lib/types";
import OpenOpencodeButton from "./OpenOpencodeButton";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Button } from "./ui/button";

const WORKSPACE_INIT_CONTAINER = "workspace-init";
const DEFAULT_NAMESPACE = "percussionist";

function attachCommand(name: string, namespace: string | undefined): string {
  const ns = namespace ?? DEFAULT_NAMESPACE;
  return ns === DEFAULT_NAMESPACE
    ? `beatctl attach ${name}`
    : `beatctl attach ${name} -n ${ns}`;
}

function AttachButton({ name, namespace }: { name: string; namespace?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const cmd = attachCommand(name, namespace);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      title={`Copy: ${attachCommand(name, namespace)}`}
      className={`${
        copied
          ? "border-phase-succeeded/40 text-phase-succeeded bg-phase-succeeded/10"
          : "border-border-muted text-text-muted hover:border-border hover:text-text"
      }`}
    >
      {copied ? "Copied!" : "Attach"}
    </Button>
  );
}

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: run, error, isLoading, isFetching } = useRun(name!);
  const runPhase = run?.status?.phase;
  const runIsActive = !!run && (!runPhase || !TERMINAL_PHASES.has(runPhase));
  const { connected: sseConnected, eventTick } = useRunEvents(name ?? "", runIsActive);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(name!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate("/runs");
    },
  });

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
  const isFailed = phase === "Failed";

  // When the run failed on an init container (workspace-init), default the log
  // viewer to that container so the error is immediately visible.
  const failedOnInit =
    isFailed &&
    run.status?.message?.startsWith("init container");
  const defaultLogContainer = failedOnInit ? WORKSPACE_INIT_CONTAINER : "bootstrap";

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
          {/* Show message as muted subtitle only when not failed — failed gets a banner below */}
          {run.status?.message && !isFailed && (
            <p className="text-sm text-text-muted">{run.status.message}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <TokenCounter
            tokensIn={run.status?.tokensIn}
            tokensOut={run.status?.tokensOut}
          />
          {isActive && (
              <AttachButton name={name!} namespace={run.metadata.namespace} />
            )}
          {run && <OpenOpencodeButton run={run} />}
          <Link to={`/runs/new?copyFrom=${encodeURIComponent(name!)}`}>
            <Button variant="outline" size="sm">Copy</Button>
          </Link>
          {/* Cancel / Delete button */}
          {!confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              {isActive ? "Cancel Run" : "Delete Run"}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">Sure?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Confirm"}
              </Button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-sm text-text-muted hover:text-text transition-colors"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error banner — shown prominently when the run has failed */}
      {isFailed && run.status?.message && (
        <div className="rounded-lg border border-phase-failed/40 bg-phase-failed/10 px-4 py-3 flex items-start gap-3">
          <span className="text-phase-failed text-base leading-none mt-0.5">✕</span>
          <div>
            <p className="text-sm font-medium text-phase-failed">Run failed</p>
            <p className="text-sm text-phase-failed/80 mt-0.5 font-mono">{run.status.message}</p>
          </div>
        </div>
      )}

      {deleteMutation.error && (
        <div className="rounded-md border border-phase-failed/30 bg-phase-failed/10 px-4 py-3 text-sm text-phase-failed">
          Delete failed: {deleteMutation.error.message}
        </div>
      )}

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status card */}
        <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Status</CardTitle></CardHeader><CardContent className="space-y-2">
          <Field label="Phase" value={phase ?? "Unknown"} />
          <Field label="Session ID" value={run.status?.sessionID} mono />
          <Field label="Pod" value={run.status?.podName} mono />
          <Field label="Service" value={run.status?.serviceName} mono />
          {run.status?.webURL && (
            <div className="flex items-baseline gap-3 text-sm">
              <span className="text-text-dim w-36 shrink-0">Web UI</span>
              <a
                href={run.status.webURL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text font-mono text-xs break-all hover:underline"
              >
                {run.status.webURL}
              </a>
            </div>
          )}
          <Field label="Created" value={formatTime(run.metadata.creationTimestamp)} />
          <Field label="Started" value={formatTime(run.status?.startedAt)} />
          <Field label="Completed" value={formatTime(run.status?.completedAt)} />
          <Field
            label="Duration"
            value={duration(run.status?.startedAt, run.status?.completedAt)}
          />
          <Field label="Last Event" value={formatTime(run.status?.lastEventAt)} />
        </CardContent></Card>

        {/* Spec card */}
        <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Spec</CardTitle></CardHeader><CardContent className="space-y-2">
          <Field label="Image" value={run.spec.image} mono />
          <Field label="Agent" value={run.spec.agent} />
          {run.spec.agents && run.spec.agents.length > 0 && (
            <div className="flex items-baseline gap-3 text-sm">
              <span className="text-text-dim w-36 shrink-0">Inline Agents</span>
              <div className="flex flex-wrap gap-1.5">
                {run.spec.agents.map((a, i) => (
                  <span key={i} className="inline-flex items-center rounded bg-surface-overlay px-2 py-0.5 text-xs font-mono text-text-muted">
                    {a.name}
                  </span>
                ))}
              </div>
            </div>
          )}
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
              {run.spec.source.git.author && (
                <Field
                  label="Git Author"
                  value={`${run.spec.source.git.author.name} <${run.spec.source.git.author.email}>`}
                />
              )}
            </>
          )}
        </CardContent></Card>
      </div>

      {/* Task */}
      {run.spec.task && (
        <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Task</CardTitle></CardHeader><CardContent>
          <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
            {run.spec.task}
          </p>
        </CardContent></Card>
      )}

      {/* Conditions */}
      {run.status?.conditions && run.status.conditions.length > 0 && (
        <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Conditions</CardTitle></CardHeader><CardContent>
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
        </CardContent></Card>
      )}

      {/* Session conversation */}
      <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Session</CardTitle></CardHeader><CardContent>
        <SessionView
          name={name!}
          hasSession={!!run.status?.sessionID}
          active={isActive}
          sseConnected={sseConnected}
          eventTick={eventTick}
        />
      </CardContent></Card>

      {/* Logs */}
      <Card><CardHeader className="border-b border-border-muted"><CardTitle className="text-sm font-medium text-text-muted">Logs</CardTitle></CardHeader><CardContent>
        <LogViewer
          name={name!}
          active={isActive}
          defaultContainer={defaultLogContainer}
          sseConnected={sseConnected}
          eventTick={eventTick}
        />
      </CardContent></Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function BackLink() {
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
