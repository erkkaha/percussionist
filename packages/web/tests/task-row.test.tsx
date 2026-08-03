// task-row.test.tsx — Regression test for the "Inject task into chat" button
// in TaskRow: the tablet fix (hover-capable variant) and the chat injection
// behavior it triggers.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). TaskRow imports only react, lucide-react, lib/chat-context
// and lib/types — no react-router-dom or @tanstack/react-query — so the file
// needs no module mocks at all (mock.module is process-global, so the least
// mocking is the safest mocking).
//
// Why the class-level assertion exists: happy-dom cannot evaluate CSS media
// queries, so `@media (hover: hover)` can never be resolved to a pass/fail in
// this environment. The tablet bug was a *class wiring* bug — `md:opacity-0`
// hid the button at ≥768px regardless of hover capability — so the regression
// guard asserts on the className instead: the visibility utilities must be
// gated behind `hover-capable:` (which compiles to `@media (hover: hover)`,
// verified in the built CSS during `pnpm build:client`), and a bare
// ungated `md:opacity-0` token must never come back. Visual behavior on real
// devices is verified manually (devtools device emulation).

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { ChatContext } from '../src/client/lib/chat-context';
import type { Task } from '../src/client/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_NAME = 'test-project';

const stubTask: Task = {
  apiVersion: 'percussionist.dev/v1alpha1',
  kind: 'Task',
  metadata: { name: 'task-abc123' },
  spec: {
    projectRef: PROJECT_NAME,
    type: 'BUILD',
    title: 'Fix tablet button visibility',
    priority: 'medium',
    agent: 'builder',
  },
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function renderTaskRow() {
  const { TaskRow } = await import('../src/client/components/board/TaskRow');
  const injectTask = mock((_task: Task, _project: string) => {});
  render(
    React.createElement(
      ChatContext.Provider,
      { value: { injectTask } },
      React.createElement(TaskRow, {
        task: stubTask,
        col: 'in-progress',
        isSelected: false,
        onClick: () => {},
        projectName: PROJECT_NAME,
      }),
    ),
  );
  return { injectTask };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskRow "Inject task into chat" button', () => {
  afterEach(cleanup);

  it('renders the chat-context button with the expected accessible name', async () => {
    await renderTaskRow();
    expect(screen.getByRole('button', { name: 'Inject task into chat' })).toBeTruthy();
  });

  it('calls injectTask with the task and project name when clicked', async () => {
    const { injectTask } = await renderTaskRow();
    fireEvent.click(screen.getByRole('button', { name: 'Inject task into chat' }));
    expect(injectTask).toHaveBeenCalledWith(stubTask, PROJECT_NAME);
  });

  it('gates the md: hide-until-hover classes behind hover-capable:', async () => {
    await renderTaskRow();
    const btn = screen.getByRole('button', { name: 'Inject task into chat' });
    const tokens = btn.className.split(/\s+/);

    // The three visibility utilities must carry the hover-capable: prefix so
    // they only apply inside `@media (hover: hover)` — never to touch-only
    // devices (tablets), which is the bug being fixed.
    expect(tokens).toContain('hover-capable:md:opacity-0');
    expect(tokens).toContain('hover-capable:md:group-hover:opacity-60');
    expect(tokens).toContain('hover-capable:md:hover:opacity-100');

    // A bare, ungated md:opacity-0 token would hide the button at ≥768px on
    // every device including tablets. Token-exact comparison matters here:
    // `hover-capable:md:opacity-0` contains "md:opacity-0" as a substring, so
    // a naive className.includes('md:opacity-0') check would not catch a
    // regression back to the ungated form.
    expect(tokens).not.toContain('md:opacity-0');

    // Keyboard-focus visibility (Task 3) must remain ungated so the button is
    // visible on focus on every device.
    expect(tokens).toContain('focus-visible:opacity-100');
  });
});

// ---------------------------------------------------------------------------
// PR-open indicator (awaiting-feature-merge, PR-gated integration mode)
// ---------------------------------------------------------------------------

async function renderTaskRowWithTask(task: Task, col: string) {
  const { TaskRow } = await import('../src/client/components/board/TaskRow');
  const injectTask = mock((_task: Task, _project: string) => {});
  render(
    React.createElement(
      ChatContext.Provider,
      { value: { injectTask } },
      React.createElement(TaskRow, {
        task,
        col,
        isSelected: false,
        onClick: () => {},
        projectName: PROJECT_NAME,
      }),
    ),
  );
}

describe('TaskRow PR-open indicator', () => {
  afterEach(cleanup);

  it('shows "PR open" badge and PR-number status line when awaiting-feature-merge with prNumber', async () => {
    const task: Task = {
      ...stubTask,
      status: { phase: 'awaiting-feature-merge', worker: { prNumber: 7 } },
    };
    await renderTaskRowWithTask(task, 'in-progress');
    expect(screen.getByText('PR open')).toBeTruthy();
    expect(screen.getByText('Waiting for PR #7 to be merged on GitHub')).toBeTruthy();
  });

  it('keeps the old status line when awaiting-feature-merge without prNumber', async () => {
    const task: Task = {
      ...stubTask,
      status: { phase: 'awaiting-feature-merge' },
    };
    await renderTaskRowWithTask(task, 'in-progress');
    expect(screen.queryByText('PR open')).toBeNull();
    expect(screen.getByText('Merging feature branch to target')).toBeTruthy();
  });

  it('shows no "PR open" badge for a done task with prNumber', async () => {
    const task: Task = {
      ...stubTask,
      status: { phase: 'done', worker: { prNumber: 7, mergedAt: '2026-01-02T00:00:00Z' } },
    };
    await renderTaskRowWithTask(task, 'done');
    expect(screen.queryByText('PR open')).toBeNull();
  });
});
