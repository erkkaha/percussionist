// NotificationBell — top-bar bell icon with unread badge and history dropdown.
//
// - Badge shows max(unread events, server-backed attention count); pulses amber
//   on a new notification.
// - Dropdown opens on click, closes on Escape or click-outside.
// - Unread count resets to 0 as soon as the panel opens (auto-read).
// - The "Needs attention" row reads the server-authoritative attention inbox
//   (useAttention), so a push that fired while no tab was open is represented
//   even though the ephemeral history below is page-load scoped.
// - History is in-memory per page load (up to 50 entries, newest first).

import { AlertCircle, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAttention } from '../hooks/useAttention';
import { useNotificationHistory } from '../hooks/useNotificationHistory';
import type { DrumSound, NotificationEntry } from '../lib/notifications';

// ---------------------------------------------------------------------------
// Helpers

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DOT_COLOR: Record<DrumSound, string> = {
  success: 'bg-phase-succeeded',
  failure: 'bg-phase-failed',
  cancelled: 'bg-phase-cancelled',
  escalated: 'bg-phase-running',
  running: 'bg-phase-initializing',
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

function NotificationItem({ entry, onClick }: { entry: NotificationEntry; onClick?: () => void }) {
  const [, forceUpdate] = useState(0);

  // Re-render every 30 s so relative timestamps stay fresh while panel is open.
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const rowClass =
    'flex items-start gap-2.5 px-3 py-2.5 border-b border-border-muted last:border-0 hover:bg-surface-overlay transition-colors';

  const rowContent = (
    <>
      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${DOT_COLOR[entry.sound]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text leading-tight">{entry.title}</p>
        {entry.body && <p className="text-xs text-text-dim mt-0.5 truncate">{entry.body}</p>}
      </div>
      <span className="text-xs text-text-dim shrink-0 mt-0.5">{formatRelative(entry.at)}</span>
    </>
  );

  // Entries with a destination URL render as links (navigate + close the
  // panel); entries without one stay as plain, non-clickable rows.
  if (entry.url) {
    return (
      <Link to={entry.url} onClick={onClick} className={`group ${rowClass}`}>
        {rowContent}
        <ChevronRight
          className="w-3.5 h-3.5 shrink-0 mt-0.5 text-text-dim group-hover:text-text transition-colors"
          aria-hidden="true"
        />
      </Link>
    );
  }

  return <div className={rowClass}>{rowContent}</div>;
}

// ---------------------------------------------------------------------------
// Main component

export default function NotificationBell() {
  const { entries, unreadCount, markAllRead, clearAll } = useNotificationHistory();
  // Server-authoritative HITL count — polls and refetches on window focus so a
  // gate reached while the tab was closed still shows up here.
  const { data: attention } = useAttention();
  const attentionCount = attention?.count ?? 0;
  // The two sources are different concepts (persistent gates vs. ephemeral
  // events), so the badge takes the larger rather than summing them to avoid
  // double-counting a gate that also produced an in-session event.
  const badgeCount = Math.max(unreadCount, attentionCount);
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
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Bell button */}
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Notifications"
        aria-expanded={open}
        className={`relative flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
          open
            ? 'bg-surface-overlay text-text'
            : 'text-text-dim hover:bg-surface-overlay hover:text-text-muted'
        }`}
      >
        <BellIcon className="w-4 h-4" />

        {/* Unread / attention badge */}
        {badgeCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-surface text-caption-xs font-bold leading-none animate-pulse"
          >
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] w-80 rounded-md border border-border bg-surface shadow-lg z-50 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-caption-xs font-semibold text-text-muted uppercase tracking-wider">
              Notifications
            </span>
            {entries.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  clearAll();
                  setOpen(false);
                }}
                className="text-xs text-text-dim hover:text-text-muted transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          {/* Persistent, server-backed attention inbox. Kept separate from the
              ephemeral event list below and labelled distinctly so the two
              counts are not mistaken for one another. */}
          <Link
            to="/attention"
            onClick={() => setOpen(false)}
            className="group flex items-center gap-2.5 px-3 py-2.5 border-b border-border hover:bg-surface-overlay transition-colors"
          >
            <AlertCircle
              aria-hidden="true"
              className={`w-4 h-4 shrink-0 ${attentionCount > 0 ? 'text-accent' : 'text-text-dim'}`}
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-text leading-tight">
                Needs attention{attentionCount > 0 ? ` (${attentionCount})` : ''}
              </p>
              <p className="text-xs text-text-dim mt-0.5 truncate">
                {attentionCount > 0 ? 'Tasks waiting on your decision' : 'Nothing waiting on you'}
              </p>
            </div>
            {attentionCount > 0 && (
              <span className="shrink-0 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-surface text-caption-xs font-bold leading-none">
                {attentionCount > 99 ? '99+' : attentionCount}
              </span>
            )}
            <ChevronRight
              className="w-3.5 h-3.5 shrink-0 text-text-dim group-hover:text-text transition-colors"
              aria-hidden="true"
            />
          </Link>

          {/* Ephemeral history (page-load scoped) */}
          <div className="overflow-y-auto max-h-96">
            {entries.length === 0 ? (
              <p className="text-xs text-text-dim text-center py-6">No notifications yet</p>
            ) : (
              <>
                <p className="text-caption-xs font-semibold text-text-dim uppercase tracking-wider px-3 pt-2 pb-1">
                  Recent
                </p>
                {entries.map((entry) => (
                  <NotificationItem
                    key={entry.key}
                    entry={entry}
                    onClick={() => {
                      setOpen(false);
                      markAllRead();
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
