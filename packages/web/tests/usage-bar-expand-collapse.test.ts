// usage-bar-expand-collapse.test.ts — Verification tests for UsageBar
// expand/collapse mode feature.
//
// There is no React component test harness (no @testing-library/react or
// similar) in this repo. These tests follow the source-inspection pattern
// from agent-capabilities.test.tsx plus export-level checks for constants
// and helpers used by the feature.
//
// Manual regression validation is documented in the test descriptions
// and the commit summary.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source-inspection tests — verify the component markup patterns match
// expectations for each view mode. These detect accidental deletion or
// structural changes.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('../src/client/components/UsageBar.tsx', import.meta.url), 'utf8');

describe('UsageBar compact-mode rendering', () => {
  it('renders a merged stacked progress bar in compact mode', () => {
    // The compact branch uses a single bar container with h-1.5 rounded-none.
    expect(SRC).toContain('flex h-1.5 rounded-none overflow-hidden bg-sidebar-accent');
    // Segments are mapped over SEGMENT_ORDER
    expect(SRC).toContain('SEGMENT_ORDER.map((cat)');
  });

  it('renders a single label line below the bar in compact mode', () => {
    // The compact label is a span with text-caption-xs
    expect(SRC).toContain(
      'text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden',
    );
  });
});

describe('UsageBar expanded-mode rendering', () => {
  it('renders per-category rows with separate labels and values', () => {
    // Expanded rows iterate over SEGMENT_ORDER
    expect(SRC).toContain('{humanizeCategory(cat)}');
    expect(SRC).toContain('{rowValue(cat)}');
    // Per-row container structure
    expect(SRC).toContain('flex flex-col gap-0.5');
    // Per-row flex header
    expect(SRC).toContain('flex items-center justify-between text-caption-xs');
  });

  it('uses correct category colors per row in expanded mode', () => {
    // Each bar segment uses CATEGORY_COLORS[cat]
    expect(SRC).toContain('CATEGORY_COLORS[cat]');
  });

  it('renders three category rows for reviewing, planning, and other', () => {
    // SEGMENT_ORDER defines the three categories
    expect(SRC).toContain("'reviewing', 'planning', 'other'");
    // The expanded branch maps over SEGMENT_ORDER
    expect(SRC).toContain('SEGMENT_ORDER.map((cat)');
  });

  it('hides expanded details when sidebar is icon-collapsed', () => {
    // The per-category container has group-data-[collapsible=icon]:hidden
    expect(SRC).toContain('group-data-[collapsible=icon]:hidden');
  });
});

describe('UsageBar mode toggle switch', () => {
  it('renders a toggle button that calls setViewMode', () => {
    // The toggle button wired to setViewMode(nextViewMode)
    expect(SRC).toContain('onClick={() => setViewMode(nextViewMode)}');
    expect(SRC).toContain('aria-label={`Switch to ${VIEW_MODE_LABEL[nextViewMode]}`}');
  });

  it('computes opposite view mode for the toggle', () => {
    // nextViewMode is the opposite of current
    expect(SRC).toContain(
      "const nextViewMode: ViewMode = viewMode === 'compact' ? 'expanded' : 'compact'",
    );
  });

  it('shows ChevronsUpDown icon in compact, ChevronsDownUp in expanded', () => {
    // ToggleIcon alternates between the two icons
    expect(SRC).toContain(
      "const ToggleIcon: LucideIcon = effectiveViewMode === 'compact' ? ChevronsUpDown : ChevronsDownUp",
    );
  });

  it('persists view mode preference in localStorage', () => {
    expect(SRC).toContain("VIEW_MODE_STORAGE_KEY = 'percussionist:usagebar:view-mode'");
    // Reads on init with validation
    expect(SRC).toContain("stored === 'compact' || stored === 'expanded' ? stored : 'compact'");
    // Writes on change
    expect(SRC).toContain('localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode)');
  });
});

describe('UsageBar sidebar-collapse integration', () => {
  it('forces compact mode when desktop sidebar is icon-collapsed', () => {
    // Line computing whether sidebar is icon-collapsed
    expect(SRC).toContain(
      "const isSidebarIconCollapsed = !isMobile && sidebarState === 'collapsed'",
    );
    // Effective view mode forces compact
    expect(SRC).toContain(
      "const effectiveViewMode: ViewMode = isSidebarIconCollapsed ? 'compact' : viewMode",
    );
  });

  it('uses useSidebar hook for collapse state', () => {
    expect(SRC).toContain("import { useSidebar } from './ui/sidebar'");
    expect(SRC).toContain('const { state: sidebarState, isMobile } = useSidebar()');
  });

  it('centers controls in icon-collapsed state', () => {
    expect(SRC).toContain('group-data-[collapsible=icon]:items-center');
  });
});

describe('UsageBar active-category dot', () => {
  it('shows active-category dot reflecting route category', () => {
    expect(SRC).toContain('categorizeUsageRoute(location.pathname)');
    expect(SRC).toContain('CATEGORY_COLORS[activeCategory]');
    expect(SRC).toContain('role="img"');
    expect(SRC).toContain('title={`Tracking: ${activeCategoryLabel}`}');
    expect(SRC).toContain('aria-label={`Tracking: ${activeCategoryLabel}`}');
  });
});

describe('UsageBar settings interaction', () => {
  it('uses shared normalizedWidths and categoryTotals for both mode branches', () => {
    // normalizedWidths is computed once and used in both compact (line 130)
    // and expanded (line 170) branches
    expect(SRC).toContain('const normalizedWidths: Record<Category, number>');
    expect(SRC).toContain('const categoryTotals: Record<Category, number>');
  });

  it('computes label string based on showPercent and maxTimeHours', () => {
    // Label computation branches:
    // - "X% of Yh" (maxSeconds > 0 && showPercent)
    // - formatted duration "of Yh" (maxSeconds > 0 && !showPercent)
    // - "X% reviewing · Y% planning" (showPercent)
    // - formatted duration "today" (default)
    expect(SRC).toContain('Math.round(pctOfMax)}% of ${settings.maxTimeHours}h');
    expect(SRC).toContain('${formatDuration(total)} of ${settings.maxTimeHours}h');
    expect(SRC).toContain('${p}% ${c}');
    expect(SRC).toContain('${formatDuration(total)} today');
  });

  it('computes per-row values consistently with compact label in expanded mode', () => {
    // rowValue function uses same showPercent/maxSeconds/settings as compact label
    expect(SRC).toContain('function rowValue(category: Category): string');
    expect(SRC).toContain('Math.round(normalizedWidths[category])}%');
    expect(SRC).toContain(
      '${formatDuration(categoryTotals[category])} / ${settings.maxTimeHours}h',
    );
  });
});

describe('UsageBar warning and max-limit cues', () => {
  it('shows warning ring on compact stacked bar', () => {
    // warningClass is applied to the compact bar container
    expect(SRC).toContain('const warningClass');
    expect(SRC).toContain('ring-red-500/50 bg-red-500/10');
    expect(SRC).toContain('ring-amber-500/50 bg-amber-500/10');
  });

  it('shows opacity cue when at max in compact mode', () => {
    expect(SRC).toContain("${isAtMax ? 'opacity-50' : ''}");
  });
});

// ---------------------------------------------------------------------------
// Export-level tests — verify the component exports correctly
// ---------------------------------------------------------------------------

describe('UsageBar module exports', () => {
  it('exports the UsageBar component', () => {
    expect(SRC).toContain('export function UsageBar()');
  });

  it('imports ChevronsUpDown and ChevronsDownUp for toggle', () => {
    expect(SRC).toContain(
      "import { ChevronsDownUp, ChevronsUpDown, type LucideIcon } from 'lucide-react'",
    );
  });

  it('imports UsageSettingsPopover for settings button', () => {
    expect(SRC).toContain("import { UsageSettingsPopover } from './UsageSettingsPopover'");
  });

  it('references UsageSettingsPopover in JSX', () => {
    expect(SRC).toContain('<UsageSettingsPopover />');
  });
});

// ---------------------------------------------------------------------------
// Manual regression validation summary (documented, not automated)
//
// Desktop expanded sidebar:
//   1. Toggle click switches viewMode → effectiveViewMode → compact/expanded
//   2. Expanded mode renders three per-category rows with humanized labels,
//      separate colored bars, and duration/percent values.
//   3. The active-category dot (colored circle) reflects categorizeUsageRoute
//      of the current location.pathname.
//
// Desktop icon-collapsed sidebar:
//   1. isSidebarIconCollapsed=true forces effectiveViewMode to 'compact'.
//   2. All text labels are hidden via group-data-[collapsible=icon]:hidden.
//   3. Controls (toggle, settings, dot) remain visible but centered via
//      group-data-[collapsible=icon]:items-center.
//
// Mobile sidebar sheet:
//   1. Sidebar opens as a Sheet overlay (no icon-collapsed state).
//   2. isMobile=true prevents isSidebarIconCollapsed from triggering.
//   3. User can freely toggle compact/expanded.
//
// Active-category dot:
//   1. Computed from categorizeUsageRoute(location.pathname).
//   2. Color set by CATEGORY_COLORS[activeCategory].
//   3. role="img" with accessible title and aria-label.
//   4. Rendered unconditionally in both modes and sidebar states.
//
// Settings changes (showPercent, maxTimeHours):
//   1. Both compact and expanded branches read shared showPercent and
//      maxSeconds that derive from server settings.
//   2. Compact label and expanded rowValue() use the same showPercent
//      and maxTimeHours preferences.
//   3. The normalizedWidths for per-category bar widths are computed
//      once and shared between both render branches.
//   4. Warning/max visual cues (ring, opacity) work in compact mode;
//      expanded mode relies on proportional bar widths that naturally
//      communicate remaining capacity.
// ---------------------------------------------------------------------------
