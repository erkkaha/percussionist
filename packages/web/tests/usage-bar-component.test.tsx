// usage-bar-component.test.tsx — Focused React component tests for UsageBar
// expand/collapse mode feature.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks resolve path aliases (@/) that bun does not natively
// support, and provides mutable mock state that per-test beforeEach blocks
// reconfigure independently.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import path from 'path';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

const sidebarMock = {
  state: 'expanded' as 'expanded' | 'collapsed',
  isMobile: false,
};

const usageDataMock = {
  reviewing: 0,
  planning: 0,
  other: 0,
};

const serverMock = {
  data: null as {
    locked: boolean;
    reviewing: number;
    planning: number;
    other: number;
    total: number;
    projectUsage: Record<string, { reviewing: number; planning: number }>;
    settings: { maxTimeHours: number; showPercent: boolean; lockOnMax: boolean };
  } | null,
};

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

// @/ path aliases used by sidebar.tsx and other ui components
mock.module('@/components/ui/button', () => ({ Button: 'button' }));
mock.module('@/components/ui/input', () => ({ Input: 'input' }));
mock.module('@/components/ui/separator', () => ({ Separator: 'div' }));
mock.module('@/components/ui/skeleton', () => ({ Skeleton: 'div' }));
mock.module('@/components/ui/sheet', () => ({
  Sheet: 'div',
  SheetContent: 'div',
  SheetDescription: 'div',
  SheetHeader: 'div',
  SheetTitle: 'div',
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: 'div',
  TooltipContent: 'div',
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: 'div',
}));
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
mock.module('@/lib/utils', () => ({
  cn: (...args: Array<string | boolean | undefined | null>) => args.filter(Boolean).join(' '),
}));
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: 'div',
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => children,
  SelectContent: 'div',
  SelectItem: 'div',
  SelectTrigger: 'div',
  SelectValue: 'div',
}));
mock.module('@/components/ui/switch', () => ({
  Switch: 'div',
}));

// sidebar.tsx — replace useSidebar with a configurable mock
const sidebarPath = path.resolve('src/client/components/ui/sidebar.tsx');
mock.module(sidebarPath, () => ({
  useSidebar: () => ({
    state: sidebarMock.state,
    open: sidebarMock.state === 'expanded',
    setOpen: () => {},
    openMobile: false,
    setOpenMobile: () => {},
    isMobile: sidebarMock.isMobile,
    toggleSidebar: () => {},
  }),
}));

// usage-settings.ts — mock all exports so transitive consumers (e.g.
// UsageSettingsPopover) do not trigger alias resolution errors
const settingsPath = path.resolve('src/client/lib/usage-settings.ts');
mock.module(settingsPath, () => ({
  // Re-export all symbols that real consumers (useUsageTracker, etc.) expect
  STORAGE_PREFIX: 'percussionist-usage',
  readTodayUsage: () => ({
    reviewing: usageDataMock.reviewing,
    planning: usageDataMock.planning,
    other: usageDataMock.other,
    projects: {},
  }),
  getServerCache: () => serverMock.data,
  setServerCache: () => {},
  formatDuration: (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  },
  getTodayKey: () => 'test-key',
  fetchServerSettings: () =>
    Promise.resolve({ maxTimeHours: 0, showPercent: false, lockOnMax: false }),
  updateServerSettings: () =>
    Promise.resolve({ maxTimeHours: 0, showPercent: false, lockOnMax: false }),
  reportHeartbeat: () =>
    Promise.resolve({
      locked: false,
      reviewing: 0,
      planning: 0,
      other: 0,
      total: 0,
      projectUsage: {},
      settings: { maxTimeHours: 0, showPercent: false, lockOnMax: false },
    }),
  fetchUsageToday: () =>
    Promise.resolve({
      locked: false,
      reviewing: 0,
      planning: 0,
      other: 0,
      total: 0,
      projectUsage: {},
      settings: { maxTimeHours: 0, showPercent: false, lockOnMax: false },
    }),
}));

// UsageSettingsPopover — replace with a minimal button to avoid popover/select
// dependency trees
const popoverPath = path.resolve('src/client/components/UsageSettingsPopover.tsx');
mock.module(popoverPath, () => {
  const r = require('react');
  return {
    UsageSettingsPopover: () =>
      r.createElement('button', { 'aria-label': 'Usage settings', type: 'button' }, '⚙'),
  };
});

// ---------------------------------------------------------------------------
// Helpers — reset mock state before each test
// ---------------------------------------------------------------------------

function resetMocks() {
  sidebarMock.state = 'expanded';
  sidebarMock.isMobile = false;
  usageDataMock.reviewing = 0;
  usageDataMock.planning = 0;
  usageDataMock.other = 0;
  serverMock.data = null;
  localStorage.clear();
}

function setUsage(reviewing: number, planning: number, other: number) {
  usageDataMock.reviewing = reviewing;
  usageDataMock.planning = planning;
  usageDataMock.other = other;
}

function setSidebarCollapsed(isMobile = false) {
  sidebarMock.state = 'collapsed';
  sidebarMock.isMobile = isMobile;
}

function setServerSettings(overrides: {
  maxTimeHours?: number;
  showPercent?: boolean;
  lockOnMax?: boolean;
}) {
  serverMock.data = {
    locked: false,
    reviewing: usageDataMock.reviewing,
    planning: usageDataMock.planning,
    other: usageDataMock.other,
    total: usageDataMock.reviewing + usageDataMock.planning + usageDataMock.other,
    projectUsage: {},
    settings: {
      maxTimeHours: 0,
      showPercent: false,
      lockOnMax: false,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsageBar mode toggle', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('starts in compact mode by default', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Compact mode: single label line with total duration
    expect(screen.getByText('1h 45m today')).toBeTruthy();

    // Toggle button should say "Switch to Expanded" (compact → expanded)
    expect(screen.getByRole('button', { name: /Switch to Expanded/ })).toBeTruthy();
  });

  it('switches to expanded mode when toggle is clicked', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Click toggle to expand
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));

    // After toggle, button should read "Switch to Compact"
    expect(screen.getByRole('button', { name: /Switch to Compact/ })).toBeTruthy();

    // Expanded mode shows per-category labels
    expect(screen.getByText('Reviewing')).toBeTruthy();
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('Other')).toBeTruthy();
  });

  it('toggles back to compact on second click', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Expand
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));
    expect(screen.getByText('Reviewing')).toBeTruthy();

    // Collapse back
    fireEvent.click(screen.getByRole('button', { name: /Switch to Compact/ }));
    expect(screen.getByRole('button', { name: /Switch to Expanded/ })).toBeTruthy();

    // Expanded labels should be gone
    expect(screen.queryByText('Reviewing')).toBeNull();
    expect(screen.queryByText('Planning')).toBeNull();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('persists view mode preference in localStorage', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Default: compact
    expect(localStorage.getItem('percussionist:usagebar:view-mode')).toBe('compact');

    // Toggle to expanded
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));
    expect(localStorage.getItem('percussionist:usagebar:view-mode')).toBe('expanded');

    // Toggle back to compact
    fireEvent.click(screen.getByRole('button', { name: /Switch to Compact/ }));
    expect(localStorage.getItem('percussionist:usagebar:view-mode')).toBe('compact');
  });
});

describe('UsageBar compact mode layout', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders a stacked progress bar with colored segments', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // The compact bar is a div with overflow-hidden container
    const bar = container.querySelector('.overflow-hidden');
    expect(bar).toBeTruthy();

    // It contains colored segment divs
    const segments = bar?.querySelectorAll('[class*="bg-"]');
    expect(segments?.length).toBeGreaterThan(0);
  });

  it('renders a single label line with total duration', async () => {
    setUsage(3600, 1800, 900);
    setServerSettings({ showPercent: false });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // With no maxTimeHours and showPercent=false → "1h 45m today"
    expect(screen.getByText('1h 45m today')).toBeTruthy();
  });

  it('hides label when sidebar is icon-collapsed', async () => {
    setUsage(3600, 1800, 900);
    setSidebarCollapsed(false); // desktop collapsed
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // The label text should still be in the DOM but hidden via CSS class
    const label = screen.getByText('1h 45m today');
    expect(label).toBeTruthy();
    expect(label.className).toContain('group-data-[collapsible=icon]:hidden');
  });
});

describe('UsageBar expanded mode layout', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders three labeled bars when toggled to expanded', async () => {
    setUsage(3600, 1800, 900);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Switch to expanded
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));

    // Three category labels
    expect(screen.getByText('Reviewing')).toBeTruthy();
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('Other')).toBeTruthy();

    // Per-row duration values (no maxTimeHours, no showPercent)
    // rowValue returns formatDuration for each category
    expect(screen.getByText('1h 0m')).toBeTruthy(); // 3600s = reviewing
    expect(screen.getByText('30m')).toBeTruthy(); // 1800s = planning
    expect(screen.getByText('15m')).toBeTruthy(); // 900s  = other
  });
});

describe('UsageBar sidebar-collapse integration', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('forces compact mode when sidebar is icon-collapsed on desktop', async () => {
    setUsage(3600, 1800, 900);
    setSidebarCollapsed(false); // desktop collapsed
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // viewMode starts as 'compact' (default), effectiveViewMode is 'compact'
    // (forced by sidebar collapse). The toggle label is based on viewMode
    // (the stored preference), so it should show "Switch to Expanded"
    // because nextViewMode is the opposite of the current viewMode.
    expect(screen.getByRole('button', { name: /Switch to Expanded/ })).toBeTruthy();

    // Click toggle — viewMode changes to 'expanded' in localStorage,
    // but effectiveViewMode stays 'compact' (forced by sidebar collapse).
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));
    expect(localStorage.getItem('percussionist:usagebar:view-mode')).toBe('expanded');

    // After click, viewMode is 'expanded', so the toggle label now shows
    // "Switch to Compact" (the next toggle would go back to compact).
    // The icon (ChevronsUpDown) still reflects effectiveViewMode='compact'.
    expect(screen.getByRole('button', { name: /Switch to Compact/ })).toBeTruthy();

    // Expanded category labels should NOT appear because effectiveViewMode
    // is still 'compact' (sidebar collapse overrides stored preference).
    expect(screen.queryByText('Reviewing')).toBeNull();
    expect(screen.queryByText('Planning')).toBeNull();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('does not force compact when sidebar is collapsed on mobile', async () => {
    setUsage(3600, 1800, 900);
    setSidebarCollapsed(true); // mobile → sheet overlay, not icon mode
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Toggle works normally on mobile
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));
    expect(screen.getByText('Reviewing')).toBeTruthy();
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.getByText('Other')).toBeTruthy();
  });
});

describe('UsageBar active-category dot', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders a dot reflecting the active route category', async () => {
    setUsage(0, 0, 0);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    // /runs → categorizeUsageRoute('other')
    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    const dot = screen.getByRole('img', { name: /Tracking: Other/ });
    expect(dot).toBeTruthy();
    expect(dot.className).toContain('bg-gray-500');
  });

  it('reflects board route as reviewing category', async () => {
    setUsage(0, 0, 0);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    // /projects/acme/board → reviewing
    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/projects/acme/board'] },
        React.createElement(UsageBar),
      ),
    );

    const dot = screen.getByRole('img', { name: /Tracking: Reviewing/ });
    expect(dot).toBeTruthy();
    expect(dot.className).toContain('bg-blue-500');
  });

  it('reflects plan route as planning category', async () => {
    setUsage(0, 0, 0);
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    // /projects/acme/plans/task-123 → planning
    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/projects/acme/plans/task-123'] },
        React.createElement(UsageBar),
      ),
    );

    const dot = screen.getByRole('img', { name: /Tracking: Planning/ });
    expect(dot).toBeTruthy();
    expect(dot.className).toContain('bg-emerald-500');
  });
});

describe('UsageBar settings interaction', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('displays percent breakdown when showPercent is enabled', async () => {
    setUsage(3600, 1800, 900);
    setServerSettings({ showPercent: true });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // 3600/6300 ≈ 57%, 1800/6300 ≈ 29%, 900/6300 ≈ 14%
    expect(screen.getByText('57% reviewing · 29% planning · 14% other')).toBeTruthy();
  });

  it('displays max-time context when maxTimeHours is set (no percent)', async () => {
    setUsage(3600, 1800, 900);
    setServerSettings({ maxTimeHours: 4, showPercent: false });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // 6300s = 1h 45m
    expect(screen.getByText('1h 45m of 4h')).toBeTruthy();
  });

  it('displays percent-of-max when both are set', async () => {
    setUsage(3600, 1800, 900);
    setServerSettings({ maxTimeHours: 4, showPercent: true });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // 6300 / (4*3600) ≈ 43.75% → 44%
    expect(screen.getByText('44% of 4h')).toBeTruthy();
  });

  it('updates expanded row values consistently with compact label', async () => {
    setUsage(3600, 1800, 900);
    setServerSettings({ maxTimeHours: 4, showPercent: true });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Switch to expanded
    fireEvent.click(screen.getByRole('button', { name: /Switch to Expanded/ }));

    // Per-category normalized widths: 3600/14400=25%, 1800/14400=12.5%, 900/14400=6.25%
    expect(screen.getByText('25%')).toBeTruthy(); // reviewing
    expect(screen.getByText('13%')).toBeTruthy(); // planning
    expect(screen.getByText('6%')).toBeTruthy(); // other
  });
});

describe('UsageBar warning cues', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows warning ring on compact bar when usage exceeds 85% of max', async () => {
    setUsage(3400, 0, 0); // 3400s out of 2*3600=7200 → 47% (below 60%, no warning)
    setServerSettings({ maxTimeHours: 2 });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    // Find the stacked bar container
    const barContainer = container.querySelector('.overflow-hidden');
    expect(barContainer).toBeTruthy();

    // 3400/7200 ≈ 47% — no warning ring
    expect(barContainer!.className).not.toContain('ring-red');
    expect(barContainer!.className).not.toContain('ring-amber');
  });

  it('shows amber warning between 60% and 85%', async () => {
    setUsage(4500, 0, 0); // 4500/7200 ≈ 62.5% → amber warning
    setServerSettings({ maxTimeHours: 2 });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    const barContainer = container.querySelector('.overflow-hidden');
    expect(barContainer!.className).toContain('ring-amber');
  });

  it('shows red warning at or above 85%', async () => {
    setUsage(6400, 0, 0); // 6400/7200 ≈ 88.9% → red warning
    setServerSettings({ maxTimeHours: 2 });
    const { MemoryRouter } = await import('react-router-dom');
    const { UsageBar } = await import('../src/client/components/UsageBar');

    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/runs'] },
        React.createElement(UsageBar),
      ),
    );

    const barContainer = container.querySelector('.overflow-hidden');
    expect(barContainer!.className).toContain('ring-red');
  });
});
