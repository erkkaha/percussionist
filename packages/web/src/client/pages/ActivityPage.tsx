import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { Activity, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types

interface TaskEvent {
  id: number;
  project: string;
  taskName: string;
  taskType: string;
  eventType: string;
  payload: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Event display config

const EVENT_CONFIG: Record<string, { label: string; color: string }> = {
  "run.created":        { label: "Run started",        color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  "run.succeeded":      { label: "Run succeeded",      color: "bg-green-500/15 text-green-400 border-green-500/30" },
  "run.failed":         { label: "Run failed",         color: "bg-red-500/15 text-red-400 border-red-500/30" },
  "column.changed":     { label: "Moved",              color: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
  "facilitator.spawned":{ label: "Facilitator",        color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  "reviewer.spawned":   { label: "Reviewer",           color: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
  "merged":             { label: "Merged",             color: "bg-green-500/15 text-green-400 border-green-500/30" },
  "escalated":          { label: "Escalated",          color: "bg-red-500/15 text-red-400 border-red-500/30" },
  "blocked":            { label: "Blocked",            color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  "decision":           { label: "Decision",           color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  "approved":           { label: "Approved",           color: "bg-green-500/15 text-green-400 border-green-500/30" },
  "request-changes":    { label: "Changes requested",  color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
};

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType] ?? { label: eventType, color: "bg-slate-500/15 text-slate-400 border-slate-500/30" };
}

// ---------------------------------------------------------------------------
// Human-readable description

function describeEvent(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "run.created": {
      const parts = [`Run ${String(payload.runName ?? "").split("-").slice(-1)[0] ?? "created"}`];
      if (payload.agent) parts.push(`via ${String(payload.agent)}`);
      if (payload.retryCount) parts.push(`(retry ${String(payload.retryCount)})`);
      if (payload.reason) parts.push(`— ${String(payload.reason)}`);
      return parts.join(" ");
    }
    case "run.succeeded":
      return `Run completed successfully`;
    case "run.failed": {
      const parts = ["Run failed"];
      if (payload.retryCount) parts.push(`— retrying (${String(payload.retryCount)})`);
      else if (payload.reason) parts.push(`— ${String(payload.reason)}`);
      else if (payload.error) parts.push(`— ${String(payload.error).slice(0, 80)}`);
      return parts.join(" ");
    }
    case "column.changed": {
      const from = payload.from ? String(payload.from) : null;
      const to = payload.to ? String(payload.to) : null;
      const reason = payload.reason ? String(payload.reason).replace(/-/g, " ") : null;
      const parts = from && to ? [`${from} → ${to}`] : [];
      if (reason) parts.push(`(${reason})`);
      return parts.join(" ") || "Column changed";
    }
    case "facilitator.spawned": {
      const agent = payload.agent ? String(payload.agent) : "facilitator";
      return `Spawned ${agent}${payload.reason ? ` for ${String(payload.reason).replace(/-/g, " ")}` : ""}`;
    }
    case "reviewer.spawned": {
      const agent = payload.agent ? String(payload.agent) : "reviewer";
      return `Spawned ${agent}`;
    }
    case "merged": {
      if (payload.buildTaskCount) return `Generated ${String(payload.buildTaskCount)} BUILD tasks`;
      return "Merged";
    }
    case "escalated":
      return payload.reason ? `Escalated — ${String(payload.reason).slice(0, 100)}` : "Escalated";
    case "decision": {
      const action = payload.action ? String(payload.action).replace(/_/g, " ") : "decided";
      const parts = [action];
      if (payload.agent) parts.push(`→ ${String(payload.agent)}`);
      if (payload.reason) parts.push(`(${String(payload.reason).slice(0, 80)})`);
      return parts.join(" ");
    }
    case "approved":
      return "Human approved";
    case "request-changes":
      return payload.feedback
        ? `Changes requested — ${String(payload.feedback).slice(0, 80)}`
        : "Changes requested";
    default:
      return Object.keys(payload).length > 0
        ? Object.entries(payload).slice(0, 2).map(([k, v]) => `${k}: ${String(v)}`).join(", ")
        : "";
  }
}

// ---------------------------------------------------------------------------
// Time formatting

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtDateGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Group events by date

function groupByDate(events: TaskEvent[]): Array<{ label: string; events: TaskEvent[] }> {
  const groups: Map<string, TaskEvent[]> = new Map();
  for (const e of events) {
    const label = fmtDateGroup(e.createdAt);
    const arr = groups.get(label) ?? [];
    arr.push(e);
    groups.set(label, arr);
  }
  return Array.from(groups.entries()).map(([label, evts]) => ({ label, events: evts }));
}

// ---------------------------------------------------------------------------
// Single event row

function EventRow({ event }: { event: TaskEvent }) {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(event.payload); } catch { /* ignore */ }

  const cfg = getEventConfig(event.eventType);
  const description = describeEvent(event.eventType, payload);
  const boardUrl = `/projects/${encodeURIComponent(event.project)}/board`;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-0 hover:bg-surface-raised/40 px-6 transition-colors">
      {/* Time */}
      <span className="font-mono text-[11px] text-text-muted w-[72px] shrink-0 pt-0.5">
        {fmtTime(event.createdAt)}
      </span>

      {/* Project badge */}
      <Link
        to={boardUrl}
        className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-surface-raised border-border text-text-muted hover:text-text shrink-0 truncate max-w-[100px]"
        title={event.project}
      >
        {event.project}
      </Link>

      {/* Task name */}
      <Link
        to={boardUrl}
        className="font-mono text-[11px] text-text-muted hover:text-text shrink-0 truncate max-w-[140px]"
        title={event.taskName}
      >
        {event.taskName.split("-").slice(-3).join("-")}
      </Link>

      {/* Event badge */}
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${cfg.color}`}>
        {cfg.label}
      </span>

      {/* Description */}
      {description && (
        <span className="text-[11px] text-text-muted truncate flex-1" title={description}>
          {description}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityPage

export default function ActivityPage() {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oldestId, setOldestId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const LIMIT = 200;

  const fetchActivity = useCallback(async (replace: boolean, before?: number) => {
    try {
      const url = before
        ? `/api/activity?limit=${LIMIT}&before=${before}`
        : `/api/activity?limit=${LIMIT}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: TaskEvent[]; count: number };
      setEvents((prev) => {
        if (replace) return data.events;
        // Merge: prepend new events by id, deduplicate
        const existingIds = new Set(prev.map((e) => e.id));
        const fresh = data.events.filter((e) => !existingIds.has(e.id));
        return [...fresh, ...prev];
      });
      setHasMore(data.count >= LIMIT);
      if (data.events.length > 0) {
        const minId = Math.min(...data.events.map((e) => e.id));
        if (before) setOldestId(minId);
        else if (replace) setOldestId(minId);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchActivity(true);
  }, [fetchActivity]);

  // Poll for new events every 5s
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      void fetchActivity(false);
    }, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchActivity]);

  const loadMore = () => {
    if (oldestId !== null) void fetchActivity(false, oldestId);
  };

  const grouped = groupByDate(events);

  return (
    // Pull out of the parent p-6 padding so the activity feed fills the viewport height correctly.
    <div className="-m-6 flex flex-col" style={{ height: "calc(100svh - 3.5rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-text-muted" />
          <h1 className="text-sm font-semibold text-text">Activity</h1>
          {events.length > 0 && (
            <span className="text-[11px] text-text-muted">
              {events.length} event{events.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => { setLoading(true); void fetchActivity(true); }}
          className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading && events.length === 0 && (
          <div className="flex items-center justify-center h-32 text-text-muted text-sm">
            Loading…
          </div>
        )}

        {error && (
          <div className="px-6 py-4 text-sm text-red-400">
            Error: {error}
          </div>
        )}

        {!loading && events.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-text-muted">
            <Activity className="w-8 h-8 opacity-30" />
            <p className="text-sm">No activity yet</p>
            <p className="text-[11px]">Events appear here as the manager orchestrates tasks.</p>
          </div>
        )}

        {grouped.map(({ label, events: grpEvents }) => (
          <div key={label}>
            {/* Date separator */}
            <div className="sticky top-0 z-10 px-6 py-1.5 bg-surface border-b border-border/50 flex items-center gap-2">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{label}</span>
            </div>
            {grpEvents.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </div>
        ))}

        {hasMore && (
          <div className="flex justify-center py-4">
            <button
              onClick={loadMore}
              className="text-[11px] text-text-muted hover:text-text border border-border rounded px-3 py-1.5 transition-colors"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
