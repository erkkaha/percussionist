import { useEffect, useState } from 'react';
import { readUsageSettings } from '../lib/usage-settings';
import { DrumLogo } from './app-sidebar';

type Category = 'reviewing' | 'planning' | 'other';

const STORAGE_PREFIX = 'percussionist-usage';

const CATEGORY_LABELS: Record<Category, string> = {
  reviewing: 'Reviewing',
  planning: 'Planning',
  other: 'Other',
};

const CATEGORY_COLORS: Record<Category, string> = {
  reviewing: 'bg-blue-500',
  planning: 'bg-emerald-500',
  other: 'bg-gray-500',
};

function getTodayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${STORAGE_PREFIX}-${yyyy}-${mm}-${dd}`;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function isLocked(): boolean {
  const settings = readUsageSettings();
  if (settings.maxTimeHours === 0 || !settings.lockOnMax) return false;

  const maxSeconds = settings.maxTimeHours * 3600;
  const key = getTodayKey();
  const stored = localStorage.getItem(key);
  if (!stored) return false;

  const data = JSON.parse(stored) as Record<Category, number>;
  const total = (data.reviewing || 0) + (data.planning || 0) + (data.other || 0);
  return total >= maxSeconds;
}

export function UsageLockOverlay() {
  const [show, setShow] = useState(isLocked);

  useEffect(() => {
    if (show) return;

    const interval = setInterval(() => {
      setShow(isLocked());
    }, 5_000);

    return () => clearInterval(interval);
  }, [show]);

  if (!show) return null;

  const key = getTodayKey();
  const stored = localStorage.getItem(key);
  const data: Record<Category, number> = stored
    ? JSON.parse(stored)
    : { reviewing: 0, planning: 0, other: 0 };
  const total = (data.reviewing || 0) + (data.planning || 0) + (data.other || 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-80 border bg-surface-raised p-6 shadow-xl">
        <div className="flex flex-col items-center gap-4 text-center">
          <DrumLogo playing size={48} />
          <h2 className="text-lg font-semibold text-text">Daily time limit reached</h2>
          <p className="text-sm text-text-muted">
            You have used your allocated {formatDuration(total)} for today.
          </p>

          <div className="flex flex-col gap-2 w-full">
            {(['reviewing', 'planning', 'other'] as const).map((cat) => {
              const seconds = data[cat] || 0;
              const pct = total > 0 ? Math.round((seconds / total) * 100) : 0;
              return (
                <div key={cat} className="flex items-center gap-2 text-xs text-text-muted">
                  <span className={`w-2 h-2 shrink-0 ${CATEGORY_COLORS[cat]}`} />
                  <span className="w-20 text-left">{CATEGORY_LABELS[cat]}</span>
                  <div className="flex-1 h-1.5 bg-sidebar-accent overflow-hidden">
                    <div
                      className={`h-full ${CATEGORY_COLORS[cat]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-16 text-right">{formatDuration(seconds)}</span>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-text-dim mt-2">Usage tracking will resume at midnight.</p>
        </div>
      </div>
    </div>
  );
}
