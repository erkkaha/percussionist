// attention-page.test.tsx — Component tests for the global "Needs attention"
// inbox page.
//
// Uses @testing-library/react with the happy-dom environment from
// tests/setup.ts. `useAttention` is module-mocked so the query states (loading,
// error, empty, populated) are driven deterministically without a network. A
// real QueryClient is mounted because the page's inline quick actions use
// useMutation/useQueryClient; the action endpoints in lib/api are mocked so no
// request leaves the test. Rendered with MemoryRouter because rows use Link.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
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
// Action endpoint mocks. Spread the real module (captured before the mock
// below takes effect) so any other export a transitively imported module needs
// stays defined, then override just the five actions the page can trigger.
// ---------------------------------------------------------------------------

const approveTask = mock(async (_project: string, _taskName: string) => {});
const requestChangesTask = mock(
  async (_project: string, _taskName: string, _comment: string) => {},
);
const retryEscalatedTask = mock(async (_project: string, _taskName: string) => {});
const replyToRun = mock(async (_runName: string, _message: string) => {});
const answerTask = mock(async (_project: string, _taskName: string, _answer: string) => {});

mock.module(path.resolve('src/client/lib/api'), () => ({
  ...realApi,
  approveTask,
  requestChangesTask,
  retryEscalatedTask,
  replyToRun,
  answerTask,
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
    ...(overrides.workerRunName !== undefined ? { workerRunName: overrides.workerRunName } : {}),
    since: overrides.since ?? '2024-01-01T00:00:00Z',
    url:
      overrides.url ??
      `/projects/${encodeURIComponent(project)}/board?task=${encodeURIComponent(taskName)}`,
  };
}

function response(items: AttentionItem[]): AttentionResponse {
  return { items, count: items.length, generatedAt: '2024-04-01T00:00:00Z' };
}

/** Title links in document order (ignores the project chip/group/Open links). */
function renderedTitles(): string[] {
  return Array.from(document.querySelectorAll('a[href*="task="]'))
    .filter((a) => a.textContent !== 'Open')
    .map((a) => a.textContent ?? '');
}

async function renderPage(queryClient: QueryClient) {
  const { MemoryRouter } = await import('react-router-dom');
  const { default: AttentionPage } = await import('../src/client/pages/AttentionPage');
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(MemoryRouter, null, React.createElement(AttentionPage)),
    ),
  );
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Recorded `invalidateQueries` filters, serialized for stable comparison. */
function invalidatedKeys(spy: ReturnType<typeof spyOn>): string[] {
  return (spy.mock.calls as Array<[unknown]>).map((call) =>
    JSON.stringify((call[0] as { queryKey?: unknown } | undefined)?.queryKey),
  );
}

function resetMocks() {
  attentionMock.data = null;
  attentionMock.isLoading = false;
  attentionMock.error = null;
  approveTask.mockClear();
  requestChangesTask.mockClear();
  retryEscalatedTask.mockClear();
  replyToRun.mockClear();
  answerTask.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AttentionPage', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows a loading state before the first response', async () => {
    attentionMock.isLoading = true;

    await renderPage(makeQueryClient());

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows an error state when the query fails', async () => {
    attentionMock.error = new Error('kube unavailable');

    await renderPage(makeQueryClient());

    expect(screen.getByText('Failed to load attention items.')).toBeTruthy();
  });

  it('shows the empty state when nothing needs attention', async () => {
    attentionMock.data = response([]);

    await renderPage(makeQueryClient());

    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy();
  });

  it('lists items oldest-first even when the response arrives unsorted', async () => {
    attentionMock.data = response([
      makeItem({ taskName: 'newest', title: 'Newest', since: '2024-03-01T00:00:00Z' }),
      makeItem({ taskName: 'oldest', title: 'Oldest', since: '2024-01-01T00:00:00Z' }),
      makeItem({ taskName: 'middle', title: 'Middle', since: '2024-02-01T00:00:00Z' }),
    ]);

    await renderPage(makeQueryClient());

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

    await renderPage(makeQueryClient());

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

    await renderPage(makeQueryClient());

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

    await renderPage(makeQueryClient());

    const reason = screen.getByText('Failed — retry or abandon');
    expect(reason.className).toContain('text-phase-failed');
    expect(screen.getByText('builder')).toBeTruthy();
    expect(screen.getByText('tests failed')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Inline quick actions
// ---------------------------------------------------------------------------

describe('AttentionPage inline actions', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows Approve + Request changes for an awaiting-human BUILD task', async () => {
    attentionMock.data = response([makeItem({ taskName: 'b-1', type: 'BUILD' })]);

    await renderPage(makeQueryClient());

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows Approve but not Request changes for an awaiting-human PLAN task', async () => {
    attentionMock.data = response([makeItem({ taskName: 'p-1', type: 'PLAN' })]);

    await renderPage(makeQueryClient());

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('shows Answer only for a waiting-for-input task', async () => {
    attentionMock.data = response([
      makeItem({ taskName: 'w-1', phase: 'waiting-for-input', workerRunName: 'run-1' }),
    ]);

    await renderPage(makeQueryClient());

    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows Retry only for a failed task', async () => {
    attentionMock.data = response([makeItem({ taskName: 'f-1', phase: 'failed' })]);

    await renderPage(makeQueryClient());

    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('approves in a single click and invalidates attention + board', async () => {
    attentionMock.data = response([makeItem({ taskName: 'b-1', project: 'proj-a' })]);
    const queryClient = makeQueryClient();
    const invalidate = spyOn(queryClient, 'invalidateQueries');

    await renderPage(queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approveTask).toHaveBeenCalledWith('proj-a', 'b-1'));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(['attention']));
    expect(keys).toContain(JSON.stringify(['board', 'proj-a']));
  });

  it('requires non-empty feedback before requesting changes', async () => {
    attentionMock.data = response([makeItem({ taskName: 'b-1' })]);
    const queryClient = makeQueryClient();
    const invalidate = spyOn(queryClient, 'invalidateQueries');

    await renderPage(queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    // Submit starts disabled with no feedback.
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(requestChangesTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('Describe required changes…'), {
      target: { value: '  Please add tests  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(requestChangesTask).toHaveBeenCalledWith('proj-a', 'b-1', 'Please add tests'),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(['attention']));
    expect(keys).toContain(JSON.stringify(['board', 'proj-a']));
  });

  it('answers with reply-to-run before the annotation and invalidates', async () => {
    attentionMock.data = response([
      makeItem({ taskName: 'w-1', phase: 'waiting-for-input', workerRunName: 'run-42' }),
    ]);
    const queryClient = makeQueryClient();
    const invalidate = spyOn(queryClient, 'invalidateQueries');
    const callOrder: string[] = [];
    replyToRun.mockImplementation(async () => {
      callOrder.push('reply');
    });
    answerTask.mockImplementation(async () => {
      callOrder.push('answer');
    });

    await renderPage(queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));

    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Type your answer for the agent…'), {
      target: { value: 'Use Postgres' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(answerTask).toHaveBeenCalledWith('proj-a', 'w-1', 'Use Postgres'));
    expect(replyToRun).toHaveBeenCalledWith('run-42', 'Use Postgres');
    expect(callOrder).toEqual(['reply', 'answer']);
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(['attention']));
    expect(keys).toContain(JSON.stringify(['board', 'proj-a']));
  });

  it('retries a failed task in a single click and invalidates', async () => {
    attentionMock.data = response([makeItem({ taskName: 'f-1', phase: 'failed' })]);
    const queryClient = makeQueryClient();
    const invalidate = spyOn(queryClient, 'invalidateQueries');

    await renderPage(queryClient);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(retryEscalatedTask).toHaveBeenCalledWith('proj-a', 'f-1'));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(['attention']));
    expect(keys).toContain(JSON.stringify(['board', 'proj-a']));
  });

  it('surfaces a failed action inline', async () => {
    attentionMock.data = response([makeItem({ taskName: 'b-1' })]);
    approveTask.mockImplementationOnce(async () => {
      throw new Error('approve failed');
    });

    await renderPage(makeQueryClient());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('approve failed')).toBeTruthy();
  });
});
