// projects-page.test.tsx — Regression tests for headerless add-project CTA.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks useProjects and useProjectsEvents hooks to avoid
// SSE/query timing flakiness, and wraps components in MemoryRouter +
// QueryClientProvider for react-router-dom and @tanstack/react-query context.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state — changes propagate through captured object references
// ---------------------------------------------------------------------------

const projectsMock: {
  data: Array<Record<string, unknown>> | null;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
} = {
  data: null,
  error: null,
  isLoading: false,
  isFetching: false,
};

const eventsMock: { connected: boolean; eventTick: number } = {
  connected: true,
  eventTick: 0,
};

// ---------------------------------------------------------------------------
// Module mocks — intercept imports at the module resolution level
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useProjects'), () => ({
  useProjects: () => projectsMock,
}));

mock.module(path.resolve('src/client/hooks/useProjectsEvents'), () => ({
  useProjectsEvents: () => eventsMock,
}));

// Mock Button as a native <button> to avoid radix Slot / cva complexity
mock.module(path.resolve('src/client/components/ui/button'), () => ({
  Button: 'button',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  projectsMock.data = null;
  projectsMock.error = null;
  projectsMock.isLoading = false;
  projectsMock.isFetching = false;
  eventsMock.connected = true;
  eventsMock.eventTick = 0;
}

const MOCK_PROJECT: Record<string, unknown> = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: 'test-project', creationTimestamp: new Date().toISOString() },
  spec: { source: { local: true }, agents: [], maxParallel: 2 },
};

async function renderWithProviders(element: React.ReactElement) {
  const { MemoryRouter } = await import('react-router-dom');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectsPage create-CTA visibility', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('header mode (showHeader=true) includes "+ New Project" CTA', async () => {
    projectsMock.data = [MOCK_PROJECT];
    const { default: ProjectsPage } = await import('../src/client/components/ProjectsPage');

    await renderWithProviders(React.createElement(ProjectsPage, { showHeader: true }));

    expect(screen.getByText('+ New Project')).toBeTruthy();
  });

  it('headerless mode (showHeader=false) with non-empty projects still includes a create CTA', async () => {
    projectsMock.data = [MOCK_PROJECT];
    const { default: ProjectsPage } = await import('../src/client/components/ProjectsPage');

    await renderWithProviders(React.createElement(ProjectsPage, { showHeader: false }));

    expect(screen.getByText('+ New Project')).toBeTruthy();
  });

  it('headerless mode (showHeader=false) with empty list still keeps create path accessible', async () => {
    projectsMock.data = [];
    const { default: ProjectsPage } = await import('../src/client/components/ProjectsPage');

    await renderWithProviders(React.createElement(ProjectsPage, { showHeader: false }));

    // Empty state renders a "Create one" link
    expect(screen.getByText('Create one')).toBeTruthy();
  });

  it('headerless mode respects showCreateAction=false (no CTA when opted out)', async () => {
    projectsMock.data = [MOCK_PROJECT];
    const { default: ProjectsPage } = await import('../src/client/components/ProjectsPage');

    await renderWithProviders(
      React.createElement(ProjectsPage, { showHeader: false, showCreateAction: false }),
    );

    expect(screen.queryByText('+ New Project')).toBeNull();
  });
});
