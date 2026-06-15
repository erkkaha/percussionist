import { useEffect, useState } from 'react';
import { CATEGORY_COLORS } from '../lib/usage-categorization';
import {
  type Category,
  formatDuration,
  getServerCache,
  readTodayUsage,
} from '../lib/usage-settings';
import { UsageSettingsPopover } from './UsageSettingsPopover';

const SEGMENT_ORDER: Category[] = ['reviewing', 'planning', 'other'];

export function UsageBar() {
  const [usage, setUsage] = useState(readTodayUsage);
  const [server, setServer] = useState(getServerCache);

  useEffect(() => {
    const interval = setInterval(() => {
      setUsage(readTodayUsage());
      setServer(getServerCache());
    }, 5_000);

    return () => clearInterval(interval);
  }, []);

  // Merge local and server: take the max per category.
  const reviewing = Math.max(usage.reviewing, server?.reviewing ?? 0);
  const planning = Math.max(usage.planning, server?.planning ?? 0);
  const other = Math.max(usage.other, server?.other ?? 0);
  const total = reviewing + planning + other;

  const settings = server?.settings;
  const maxSeconds = settings && settings.maxTimeHours > 0 ? settings.maxTimeHours * 3600 : 0;
  const pctOfMax = maxSeconds > 0 ? (total / maxSeconds) * 100 : 0;
  const isAtMax = maxSeconds > 0 && total >= maxSeconds;

  let label: string;
  if (maxSeconds > 0 && settings?.showPercent) {
    label = `${Math.round(pctOfMax)}% of ${settings.maxTimeHours}h`;
  } else if (maxSeconds > 0 && !settings?.showPercent) {
    label = `${formatDuration(total)} of ${settings.maxTimeHours}h`;
  } else if (settings?.showPercent) {
    const parts = SEGMENT_ORDER.map((c) => {
      const v = c === 'reviewing' ? reviewing : c === 'planning' ? planning : other;
      const p = total > 0 ? Math.round((v / total) * 100) : 0;
      return p > 0 ? `${p}% ${c}` : null;
    }).filter(Boolean);
    label = parts.join(' · ');
  } else {
    label = `${formatDuration(total)} today`;
  }

  const warningClass =
    pctOfMax >= 85
      ? 'ring-1 ring-inset ring-red-500/50 bg-red-500/10'
      : pctOfMax >= 60
        ? 'ring-1 ring-inset ring-amber-500/50 bg-amber-500/10'
        : '';

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1 group-data-[collapsible=icon]:items-center">
      <div className="flex items-center gap-1.5">
        <div
          className={`flex-1 flex h-1.5 rounded-none overflow-hidden bg-sidebar-accent ${warningClass} ${isAtMax ? 'opacity-50' : ''}`}
        >
          {(() => {
            const cats: { cat: Category; val: number }[] = [
              { cat: 'reviewing', val: reviewing },
              { cat: 'planning', val: planning },
              { cat: 'other', val: other },
            ];
            return cats.map(({ cat, val }) => {
              const pct = total > 0 ? (val / total) * 100 : 0;
              if (pct <= 0) return null;
              return (
                <div
                  key={cat}
                  className={`h-full shrink-0 ${CATEGORY_COLORS[cat]}`}
                  style={{ width: `${pct}%` }}
                />
              );
            });
          })()}
        </div>
        <UsageSettingsPopover />
      </div>
      <span className="text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
        {label}
      </span>
    </div>
  );
}
