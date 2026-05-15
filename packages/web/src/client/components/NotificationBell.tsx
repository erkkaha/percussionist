// NotificationBell — top-bar bell icon with unread badge and history dropdown.
//
// - Badge shows unread count; pulses amber on new notification.
// - Dropdown opens on click, closes on Escape or click-outside.
// - Unread count resets to 0 as soon as the panel opens (auto-read).
// - History is in-memory per page load (up to 50 entries, newest first).

import { useRef, useState, useEffect, useCallback } from "react";
import { useNotificationHistory } from "../hooks/useNotificationHistory";
import type { DrumSound, NotificationEntry } from "../lib/notifications";

// ---------------------------------------------------------------------------
// Helpers

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DOT_COLOR: Record<DrumSound, string> = {
  success:   "bg-phase-succeeded",
  failure:   "bg-phase-failed",
  cancelled: "bg-phase-cancelled",
  escalated: "bg-phase-running",
  running:   "bg-phase-initializing",
};

// ---------------------------------------------------------------------------
// Sub-components

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function NotificationItem({ entry }: { entry: NotificationEntry }) {
  const [, forceUpdate] = useState(0);

  // Re-render every 30 s so relative timestamps stay fresh while panel is open.
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 border-b border-border-muted last:border-0 hover:bg-surface-overlay transition-colors">
      <span
        className={`mt-1 w-2 h-2 rounded-full shrink-0 ${DOT_COLOR[entry.sound]}`}
      />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text leading-tight">{entry.title}</p>
        {entry.body && (
          <p className="text-xs text-text-dim mt-0.5 truncate">{entry.body}</p>
        )}
      </div>
      <span className="text-xs text-text-dim shrink-0 mt-0.5">
        {formatRelative(entry.at)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component

export default function NotificationBell() {
  const { entries, unreadCount, markAllRead, clearAll } = useNotificationHistory();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-read when panel opens.
  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      if (!v) markAllRead();
      return !v;
    });
  }, [markAllRead]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Bell button */}
      <button
        onClick={toggleOpen}
        aria-label="Notifications"
        aria-expanded={open}
        className={`relative flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
          open
            ? "bg-surface-overlay text-text"
            : "text-text-dim hover:bg-surface-overlay hover:text-text-muted"
        }`}
      >
        <BellIcon className="w-4 h-4" />

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-surface text-[9px] font-bold leading-none animate-pulse">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] w-80 rounded-md border border-border bg-surface shadow-lg z-50 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Notifications
            </span>
            {entries.length > 0 && (
              <button
                onClick={() => { clearAll(); setOpen(false); }}
                className="text-xs text-text-dim hover:text-text-muted transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          {/* List */}
          <div className="overflow-y-auto max-h-96">
            {entries.length === 0 ? (
              <p className="text-xs text-text-dim text-center py-6">
                No notifications yet
              </p>
            ) : (
              entries.map((entry) => (
                <NotificationItem key={entry.key} entry={entry} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
