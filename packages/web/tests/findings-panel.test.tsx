// findings-panel.test.tsx — FindingsPanel close/reopen action controls and the
// "Hide closed" toggle.
//
// Uses @testing-library/react with the happy-dom environment configured in
// tests/setup.ts. The findings mutation hook is mocked at the module level so
// the test exercises the panel's wiring (which action maps to which status) plus
// the hide-closed filter, without standing up react-query or the network. The
// mock.module stub is process-global but --isolate scopes it to this file.
//
// Mirrors the structure of board-header.test.tsx (render helper + describe
// blocks per feature). The panel renders its own <button> elements (no Radix UI
// components), so no component mocks are required.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { Finding } from '../src/client/lib/types';

// ---------------------------------------------------------------------------
// Mutable mock state for the findings mutation hook.
// ---------------------------------------------------------------------------

const updateFindingState = {
  mutateCalls: [] as Array<{ id: string; req: { status?: string } }>,
  isPending: false,
};

mock.module(resolve(import.meta.dir, '..', 'src/client/hooks/useFindings'), () => ({
  useUpdateFinding: (_project: string | undefined) => ({
    mutate: (args: { id: string; req: { status?: string } }) => {
      updateFindingState.mutateCalls.push(args);
    },
    isPending: updateFindingState.isPending,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f-default',
    title: 'Default finding',
    description: 'something is off',
    severity: 'high',
    category: 'bug',
    source: { project: 'test-project' },
    status: 'triaged',
    dedupKey: 'dedup-default',
    occurrences: 1,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Finding;
}

let FindingsPanel: React.ComponentType<{
  findings: Finding[];
  projectName: string;
  onClose?: () => void;
}>;

beforeEach(async () => {
  updateFindingState.mutateCalls = [];
  updateFindingState.isPending = false;
  if (!FindingsPanel) {
    const mod = await import('../src/client/components/board/FindingsPanel');
    FindingsPanel = mod.FindingsPanel;
  }
});

afterEach(() => {
  cleanup();
});

async function renderPanel(findings: Finding[], projectName = 'test-project') {
  return render(React.createElement(FindingsPanel, { findings, projectName }));
}

// ---------------------------------------------------------------------------
// Action controls
// ---------------------------------------------------------------------------

describe('FindingsPanel action buttons', () => {
  it("shows Resolve / Won't Fix / Duplicate for an open finding and closes it as resolved", async () => {
    await renderPanel([makeFinding({ id: 'f-open', status: 'triaged', title: 'Open bug' })]);

    // Expand the finding to reveal the actions row.
    fireEvent.click(screen.getByText('Open bug'));

    expect(screen.getByText('Resolve')).toBeTruthy();
    expect(screen.getByText("Won't Fix")).toBeTruthy();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.queryByText('Reopen')).toBeNull();

    fireEvent.click(screen.getByText('Resolve'));

    expect(updateFindingState.mutateCalls).toHaveLength(1);
    expect(updateFindingState.mutateCalls[0]).toEqual({
      id: 'f-open',
      req: { status: 'resolved' },
    });
  });

  it('closes as wontfix', async () => {
    await renderPanel([makeFinding({ id: 'f-wf', status: 'new', title: 'Wontfix bug' })]);
    fireEvent.click(screen.getByText('Wontfix bug'));
    fireEvent.click(screen.getByText("Won't Fix"));
    expect(updateFindingState.mutateCalls[0]).toEqual({ id: 'f-wf', req: { status: 'wontfix' } });
  });

  it('closes as duplicate', async () => {
    await renderPanel([makeFinding({ id: 'f-dup', status: 'in-progress', title: 'Dup bug' })]);
    fireEvent.click(screen.getByText('Dup bug'));
    fireEvent.click(screen.getByText('Duplicate'));
    expect(updateFindingState.mutateCalls[0]).toEqual({
      id: 'f-dup',
      req: { status: 'duplicate' },
    });
  });

  it('shows Reopen for a closed finding', async () => {
    await renderPanel([makeFinding({ id: 'f-closed', status: 'resolved', title: 'Closed bug' })]);

    fireEvent.click(screen.getByText('Closed bug'));

    expect(screen.getByText('Reopen')).toBeTruthy();
    expect(screen.queryByText('Resolve')).toBeNull();

    fireEvent.click(screen.getByText('Reopen'));
    expect(updateFindingState.mutateCalls[0]).toEqual({
      id: 'f-closed',
      req: { status: 'triaged' },
    });
  });

  it('disables the action buttons while the mutation is pending', async () => {
    updateFindingState.isPending = true;
    await renderPanel([makeFinding({ id: 'f-pend', status: 'triaged', title: 'Pending bug' })]);

    fireEvent.click(screen.getByText('Pending bug'));
    const resolveBtn = screen.getByText('Resolve') as HTMLButtonElement;
    expect(resolveBtn.disabled).toBe(true);
    updateFindingState.isPending = false;
  });
});

// ---------------------------------------------------------------------------
// Hide closed toggle
// ---------------------------------------------------------------------------

describe('FindingsPanel "Hide closed" toggle', () => {
  it('filters out closed findings when toggled and restores them when untoggled', async () => {
    const open = makeFinding({ id: 'o', status: 'triaged', title: 'Open item' });
    const closed = makeFinding({ id: 'c', status: 'wontfix', title: 'Closed item' });
    await renderPanel([open, closed]);

    // Both visible initially.
    expect(screen.getByText('Open item')).toBeTruthy();
    expect(screen.getByText('Closed item')).toBeTruthy();

    // Toggle on.
    fireEvent.click(screen.getByText('Hide closed'));
    expect(screen.getByText('Open item')).toBeTruthy();
    expect(screen.queryByText('Closed item')).toBeNull();

    // Toggle off again.
    fireEvent.click(screen.getByText('Show closed'));
    expect(screen.getByText('Closed item')).toBeTruthy();
  });

  it('does not remove open findings when hide-closed is on with only open findings', async () => {
    await renderPanel([makeFinding({ id: 'o', status: 'triaged', title: 'Only open' })]);
    fireEvent.click(screen.getByText('Hide closed'));
    expect(screen.getByText('Only open')).toBeTruthy();
  });
});
