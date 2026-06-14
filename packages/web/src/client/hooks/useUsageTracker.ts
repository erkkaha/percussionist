import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  type Category,
  getTodayKey,
  isLocked,
  readTodayUsage,
  readUsageSettings,
  STORAGE_PREFIX,
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
    if (key?.startsWith(STORAGE_PREFIX) && key !== todayKey) {
      localStorage.removeItem(key);
    }
  }
}

export function useUsageTracker() {
  const location = useLocation();
  const category = categorizeRoute(location.pathname);
  const categoryRef = useRef(category);
  categoryRef.current = category;

  useEffect(() => {
    cleanupOldKeys();

    const interval = setInterval(() => {
      if (document.hidden) return;

      const settings = readUsageSettings();
      const locked = settings.maxTimeHours > 0 && settings.lockOnMax && isLocked();

      if (locked) return;

      const key = getTodayKey();
      const data = readTodayUsage();
      data[categoryRef.current] = (data[categoryRef.current] || 0) + 5;
      localStorage.setItem(key, JSON.stringify(data));
    }, 5_000);

    return () => clearInterval(interval);
  }, []);
}
