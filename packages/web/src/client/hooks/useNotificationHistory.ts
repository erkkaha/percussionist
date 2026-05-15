// useNotificationHistory — subscribes to the module-level notification history
// store and exposes the entry list plus an unread count.
//
// Unread count resets to 0 when markAllRead() is called (auto-read on open).

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getNotificationHistory,
  NOTIFICATION_EVENT,
  type NotificationEntry,
} from "../lib/notifications";

export function useNotificationHistory(): {
  entries: NotificationEntry[];
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
} {
  const [entries, setEntries] = useState<NotificationEntry[]>(() =>
    getNotificationHistory(),
  );

  // Timestamp of the last time the panel was opened / marked read.
  const lastReadAt = useRef<number>(Date.now());
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    function onNotification(e: Event) {
      const entry = (e as CustomEvent<NotificationEntry>).detail;
      setEntries((prev) => {
        // Guard against duplicates (shouldn't happen but be safe).
        if (prev.some((x) => x.key === entry.key)) return prev;
        return [entry, ...prev].slice(0, 50);
      });
      setUnreadCount((c) => c + 1);
    }

    window.addEventListener(NOTIFICATION_EVENT, onNotification);
    return () => window.removeEventListener(NOTIFICATION_EVENT, onNotification);
  }, []);

  const markAllRead = useCallback(() => {
    lastReadAt.current = Date.now();
    setUnreadCount(0);
  }, []);

  const clearAll = useCallback(() => {
    // Also clear the module-level history so new mounts start fresh.
    getNotificationHistory().splice(0);
    setEntries([]);
    setUnreadCount(0);
  }, []);

  return { entries, unreadCount, markAllRead, clearAll };
}
