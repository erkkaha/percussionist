import { useEffect, useState } from 'react';
import { readUsageSettings, type UsageSettings } from '../lib/usage-settings';
import { UsageSettingsPopover } from './UsageSettingsPopover';

type Category = 'reviewing' | 'planning' | 'other';

const STORAGE_PREFIX = 'percussionist-usage';

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

const SEGMENT_COLORS: Record<Category, string> = {
  reviewing: 'bg-blue-500',
  planning: 'bg-emerald-500',
  other: 'bg-gray-500',
};

const SEGMENT_ORDER: Category[] = ['reviewing', 'planning', 'other'];

function readTodayUsage(): Record<Category, number> {
  try {
    const key = getTodayKey();
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<Category, number>;
      return {
        reviewing: parsed.reviewing || 0,
        planning: parsed.planning || 0,
        other: parsed.other || 0,
      };
    }
  } catch {
    // ignore
  }
  return { reviewing: 0, planning: 0, other: 0 };
}

export function UsageBar() {
  const [usage, setUsage] = useState<Record<Category, number>>(readTodayUsage);
  const [settings, setSettings] = useState<UsageSettings>(readUsageSettings);

  useEffect(() => {
    const interval = setInterval(() => {
      setUsage(readTodayUsage());
      setSettings(readUsageSettings());
    }, 5_000);

    return () => clearInterval(interval);
  }, []);

  const total = usage.reviewing + usage.planning + usage.other;

  const maxSeconds = settings.maxTimeHours > 0 ? settings.maxTimeHours * 3600 : 0;
  const pctOfMax = maxSeconds > 0 ? (total / maxSeconds) * 100 : 0;
  const isAtMax = maxSeconds > 0 && total >= maxSeconds;

  let label: string;
  if (maxSeconds > 0 && settings.showPercent) {
    label = `${Math.round(pctOfMax)}% of ${settings.maxTimeHours}h`;
  } else if (maxSeconds > 0 && !settings.showPercent) {
    label = `${formatDuration(total)} of ${settings.maxTimeHours}h`;
  } else if (settings.showPercent) {
    const parts = SEGMENT_ORDER.map((c) => {
      const p = total > 0 ? Math.round((usage[c] / total) * 100) : 0;
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
          {SEGMENT_ORDER.map((cat) => {
            const pct = total > 0 ? (usage[cat] / total) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={cat}
                className={`h-full shrink-0 ${SEGMENT_COLORS[cat]}`}
                style={{ width: `${pct}%` }}
              />
            );
          })}
        </div>
        <UsageSettingsPopover />
      </div>
      <span className="text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
        {label}
      </span>
    </div>
  );
}
