// use-usage-tracker.test.tsx — C13: exercise the core useUsageTracker logic
// that had no coverage:
//
//   - 5s local tick increments the current route's category and, on board /
//     plans routes, the per-project counter (persisted to today's localStorage
//     key).
//   - cleanupOldKeys prunes stale day keys while keeping today's key and the
//     *-settings keys.
//   - The global lock (initial state, set by a locked server response on mount
//     or from a heartbeat) freezes the tick; unlocking resumes it.
//   - The 30s heartbeat reports the accumulated local totals and forwards the
//     server's lock state.
//
// The hook's reportHeartbeat/fetchUsageToday are mocked (real fetch would hit
// the network); every other piece — localStorage, the today-key computation,
// route parsing, lock state — is the real implementation. setInterval is
// captured so ticks can be fired deterministically instead of waiting 5s.
//
// mock.module is registered before the SUT and the lib module are imported
// (dynamic imports below), so the hook sees the mocked reportHeartbeat /
// fetchUsageToday while the test reads the real getTodayKey / readTodayUsage
// from the same (patched) module.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { setGloballyLocked } from '../src/client/lib/usage-lock-state.js';
import {
  getTodayKey,
  type readTodayUsage,
  STORAGE_PREFIX,
  type UsageServerResponse,
} from '../src/client/lib/usage-settings.js';

const mockHeartbeat = mock(() => Promise.resolve({ locked: false } as UsageServerResponse));
const mockFetchToday = mock(() => Promise.resolve({ locked: false } as UsageServerResponse));

mock.module(path.resolve('src/client/lib/usage-settings'), () => ({
  reportHeartbeat: mockHeartbeat,
  fetchUsageToday: mockFetchToday,
}));

const { useUsageTracker } = await import('../src/client/hooks/useUsageTracker.js');

// ---------------------------------------------------------------------------
// Fake setInterval: capture callbacks by delay so tests fire ticks manually.
// ---------------------------------------------------------------------------

interface CapturedTimer {
  id: number;
  ms: number;
  fn: () => void;
}

let timers: CapturedTimer[] = [];
let nextId = 1;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function installFakeTimers(): void {
  timers = [];
  nextId = 1;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, ms, fn });
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    timers = timers.filter((t) => t.id !== id);
  }) as typeof clearInterval;
}

function restoreTimers(): void {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

function fireTicks(ms: number, times = 1): void {
  for (let i = 0; i < times; i++) {
    for (const t of [...timers]) {
      if (t.ms === ms) t.fn();
    }
  }
}

function todayUsage(): ReturnType<typeof readTodayUsage> | null {
  const raw = localStorage.getItem(getTodayKey());
  return raw ? (JSON.parse(raw) as ReturnType<typeof readTodayUsage>) : null;
}

function Tracked(): React.JSX.Element {
  useUsageTracker();
  return React.createElement('div');
}

function renderHarness(pathname: string): void {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Tracked />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installFakeTimers();
  setGloballyLocked(false);
  localStorage.clear();
  mockHeartbeat.mockReset();
  mockFetchToday.mockReset();
  mockHeartbeat.mockResolvedValue({ locked: false } as UsageServerResponse);
  mockFetchToday.mockResolvedValue({ locked: false } as UsageServerResponse);
});

afterEach(() => {
  cleanup();
  restoreTimers();
  setGloballyLocked(false);
  localStorage.clear();
});

describe('useUsageTracker local 5s tick', () => {
  it('increments reviewing and the per-project counter on a board route', () => {
    renderHarness('/projects/acme/board');

    fireTicks(5_000, 2);

    const usage = todayUsage();
    expect(usage).toBeDefined();
    expect(usage?.reviewing).toBe(10);
    expect(usage?.planning).toBe(0);
    expect(usage?.other).toBe(0);
    expect(usage?.projects.acme).toEqual({ reviewing: 10, planning: 0 });
  });

  it('increments planning on a plans route and keeps existing project counters', () => {
    localStorage.setItem(
      getTodayKey(),
      JSON.stringify({
        reviewing: 20,
        planning: 0,
        other: 0,
        projects: { acme: { reviewing: 20, planning: 5 } },
      }),
    );

    renderHarness('/projects/acme/plans/task-1');
    fireTicks(5_000);

    const usage = todayUsage();
    expect(usage?.planning).toBe(5);
    expect(usage?.projects.acme).toEqual({ reviewing: 20, planning: 10 });
    // Reviewing untouched by a planning tick.
    expect(usage?.reviewing).toBe(20);
  });

  it('increments only the category on non-project routes, never the project map', () => {
    renderHarness('/sessions/sess-123');
    fireTicks(5_000, 2);
    const sessionUsage = todayUsage();
    expect(sessionUsage?.reviewing).toBe(10);
    expect(sessionUsage?.projects).toEqual({});

    // A root path falls into the 'other' bucket.
    cleanup();
    localStorage.clear();
    renderHarness('/');
    fireTicks(5_000);
    const rootUsage = todayUsage();
    expect(rootUsage?.other).toBe(5);
  });

  it('cleans stale day keys on mount but keeps today and *-settings keys', () => {
    localStorage.setItem('percussionist-usage-1999-01-01', JSON.stringify({ other: 99 }));
    localStorage.setItem('percussionist-usage-2000-01-01', JSON.stringify({ other: 99 }));
    localStorage.setItem(`${STORAGE_PREFIX}-usage-settings`, JSON.stringify({ maxTimeHours: 1 }));

    renderHarness('/');
    fireTicks(5_000, 2);

    expect(localStorage.getItem('percussionist-usage-1999-01-01')).toBeNull();
    expect(localStorage.getItem('percussionist-usage-2000-01-01')).toBeNull();
    // Settings keys are exempt from pruning.
    expect(localStorage.getItem(`${STORAGE_PREFIX}-usage-settings`)).toBe(
      JSON.stringify({ maxTimeHours: 1 }),
    );
    // Today's key got the tick increments.
    expect(todayUsage()?.other).toBe(10);
  });
});

describe('useUsageTracker lock coupling', () => {
  it('does not tick while globally locked (lock set before mount)', () => {
    setGloballyLocked(true);
    renderHarness('/projects/acme/board');

    fireTicks(5_000, 3);

    expect(todayUsage()).toBeNull();
  });

  it('freezes ticks after a locked fetchUsageToday response on mount', async () => {
    mockFetchToday.mockResolvedValue({
      locked: true,
      reviewing: 0,
      planning: 0,
      other: 0,
      projectUsage: {},
      settings: { maxTimeHours: 0, showPercent: false, lockOnMax: false },
    } as UsageServerResponse);

    renderHarness('/projects/acme/board');
    // Let the fetch promise resolve and the lock listener run.
    await Promise.resolve();
    await Promise.resolve();

    fireTicks(5_000, 2);
    expect(todayUsage()).toBeNull();
  });

  it('freezes ticks after a locked heartbeat response', async () => {
    renderHarness('/projects/acme/board');
    fireTicks(5_000); // one visible increment before the lock lands

    mockHeartbeat.mockResolvedValue({
      locked: true,
      reviewing: 5,
      planning: 0,
      other: 0,
      projectUsage: {},
      settings: { maxTimeHours: 0, showPercent: false, lockOnMax: false },
    } as UsageServerResponse);
    fireTicks(30_000);
    await Promise.resolve();

    const before = todayUsage()?.reviewing;
    fireTicks(5_000, 2);
    const after = todayUsage()?.reviewing;
    expect(before).toBe(5);
    expect(after).toBe(5);
  });
});

describe('useUsageTracker heartbeat', () => {
  it('reports accumulated local totals to the server', async () => {
    renderHarness('/projects/acme/board');
    fireTicks(5_000, 3); // 15s of reviewing + acme reviewing

    fireTicks(30_000);
    await Promise.resolve();

    expect(mockHeartbeat).toHaveBeenCalledTimes(1);
    const payload = mockHeartbeat.mock.calls[0]?.[0] as ReturnType<typeof readTodayUsage>;
    expect(payload.reviewing).toBe(15);
    expect(payload.planning).toBe(0);
    expect(payload.other).toBe(0);
    expect(payload.projects.acme).toEqual({ reviewing: 15, planning: 0 });
  });

  it('skips the heartbeat while locked (lock heartbeat is the unlock path)', async () => {
    setGloballyLocked(true);
    renderHarness('/');
    fireTicks(30_000);
    await Promise.resolve();
    expect(mockHeartbeat).not.toHaveBeenCalled();
  });
});
