// app-sidebar.test.tsx — Regression tests for the per-project color chip.
//
// Uses @testing-library/react with happy-dom DOM environment. Mocks the
// project/data hooks and auth/update-status API calls to avoid real network
// and SSE plumbing, wraps the sidebar in MemoryRouter + QueryClientProvider +
// SidebarProvider (AppSidebar and its children read sidebar state via
// useSidebar()), and asserts two projects with distinct names/colors render
// visibly distinct chips in both expanded and collapsed sidebar states.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

const projectsMock: { data: Array<Record<string, unknown>> | undefined } = {
  data: undefined,
};

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// ---------------------------------------------------------------------------

mock.module(path.resolve('src/client/hooks/useProjects'), () => ({
  useProjects: () => ({ data: projectsMock.data }),
}));

mock.module(path.resolve('src/client/hooks/useProjectsEvents'), () => ({
  useProjectsEvents: () => ({ connected: true, eventTick: 0 }),
}));

mock.module(path.resolve('src/client/lib/auth'), () => ({
  useAuth: () => ({ isAuthenticated: false, user: null, logout: () => {} }),
  authHeaders: () => ({}),
}));

mock.module(path.resolve('src/client/lib/api'), () => ({
  fetchUpdateStatus: async () => ({ updateAvailable: false }),
  fetchSettings: async () => ({ metadata: { name: 'default' }, spec: {} }),
}));

// ui/sidebar.tsx (and its transitive deps) resolve `@/...` path aliases that
// bun's module loader does not natively support (that alias only exists in
// tsconfig.client.json / vite.config.ts, not a bunfig.toml). Stub the leaf
// dependencies as plain passthrough elements — same approach already used by
// usage-bar-component.test.tsx — while leaving sidebar.tsx itself real so the
// actual SidebarProvider/Sidebar collapse-state logic runs.
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

// __APP_VERSION__ is injected by vite's `define` at build time (vite.config.ts);
// bun test doesn't run through vite, so provide it directly.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_A: Record<string, unknown> = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: 'apollo', creationTimestamp: new Date().toISOString() },
  spec: { source: { local: true }, agents: [], maxParallel: 2, displayName: 'Apollo' },
};

const PROJECT_B: Record<string, unknown> = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Project',
  metadata: { name: 'boreas', creationTimestamp: new Date().toISOString() },
  spec: { source: { local: true }, agents: [], maxParallel: 2, displayName: 'Boreas' },
};

async function renderSidebar(defaultOpen: boolean) {
  const { MemoryRouter } = await import('react-router-dom');
  const { SidebarProvider } = await import('../src/client/components/ui/sidebar');
  const { AppSidebar } = await import('../src/client/components/app-sidebar');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(SidebarProvider, { defaultOpen }, React.createElement(AppSidebar)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppSidebar project color chips', () => {
  beforeEach(() => {
    projectsMock.data = [PROJECT_A, PROJECT_B];
    localStorage.clear();
  });
  afterEach(cleanup);

  it('renders visibly distinct chips (initial + color) for two projects (expanded)', async () => {
    await renderSidebar(true);

    const apolloInitial = screen.getByText('A', { selector: 'span' });
    const boreasInitial = screen.getByText('B', { selector: 'span' });
    expect(apolloInitial).toBeTruthy();
    expect(boreasInitial).toBeTruthy();

    const apolloColor = apolloInitial.style.color;
    const boreasColor = boreasInitial.style.color;
    expect(apolloColor).toBeTruthy();
    expect(boreasColor).toBeTruthy();
    expect(apolloColor).not.toBe(boreasColor);
  });

  it('renders the same distinct chips when the sidebar is collapsed', async () => {
    await renderSidebar(false);

    const apolloInitial = screen.getByText('A', { selector: 'span' });
    const boreasInitial = screen.getByText('B', { selector: 'span' });
    expect(apolloInitial.style.color).not.toBe(boreasInitial.style.color);
  });

  it('uses an explicit spec.color directly instead of the hashed fallback', async () => {
    projectsMock.data = [
      {
        ...PROJECT_A,
        spec: { ...(PROJECT_A.spec as object), color: '#123456' },
      },
    ];
    await renderSidebar(true);

    const chip = screen.getByText('A', { selector: 'span' });
    expect(chip.style.color.toLowerCase()).toBe('#123456');
  });

  it('keeps the tooltip prop wired to the display name in collapsed mode', async () => {
    const { container } = await renderSidebar(false);

    // TooltipContent (mocked as a passthrough <div>, retaining its `side`
    // prop as an inert DOM attribute) still receives the project display
    // name as its child — this guards against the tooltip prop being
    // dropped when swapping the Folder icon for the color chip.
    const tooltipContents = Array.from(container.querySelectorAll('[side="right"]'));
    const tooltipTexts = tooltipContents.map((el) => el.textContent);
    expect(tooltipTexts).toContain('Apollo');
    expect(tooltipTexts).toContain('Boreas');
  });
});
