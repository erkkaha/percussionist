import { useEffect, useState } from 'react';
import { CATEGORY_COLORS } from '../lib/usage-categorization';
import { isGloballyLocked, onGlobalLockChange } from '../lib/usage-lock-state';
import {
  type Category,
  formatDuration,
  getServerCache,
  readTodayUsage,
} from '../lib/usage-settings';
import { DrumLogo } from './app-sidebar';

const CATEGORY_LABELS: Record<Category, string> = {
  reviewing: 'Reviewing',
  planning: 'Planning',
  other: 'Other',
};

export function UsageLockOverlay() {
  const [show, setShow] = useState(isGloballyLocked);

  useEffect(() => {
    const unsub = onGlobalLockChange(setShow);
    return unsub;
  }, []);

  if (!show) return null;

  // Use server data if available, fall back to localStorage.
  const server = getServerCache();
  const data = readTodayUsage();
  const reviewing = Math.max(data.reviewing, server?.reviewing ?? 0);
  const planning = Math.max(data.planning, server?.planning ?? 0);
  const other = Math.max(data.other, server?.other ?? 0);
  const total = reviewing + planning + other;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-80 border bg-surface-raised p-6 shadow-xl">
        <div className="flex flex-col items-center gap-4 text-center">
          <DrumLogo playing size={48} />
          <h2 className="text-lg font-semibold text-text">Daily limit reached</h2>
          <p className="text-sm text-text-muted">
            You have used your allocated {formatDuration(total)} for today.
          </p>

          <div className="flex flex-col gap-2 w-full">
            {(['reviewing', 'planning', 'other'] as const).map((cat) => {
              const seconds =
                cat === 'reviewing' ? reviewing : cat === 'planning' ? planning : other;
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
