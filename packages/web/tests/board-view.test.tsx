// board-view.test.tsx — BoardView header container responsive spacing tests.
//
// Uses @testing-library/react with happy-dom DOM environment. Mocks heavy
// dependencies (react-router-dom, @tanstack/react-query, hooks, child
// components) to isolate the header container class assertion.
//
// Regression guard: the header wrapper must always carry both mobile and
// desktop Tailwind responsive spacing classes so the compact mobile header
// reclaims vertical space without manual viewport branching.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

const isMobileMock: { current: boolean } = { current: false };

const mockBoardData = {
  settings: {
    agents: [{ name: 'agent-a' }],
    maxParallel: 2,
    phase: 'Active',
  },
  columns: { backlog: [], ready: [], running: [], done: [] },
  status: { managerMetrics: null, findings: [] },
  authWarning: undefined,
  approvals: [],
};

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// ---------------------------------------------------------------------------

// Mock hooks before importing the component
mock.module(path.resolve('src/client/hooks/use-mobile'), () => ({
  useIsMobile: () => isMobileMock.current,
}));

mock.module(path.resolve('src/client/hooks/useBoardEvents'), () => ({
  useBoardEvents: () => ({ connected: true, eventTick: 0 }),
}));

mock.module(path.resolve('src/client/hooks/useBoardNotifications'), () => ({
  useBoardNotifications: () => {},
}));

// Mock react-router-dom to avoid Router context + route param parsing.
// useSearchParams returns a tuple matching the real API.
mock.module('react-router-dom', () => ({
  useParams: () => ({ name: 'test-project' }),
  useSearchParams: () => {
    const sp = new URLSearchParams();
    return [sp, () => {}];
  },
  Link: 'a',
  default: {},
}));

// Mock @tanstack/react-query to avoid real query infrastructure.
mock.module('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockBoardData, isLoading: false, error: null }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {} }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

// Mock API functions so no real network calls are attempted.
mock.module(path.resolve('src/client/lib/api'), () => ({
  fetchBoard: async () => mockBoardData,
  deleteBoardTask: async () => {},
  retryEscalatedTask: async () => {},
  approveTask: async () => {},
  requestChangesTask: async () => {},
}));

// Mock code-server URL derivation (returns undefined in test environment).
mock.module(path.resolve('src/client/lib/code-server-url'), () => ({
  deriveIdeUrl: () => undefined,
}));

// Mock child components to avoid deep rendering and Radix/complex deps.
// Each maps to a plain HTML element so the parent structure stays intact.
mock.module(path.resolve('src/client/components/board/BoardHeader'), () => ({
  BoardHeader: 'div',
  default: {},
}));

mock.module(path.resolve('src/client/components/board/FindingsPanel'), () => ({
  default: 'div',
  FindingsPanel: 'div',
}));

mock.module(path.resolve('src/client/components/board/TaskDetailPanel'), () => ({
  TaskDetailPanel: 'div',
  TaskDetailEmpty: 'div',
}));

mock.module(path.resolve('src/client/components/board/TaskListPanel'), () => ({
  default: 'div',
  TaskListPanel: 'div',
}));

mock.module(path.resolve('src/client/components/board/AddTaskForm'), () => ({
  AddTaskForm: 'div',
  default: {},
}));

// Mock Radix Sheet UI components as plain divs.
mock.module(path.resolve('src/client/components/ui/sheet'), () => ({
  Sheet: 'div',
  SheetContent: 'div',
  SheetDescription: 'div',
  SheetHeader: 'div',
  SheetTitle: 'div',
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function renderBoardView() {
  const { default: BoardView } = await import('../src/client/components/BoardView');
  return render(React.createElement(BoardView));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BoardView header container responsive classes', () => {
  afterEach(cleanup);

  it('renders mobile spacing classes (px-3 pt-2 pb-2)', async () => {
    await renderBoardView();
    const container = screen.getByTestId('board-header-container');
    expect(container.className).toContain('px-3');
    expect(container.className).toContain('pt-2');
    expect(container.className).toContain('pb-2');
  });

  it('renders desktop responsive override classes (md:px-4 md:pt-4 md:pb-3)', async () => {
    await renderBoardView();
    const container = screen.getByTestId('board-header-container');
    expect(container.className).toContain('md:px-4');
    expect(container.className).toContain('md:pt-4');
    expect(container.className).toContain('md:pb-3');
  });

  it('renders shrink-0 and border utilities on the wrapper', async () => {
    await renderBoardView();
    const container = screen.getByTestId('board-header-container');
    expect(container.className).toContain('shrink-0');
    expect(container.className).toContain('border-b');
    expect(container.className).toContain('border-border');
  });
});
