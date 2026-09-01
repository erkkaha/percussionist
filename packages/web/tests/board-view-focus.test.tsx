// board-view-focus.test.tsx — focus-mode layout wiring in BoardView.
//
// Asserts that the single focus-mode toggle (owned by TaskDetailPanel, but
// here kept REAL so we exercise the real onToggleFocus → detailFocused path)
// drives two layout effects in BoardView:
//   1. The desktop task-list wrapper gains `md:hidden` when focus is on, and
//      loses it when off.
//   2. The mobile detail SheetContent drops its `sm:max-w-lg` cap in favour of
//      `max-w-none` when focus is on.
//
// Sheet / SheetContent are mocked as passthrough divs that FORWARD className
// (so the forwarded className is asserted) and tag themselves with a
// data-testid so the detail Sheet can be located unambiguously among the
// several SheetContent elements BoardView renders. TaskDetailPanel is kept
// REAL (per the plan) so the toggle button actually flips BoardView state;
// its subtree hooks (useTaskRuns / useTaskDiff / fetchPlan) are mocked so no
// network is hit.
//
// All mocks are module-level and run under `bun test --isolate`, so nothing
// leaks into other suites (in particular TaskDetailPanel is not stubbed here,
// and this file does not stub a module that is the subject of another suite).

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import * as realApi from '../src/client/lib/api';
import type { Task } from '../src/client/lib/types';

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

const isMobileMock: { current: boolean } = { current: false };

const codeServerMock: { current: { enabled: boolean } | undefined } = {
  current: { enabled: false },
};

const TASK_NAME = 'proj-build-1';

const mockBoardData = {
  settings: {
    agents: [{ name: 'builder' }],
    maxParallel: 2,
    phase: 'Active',
    integrationMode: 'auto-merge',
    repoWebUrl: undefined,
    get codeServer() {
      return codeServerMock.current;
    },
    get color() {
      return undefined;
    },
  },
  columns: {
    backlog: [makeBoardTask()],
    ready: [] as Task[],
    running: [] as Task[],
    done: [] as Task[],
  },
  status: { managerMetrics: null, findings: [] },
  authWarning: undefined,
  approvals: [],
};

function makeBoardTask(): Task {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Task',
    metadata: { name: TASK_NAME, creationTimestamp: '2026-01-01T00:00:00Z' },
    spec: {
      projectRef: 'test-project',
      type: 'BUILD',
      title: 'Build thing',
      agent: 'builder',
      description: 'A minimal BUILD task used for the focus-mode layout test.',
    },
    status: { phase: 'done' },
  } as unknown as Task;
}

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/use-mobile'), () => ({
  useIsMobile: () => isMobileMock.current,
}));

mock.module(path.resolve('src/client/hooks/useBoardEvents'), () => ({
  useBoardEvents: () => ({ connected: true, eventTick: 0 }),
}));

mock.module(path.resolve('src/client/hooks/useBoardNotifications'), () => ({
  useBoardNotifications: () => {},
}));

// OverviewContent (rendered by the real TaskDetailPanel) calls useTaskRuns;
// DiffContent calls useTaskDiff. Mock both so the focus toggle can flip
// BoardView state without any network.
mock.module(path.resolve('src/client/hooks/useTaskRuns'), () => ({
  useTaskRuns: () => ({ data: [] as unknown[] }),
}));

mock.module(path.resolve('src/client/hooks/useTaskDiff'), () => ({
  useTaskDiff: () => ({
    data: { files: [] as unknown[], commits: [] as unknown[], findings: [] as unknown[] },
    status: 'success',
    fetchStatus: 'idle',
    error: null,
  }),
}));

// Mock API functions so no real network calls are attempted. fetchBoard
// supplies the selected task; fetchPlan is overridden for safety even though
// the BUILD overview tab never mounts PlanContent.
mock.module(path.resolve('src/client/lib/api'), () => ({
  ...realApi,
  fetchBoard: async () => mockBoardData,
  fetchPlan: async () => ({ content: '', taskId: TASK_NAME, project: 'test-project' }),
  deleteBoardTask: async () => {},
  approveTask: async () => {},
  requestChangesTask: async () => {},
  retryEscalatedTask: async () => {},
  moveTask: async () => {},
  replyToRun: async () => {},
  answerTask: async () => {},
}));

mock.module(path.resolve('src/client/lib/code-server-url'), () => ({
  deriveIdeUrl: () => 'http://ide-test-project.example.com',
  ideUrl: () => 'http://ide-test-project.example.com',
  useIdeUrlTemplate: () => ({ template: undefined, isLoading: false }),
}));

// FindingsPanel + AddTaskForm are stubbed (neither is the subject of this
// suite). They render empty so their parent SheetContent elements stay
// distinguishable from the detail SheetContent, which contains the real
// TaskDetailPanel toggle button.
mock.module(path.resolve('src/client/components/board/FindingsPanel'), () => ({
  default: () => React.createElement('div'),
  FindingsPanel: () => React.createElement('div'),
}));

mock.module(path.resolve('src/client/components/board/AddTaskForm'), () => ({
  AddTaskForm: () => React.createElement('div'),
  default: {},
}));

// TaskListPanel is stubbed with a data-testid so the list wrapper (its direct
// parent) can be located and its className asserted.
mock.module(path.resolve('src/client/components/board/TaskListPanel'), () => ({
  default: () => React.createElement('div', { 'data-testid': 'task-list-panel' }),
  TaskListPanel: () => React.createElement('div', { 'data-testid': 'task-list-panel' }),
}));

// TaskDetailPanel is intentionally NOT mocked — kept real so the focus toggle
// button actually flips BoardView's detailFocused state (the whole point of
// this layout test).

// Sheet / SheetContent mocked as passthrough divs that forward className and
// tag themselves with a data-testid. The detail SheetContent is located by
// walking up from the toggle button to the enclosing data-testid="sheet-content".
mock.module(path.resolve('src/client/components/ui/sheet'), () => ({
  Sheet: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  SheetContent: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    React.createElement('div', { className, 'data-testid': 'sheet-content' }, children),
  SheetDescription: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  SheetHeader: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  SheetTitle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function renderBoardWithSelection() {
  const { default: BoardView } = await import('../src/client/components/BoardView');
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Selecting a task is driven by the ?task= URL param (useSearchParams).
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/projects/test-project/board?task=${TASK_NAME}`] },
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/projects/:name/board',
            element: React.createElement(BoardView),
          }),
        ),
      ),
    ),
  );
}

// The mobile detail SheetContent is the only SheetContent that contains the
// TaskDetailPanel focus toggle (the desktop detail panel is not inside a Sheet,
// so its toggle button has no sheet-content ancestor). The toggle may appear
// under either label depending on focus state — search both. The board is
// already loaded (caller awaited a board element) by the time this runs, and
// the click that flips focus flushes a synchronous re-render, so a synchronous
// query of both labels is sufficient.
function getMobileDetailSheet(): HTMLElement {
  const labels = ['Expand to full width', 'Collapse task list'];
  for (const label of labels) {
    const buttons = screen.queryAllByLabelText(label) as HTMLElement[];
    for (const b of buttons) {
      const sheet = b.closest('[data-testid="sheet-content"]');
      if (sheet) return sheet as HTMLElement;
    }
  }
  throw new Error('could not locate mobile detail SheetContent');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView focus-mode layout', () => {
  afterEach(cleanup);

  it('does NOT hide the list and keeps the mobile Sheet capped before focus', async () => {
    await renderBoardWithSelection();

    const listWrapper = (await screen.findByTestId('task-list-panel')).parentElement as HTMLElement;
    expect(listWrapper.className).not.toContain('md:hidden');

    const sheet = await getMobileDetailSheet();
    expect(sheet.className).toContain('sm:max-w-lg');
    expect(sheet.className).not.toContain('max-w-none');
  });

  it('hides the list and makes the mobile Sheet full-bleed after focus', async () => {
    await renderBoardWithSelection();

    // Flip focus via the real TaskDetailPanel toggle (present on both the
    // desktop panel and the mobile Sheet; either calls the same handler).
    const toggle = (await screen.findAllByLabelText('Expand to full width'))[0] as HTMLElement;
    fireEvent.click(toggle);

    const listWrapper = (await screen.findByTestId('task-list-panel')).parentElement as HTMLElement;
    expect(listWrapper.className).toContain('md:hidden');

    const sheet = await getMobileDetailSheet();
    expect(sheet.className).toContain('max-w-none');
    expect(sheet.className).not.toContain('sm:max-w-lg');
  });
});
