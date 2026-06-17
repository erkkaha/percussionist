import { ChevronsDownUp, ChevronsUpDown, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CATEGORY_COLORS, categorizeUsageRoute } from '../lib/usage-categorization';
import {
  type Category,
  formatDuration,
  getServerCache,
  readTodayUsage,
} from '../lib/usage-settings';
import { UsageSettingsPopover } from './UsageSettingsPopover';
import { useSidebar } from './ui/sidebar';

const SEGMENT_ORDER: Category[] = ['reviewing', 'planning', 'other'];
const VIEW_MODE_STORAGE_KEY = 'percussionist:usagebar:view-mode';
const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  compact: 'Compact usage tracker',
  expanded: 'Expanded usage tracker',
};

type ViewMode = 'compact' | 'expanded';

function humanizeCategory(category: Category): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function UsageBar() {
  const location = useLocation();
  const [usage, setUsage] = useState(readTodayUsage);
  const [server, setServer] = useState(getServerCache);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === 'compact' || stored === 'expanded' ? stored : 'compact';
  });
  const { state: sidebarState, isMobile } = useSidebar();
  const activeCategory = categorizeUsageRoute(location.pathname);
  const activeCategoryLabel = humanizeCategory(activeCategory);

  // Usage tracker mode (compact/expanded) is independent from sidebar collapse state.
  const isSidebarIconCollapsed = !isMobile && sidebarState === 'collapsed';
  const effectiveViewMode: ViewMode = isSidebarIconCollapsed ? 'compact' : viewMode;

  useEffect(() => {
    const interval = setInterval(() => {
      setUsage(readTodayUsage());
      setServer(getServerCache());
    }, 5_000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // Merge local and server: take the max per category.
  const categoryTotals: Record<Category, number> = {
    reviewing: Math.max(usage.reviewing, server?.reviewing ?? 0),
    planning: Math.max(usage.planning, server?.planning ?? 0),
    other: Math.max(usage.other, server?.other ?? 0),
  };
  const total = SEGMENT_ORDER.reduce((sum, cat) => sum + categoryTotals[cat], 0);

  const settings = server?.settings;
  const showPercent = settings?.showPercent ?? false;
  const maxSeconds = settings && settings.maxTimeHours > 0 ? settings.maxTimeHours * 3600 : 0;
  const pctOfMax = maxSeconds > 0 ? (total / maxSeconds) * 100 : 0;
  const isAtMax = maxSeconds > 0 && total >= maxSeconds;
  const denominator = maxSeconds > 0 ? maxSeconds : total;
  const normalizedWidths: Record<Category, number> = SEGMENT_ORDER.reduce(
    (acc, cat) => {
      acc[cat] = denominator > 0 ? (categoryTotals[cat] / denominator) * 100 : 0;
      return acc;
    },
    { reviewing: 0, planning: 0, other: 0 },
  );
  const categoryPercentsOfTotal: Record<Category, number> = SEGMENT_ORDER.reduce(
    (acc, cat) => {
      acc[cat] = total > 0 ? Math.round((categoryTotals[cat] / total) * 100) : 0;
      return acc;
    },
    { reviewing: 0, planning: 0, other: 0 },
  );

  let label: string;
  if (maxSeconds > 0 && settings) {
    label = showPercent
      ? `${Math.round(pctOfMax)}% of ${settings.maxTimeHours}h`
      : `${formatDuration(total)} of ${settings.maxTimeHours}h`;
  } else if (showPercent) {
    const parts = SEGMENT_ORDER.map((c) => {
      const p = categoryPercentsOfTotal[c];
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

  const nextViewMode: ViewMode = viewMode === 'compact' ? 'expanded' : 'compact';
  const ToggleIcon: LucideIcon = effectiveViewMode === 'compact' ? ChevronsUpDown : ChevronsDownUp;

  function rowValue(category: Category): string {
    if (showPercent) {
      return `${Math.round(normalizedWidths[category])}%`;
    }

    if (maxSeconds > 0 && settings) {
      return `${formatDuration(categoryTotals[category])} / ${settings.maxTimeHours}h`;
    }

    return formatDuration(categoryTotals[category]);
  }

  return (
    <div className="flex flex-col gap-1.5 px-1 py-1 group-data-[collapsible=icon]:items-center">
      <div className="flex items-center gap-1.5">
        {effectiveViewMode === 'compact' ? (
          <div
            className={`flex-1 flex h-1.5 rounded-none overflow-hidden bg-sidebar-accent ${warningClass} ${isAtMax ? 'opacity-50' : ''}`}
          >
            {SEGMENT_ORDER.map((cat) => {
              const pct = normalizedWidths[cat];
              if (pct <= 0) return null;
              return (
                <div
                  key={cat}
                  className={`h-full shrink-0 ${CATEGORY_COLORS[cat]}`}
                  style={{ width: `${pct}%` }}
                />
              );
            })}
          </div>
        ) : (
          <span className="flex-1 text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
            {label}
          </span>
        )}
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${CATEGORY_COLORS[activeCategory]}`}
          role="img"
          title={`Tracking: ${activeCategoryLabel}`}
          aria-label={`Tracking: ${activeCategoryLabel}`}
        />
        <button
          type="button"
          onClick={() => setViewMode(nextViewMode)}
          className="shrink-0 rounded-sm opacity-40 hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          title={`Switch to ${VIEW_MODE_LABEL[nextViewMode]}`}
          aria-label={`Switch to ${VIEW_MODE_LABEL[nextViewMode]}`}
        >
          <ToggleIcon size={12} />
        </button>
        <UsageSettingsPopover />
      </div>
      {effectiveViewMode === 'compact' ? (
        <span className="text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
          {label}
        </span>
      ) : (
        <div className="flex flex-col gap-1 group-data-[collapsible=icon]:hidden">
          {SEGMENT_ORDER.map((cat) => {
            const pct = normalizedWidths[cat];
            return (
              <div key={cat} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-caption-xs text-sidebar-foreground/70">
                  <span>{humanizeCategory(cat)}</span>
                  <span>{rowValue(cat)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-none bg-sidebar-accent">
                  {pct > 0 ? (
                    <div
                      className={`h-full ${CATEGORY_COLORS[cat]}`}
                      style={{ width: `${pct}%` }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
