import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { isGloballyLocked, onGlobalLockChange, setGloballyLocked } from '../lib/usage-lock-state';
import {
  type Category,
  fetchUsageToday,
  getTodayKey,
  readTodayUsage,
  reportHeartbeat,
  STORAGE_PREFIX,
  setServerCache,
} from '../lib/usage-settings';

function categorizeRoute(path: string): Category {
  if (/^\/projects\/[^/]+\/board/.test(path)) return 'reviewing';
  if (/^\/sessions\/[^/]+$/.test(path)) return 'reviewing';
  if (/^\/projects\/[^/]+\/plans\//.test(path)) return 'planning';
  return 'other';
}

function cleanupOldKeys() {
  const todayKey = getTodayKey();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX) && key !== todayKey && !key.endsWith('-settings')) {
      localStorage.removeItem(key);
    }
  }
}

export function useUsageTracker() {
  const location = useLocation();
  const category = categorizeRoute(location.pathname);
  const categoryRef = useRef(category);
  categoryRef.current = category;

  const heartbeatRef = useRef<(() => Promise<void>) | null>(null);
  heartbeatRef.current = useCallback(async () => {
    try {
      const res = await reportHeartbeat(readTodayUsage());
      setServerCache(res);
      if (res.locked) setGloballyLocked(true);
    } catch {
      // non-fatal; next heartbeat will retry
    }
  }, []);

  const lockedRef = useRef(isGloballyLocked());

  useEffect(() => {
    cleanupOldKeys();

    const unsub = onGlobalLockChange((locked) => {
      lockedRef.current = locked;
    });

    // Fetch current server state on mount (detect existing lock).
    fetchUsageToday()
      .then((res) => {
        setServerCache(res);
        if (res.locked) setGloballyLocked(true);
      })
      .catch(() => {});

    // 5s tick: foreground-aware local tracking.
    const localTick = setInterval(() => {
      if (document.hidden || lockedRef.current) return;
      const key = getTodayKey();
      const data = readTodayUsage();
      data[categoryRef.current] = (data[categoryRef.current] || 0) + 5;
      localStorage.setItem(key, JSON.stringify(data));
    }, 5_000);

    // 30s heartbeat: report local totals to server.
    const heartbeat = setInterval(() => {
      if (!lockedRef.current) heartbeatRef.current?.();
    }, 30_000);

    return () => {
      clearInterval(localTick);
      clearInterval(heartbeat);
      unsub();
    };
  }, []);
}
