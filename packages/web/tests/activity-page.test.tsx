// activity-page.test.tsx — Regression tests for Activity "Load more" ordering.
//
// Bug 7: "Load more" (backwards pagination via ?before=) merged older events
// with a *prepend*, so days-old events rendered above today's events and date
// grouping broke. Older pages must be *appended* below ([...prev, ...fresh]);
// only replace/refresh and periodic polls (no `before`) may prepend so new
// events surface at the top.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks globalThis.fetch to serve controlled /api/activity
// pages and intercepts the 5s poll interval (captured, never scheduled) so the
// poll path can be driven deterministically.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

interface MockEvent {
  id: number;
  project: string;
  taskName: string;
  taskType: string;
  eventType: string;
  payload: string;
  createdAt: string;
}

const MOCK_COUNT = 250; // >= LIMIT (200) so "Load more" is shown

function makeEvent(id: number, createdAt: string): MockEvent {
  return {
    id,
    project: 'proj-a',
    taskName: 'task-build-1',
    taskType: 'build',
    eventType: 'run.created',
    payload: JSON.stringify({ runName: `run-${id}` }),
    createdAt,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const todayIso = new Date(now).toISOString();
const yesterdayIso = new Date(now - DAY_MS).toISOString();
const twoDaysAgoIso = new Date(now - 2 * DAY_MS).toISOString();

/** First page returned by the API: newest events first, no `before` filter. */
let newestPage: MockEvent[];
/** Page returned when the API is asked for events older than oldestId. */
let olderPage: MockEvent[];
/** Page returned on subsequent polls (a newer event arrives). */
let pollPage: MockEvent[];

let originalFetch: typeof globalThis.fetch;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;
/** Captured 5s poll callback; driven manually in tests. */
let pollCallback: (() => void) | null = null;
/** Count of no-`before` fetches so poll responses differ from the initial load. */
let noBeforeCalls = 0;

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/lib/auth'), () => ({
  authHeaders: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  newestPage = [makeEvent(300, todayIso), makeEvent(299, todayIso), makeEvent(298, yesterdayIso)];
  olderPage = [makeEvent(297, yesterdayIso), makeEvent(296, twoDaysAgoIso)];
  pollPage = [makeEvent(301, todayIso), ...newestPage];
  pollCallback = null;
  noBeforeCalls = 0;
}

/** JSON response shaped like the /api/activity endpoint. */
function activityResponse(events: MockEvent[]) {
  return new Response(JSON.stringify({ events, count: MOCK_COUNT }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Wrap in MemoryRouter (ActivityPage renders react-router Link). */
async function renderPage() {
  const { MemoryRouter } = await import('react-router-dom');
  const { default: ActivityPage } = await import('../src/client/pages/ActivityPage');
  return render(React.createElement(MemoryRouter, null, React.createElement(ActivityPage)));
}

/** Event descriptions ("Run <id>") in document order. */
function renderedEventOrder(): string[] {
  return Array.from(screen.getAllByText(/^Run \d+$/)).map((el) => el.textContent ?? '');
}

/** Date-group header labels in document order (sticky separators, not the counter). */
function renderedDateGroups(): string[] {
  return Array.from(document.querySelectorAll('div.sticky span.text-label-md')).map(
    (el) => el.textContent ?? '',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityPage "Load more" ordering', () => {
  beforeEach(() => {
    resetMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = typeof url === 'string' ? url : String(url);
      if (href.startsWith('/api/activity')) {
        const hasBefore = href.includes('before=');
        if (hasBefore) return activityResponse(olderPage);
        noBeforeCalls += 1;
        // First no-before call is the initial load; later ones are polls.
        return activityResponse(noBeforeCalls > 1 ? pollPage : newestPage);
      }
      return originalFetch(url, init);
    };

    // Capture the 5s poll interval so tests drive it deterministically; let
    // every other interval (e.g. testing-library waitFor's 50ms check) pass
    // through to the real scheduler.
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 5000) {
        pollCallback = cb as () => void;
        return 0; // never scheduled; driven manually via pollCallback()
      }
      return originalSetInterval(cb as () => void, ms as number, ...args);
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: number) => {
      if (id === 0) return; // our captured poll id is a no-op
      return originalClearInterval(id as number);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it('appends older events below existing ones when loading more (before=)', async () => {
    await renderPage();

    // Initial page renders newest-first: 300, 299 (today), 298 (yesterday).
    expect(await screen.findByText('Run 300')).toBeTruthy();
    expect(renderedEventOrder()).toEqual(['Run 300', 'Run 299', 'Run 298']);

    // Load more → API queried with before=298 → returns older events.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // Older events must be appended BELOW, not prepended above.
    expect(await screen.findByText('Run 296')).toBeTruthy();
    expect(renderedEventOrder()).toEqual(['Run 300', 'Run 299', 'Run 298', 'Run 297', 'Run 296']);
  });

  it('keeps date groups monotonic (descending chronological order)', async () => {
    await renderPage();
    expect(await screen.findByText('Run 300')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Run 296')).toBeTruthy();

    // Today's group must render above yesterday's, which must render above the
    // two-day-old group. (Bug 7 produced ["Yesterday", "Today", ...] order.)
    expect(renderedDateGroups()[0]).toBe('Today');
    expect(renderedDateGroups()[1]).toBe('Yesterday');
    expect(renderedDateGroups()[2]).not.toBe('Today');
  });

  it('still prepends on a periodic poll (no before=)', async () => {
    await renderPage();
    expect(await screen.findByText('Run 300')).toBeTruthy();

    // Drive the captured 5s poll: a newer event (301) arrives today.
    pollCallback?.();

    // New event must surface at the TOP (prepend), existing events preserved.
    expect(await screen.findByText('Run 301')).toBeTruthy();
    expect(renderedEventOrder()).toEqual(['Run 301', 'Run 300', 'Run 299', 'Run 298']);
  });

  it('deduplicates by id when a poll repeats already-loaded events', async () => {
    await renderPage();
    expect(await screen.findByText('Run 300')).toBeTruthy();

    pollCallback?.();
    expect(await screen.findByText('Run 301')).toBeTruthy();

    // No duplicate rows for ids already present (300/299/298 appear once).
    expect(screen.getAllByText('Run 300')).toHaveLength(1);
    expect(screen.getAllByText('Run 299')).toHaveLength(1);
    expect(screen.getAllByText('Run 298')).toHaveLength(1);
  });
});
