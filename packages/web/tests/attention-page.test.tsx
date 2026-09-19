// attention-page.test.tsx — Component tests for the global "Needs attention"
// inbox page.
//
// Uses @testing-library/react with the happy-dom environment from
// tests/setup.ts. `useAttention` is module-mocked so the four query states
// (loading, error, empty, populated) are driven deterministically without a
// QueryClient or network. Rendered with MemoryRouter because rows use Link.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import type { AttentionItem, AttentionResponse } from '../src/client/lib/types';

// ---------------------------------------------------------------------------
// Mutable mock state — the component destructures data/isLoading/error.
// ---------------------------------------------------------------------------

interface AttentionQueryMock {
  data: AttentionResponse | null;
  isLoading: boolean;
  error: Error | null;
}

const attentionMock: AttentionQueryMock = {
  data: null,
  isLoading: false,
  error: null,
};

mock.module(path.resolve('src/client/hooks/useAttention'), () => ({
  useAttention: () => attentionMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AttentionItem> & { taskName: string }): AttentionItem {
  const { taskName, project = 'proj-a' } = overrides;
  return {
    project,
    taskName,
    title: overrides.title ?? taskName,
    type: overrides.type ?? 'BUILD',
    agent: overrides.agent ?? 'builder',
    phase: overrides.phase ?? 'awaiting-human',
    reason: overrides.reason ?? 'Review and approve',
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
    since: overrides.since ?? '2024-01-01T00:00:00Z',
    url:
      overrides.url ??
      `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(taskName)}`,
  };
}

function response(items: AttentionItem[]): AttentionResponse {
  return { items, count: items.length, generatedAt: '2024-04-01T00:00:00Z' };
}

/** Title links in document order (ignores the project chip/group links). */
function renderedTitles(): string[] {
  return Array.from(document.querySelectorAll('a[href*="task="]')).map((a) => a.textContent ?? '');
}

async function renderPage() {
  const { MemoryRouter } = await import('react-router-dom');
  const { default: AttentionPage } = await import('../src/client/pages/AttentionPage');
  return render(React.createElement(MemoryRouter, null, React.createElement(AttentionPage)));
}

function resetMocks() {
  attentionMock.data = null;
  attentionMock.isLoading = false;
  attentionMock.error = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AttentionPage', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows a loading state before the first response', async () => {
    attentionMock.isLoading = true;

    await renderPage();

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows an error state when the query fails', async () => {
    attentionMock.error = new Error('kube unavailable');

    await renderPage();

    expect(screen.getByText('Failed to load attention items.')).toBeTruthy();
  });

  it('shows the empty state when nothing needs attention', async () => {
    attentionMock.data = response([]);

    await renderPage();

    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy();
  });

  it('lists items oldest-first even when the response arrives unsorted', async () => {
    attentionMock.data = response([
      makeItem({ taskName: 'newest', title: 'Newest', since: '2024-03-01T00:00:00Z' }),
      makeItem({ taskName: 'oldest', title: 'Oldest', since: '2024-01-01T00:00:00Z' }),
      makeItem({ taskName: 'middle', title: 'Middle', since: '2024-02-01T00:00:00Z' }),
    ]);

    await renderPage();

    expect(renderedTitles()).toEqual(['Oldest', 'Middle', 'Newest']);
  });

  it('links each row to the correct board task (same URL shape as push)', async () => {
    attentionMock.data = response([
      makeItem({
        taskName: 'proj-build-1',
        project: 'proj-a',
        title: 'Answer me',
        phase: 'waiting-for-input',
        reason: 'Answer agent question',
      }),
      makeItem({
        taskName: 'proj-plan-2',
        project: 'other proj',
        title: 'Review the plan',
        type: 'PLAN',
        phase: 'awaiting-human',
        reason: 'Review plan and approve',
      }),
    ]);

    await renderPage();

    const taskLink = screen.getByRole('link', { name: 'Answer me' });
    expect(taskLink.getAttribute('href')).toBe('/projects/proj-a/board?task=proj-build-1');

    const otherLink = screen.getByRole('link', { name: 'Review the plan' });
    expect(otherLink.getAttribute('href')).toBe(
      `/projects/${encodeURIComponent('other proj')}/board?task=proj-plan-2`,
    );
  });

  it('renders a group header per project that links to that board', async () => {
    attentionMock.data = response([
      makeItem({
        taskName: 'a-1',
        project: 'proj-a',
        title: 'A one',
        since: '2024-01-01T00:00:00Z',
      }),
      makeItem({
        taskName: 'b-1',
        project: 'proj-b',
        title: 'B one',
        since: '2024-02-01T00:00:00Z',
      }),
    ]);

    await renderPage();

    const boardLinks = screen
      .getAllByRole('link', { name: 'proj-a' })
      .map((el) => el.getAttribute('href'));
    expect(boardLinks).toContain('/projects/proj-a/board');
    expect(screen.getAllByRole('link', { name: 'proj-b' }).length).toBeGreaterThan(0);
  });

  it('renders reason, agent and the phase tone for each row', async () => {
    attentionMock.data = response([
      makeItem({
        taskName: 'broken',
        project: 'proj-a',
        title: 'Broken build',
        phase: 'failed',
        reason: 'Failed — retry or abandon',
        agent: 'builder',
        detail: 'tests failed',
      }),
    ]);

    await renderPage();

    const reason = screen.getByText('Failed — retry or abandon');
    expect(reason.className).toContain('text-phase-failed');
    expect(screen.getByText('builder')).toBeTruthy();
    expect(screen.getByText('tests failed')).toBeTruthy();
  });
});
