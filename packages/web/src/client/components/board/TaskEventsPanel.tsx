import { useTaskEvents } from "../../hooks/useTaskEvents";
import { Check, X, ArrowRight, RefreshCw, Play, Square, AlertTriangle, RotateCcw, MessageSquare, Trash2, GitBranch } from "lucide-react";

interface TaskEventsPanelProps {
  projectName: string;
  taskName: string;
}

const EVENT_ICONS: Record<string, typeof Check> = {
  approved: Check,
  "request-changes": X,
  moved: ArrowRight,
  "run.created": Play,
  "run.failed": X,
  "column.changed": ArrowRight,
  merged: GitBranch,
  escalated: AlertTriangle,
  blocked: AlertTriangle,
  abandoned: Trash2,
  answered: MessageSquare,
};

const EVENT_STYLES: Record<string, string> = {
  approved: "text-phase-succeeded border-phase-succeeded/30 bg-phase-succeeded/10",
  "request-changes": "text-phase-failed border-phase-failed/30 bg-phase-failed/10",
  "run.created": "text-accent border-accent/30 bg-accent/10",
  succeeded: "text-phase-succeeded border-phase-succeeded/30 bg-phase-succeeded/10",
  failed: "text-phase-failed border-phase-failed/30 bg-phase-failed/10",
  escalated: "text-phase-escalated border-phase-escalated/30 bg-phase-escalated/10",
  abandoned: "text-text-dim border-border bg-surface-overlay/30",
};

function eventColorClass(eventType: string): string {
  for (const [key, cls] of Object.entries(EVENT_STYLES)) {
    if (eventType.includes(key)) return cls;
  }
  return "text-text-dim border-border bg-surface-overlay/20";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString();
}

function formatEventLabel(eventType: string): string {
  return eventType
    .replace(/[.-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function PayloadBadge({ label, value }: { label: string; value: string | number | undefined | null }) {
  if (value == null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-label-md font-mono text-text-dim bg-surface-overlay/30 rounded px-1.5 py-0.5">
      <span className="text-text-dim/60">{label}:</span>
      <span>{String(value).length > 40 ? String(value).slice(0, 40) + "…" : String(value)}</span>
    </span>
  );
}

function EventPayload({ payload }: { payload: string }) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (Object.keys(parsed).length === 0) return null;

  const badges: React.ReactNode[] = [];
  if (parsed.fromPhase) badges.push(<PayloadBadge key="from" label="from" value={String(parsed.fromPhase)} />);
  if (parsed.toPhase) badges.push(<PayloadBadge key="to" label="to" value={String(parsed.toPhase)} />);
  if (parsed.column) badges.push(<PayloadBadge key="col" label="column" value={String(parsed.column)} />);
  if (parsed.message) badges.push(<PayloadBadge key="msg" label="message" value={String(parsed.message)} />);
  if (parsed.feedback) badges.push(<PayloadBadge key="fb" label="feedback" value={String(parsed.feedback)} />);
  if (parsed.answer) badges.push(<PayloadBadge key="ans" label="answer" value={String(parsed.answer)} />);
  if (parsed.agent) badges.push(<PayloadBadge key="agent" label="agent" value={String(parsed.agent)} />);

  if (badges.length === 0) return null;

  return <div className="flex flex-wrap gap-1.5 mt-1">{badges}</div>;
}

export default function TaskEventsPanel({ projectName, taskName }: TaskEventsPanelProps) {
  const { data: events, isLoading, error } = useTaskEvents(projectName, taskName);

  if (isLoading) {
    return <p className="text-xs text-text-dim p-4">Loading events…</p>;
  }

  if (error) {
    return (
      <p className="text-xs text-phase-failed p-4">
        Failed to load events: {error.message}
      </p>
    );
  }

  if (!events || events.length === 0) {
    return (
      <p className="text-xs text-text-dim p-4">
        No events recorded for this task yet.
      </p>
    );
  }

  return (
    <div className="p-4 space-y-1.5">
      {events.map((event) => {
        const Icon = EVENT_ICONS[event.eventType] ?? (event.eventType.includes("failed") ? X : event.eventType.includes("succeeded") || event.eventType.includes("approved") ? Check : ArrowRight);
        const colorClass = eventColorClass(event.eventType);

        return (
          <div
            key={event.id}
            className={`flex items-start gap-2.5 rounded-md border p-2.5 ${colorClass}`}
          >
            <div className="mt-0.5 shrink-0">
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-label-md font-mono uppercase">{formatEventLabel(event.eventType)}</span>
                <span className="text-label-md text-text-dim/60">{formatTime(event.createdAt)}</span>
              </div>
              <EventPayload payload={event.payload} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
