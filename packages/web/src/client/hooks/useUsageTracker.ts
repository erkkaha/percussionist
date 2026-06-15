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

type RouteUsage = {
  category: Category;
  project?: string;
};

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseRouteUsage(path: string): RouteUsage {
  const boardMatch = path.match(/^\/projects\/([^/]+)\/board(?:\/|$)/);
  if (boardMatch?.[1]) {
    return {
      category: 'reviewing',
      project: decodePathSegment(boardMatch[1]),
    };
  }

  const planMatch = path.match(/^\/projects\/([^/]+)\/plans\/(?:.+)/);
  if (planMatch?.[1]) {
    return {
      category: 'planning',
      project: decodePathSegment(planMatch[1]),
    };
  }

  if (/^\/sessions\/[^/]+$/.test(path)) {
    return { category: 'reviewing' };
  }

  return { category: 'other' };
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
  const routeUsage = parseRouteUsage(location.pathname);
  const routeUsageRef = useRef(routeUsage);
  routeUsageRef.current = routeUsage;

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

      const { category, project } = routeUsageRef.current;
      data[category] = (data[category] || 0) + 5;

      if (project && (category === 'reviewing' || category === 'planning')) {
        const existing = data.projects[project] ?? { reviewing: 0, planning: 0 };
        data.projects[project] = {
          ...existing,
          [category]: (existing[category] || 0) + 5,
        };
      }

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
