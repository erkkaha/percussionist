import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { readUsageSettings } from '../lib/usage-settings';

type Category = 'reviewing' | 'planning' | 'other';

const STORAGE_PREFIX = 'percussionist-usage';

function getTodayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${STORAGE_PREFIX}-${yyyy}-${mm}-${dd}`;
}

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
      if (settings.maxTimeHours > 0 && settings.lockOnMax) {
        const key = getTodayKey();
        const stored = localStorage.getItem(key);
        if (stored) {
          const data = JSON.parse(stored) as Record<Category, number>;
          const total = (data.reviewing || 0) + (data.planning || 0) + (data.other || 0);
          if (total >= settings.maxTimeHours * 3600) return;
        }
      }

      const key = getTodayKey();
      const stored = localStorage.getItem(key);
      const data: Record<Category, number> = stored
        ? (JSON.parse(stored) as Record<Category, number>)
        : { reviewing: 0, planning: 0, other: 0 };

      data[categoryRef.current] = (data[categoryRef.current] || 0) + 5;
      localStorage.setItem(key, JSON.stringify(data));
    }, 5_000);

    return () => clearInterval(interval);
  }, []);
}
