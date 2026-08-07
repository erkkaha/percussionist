// task-row-waiting.test.tsx — "waiting for input" presentation in TaskRow and
// StatusBadge: a task whose worker run is parked on a human prompt (or whose
// phase is waiting-for-input) must show an amber "waiting for input" badge and
// never the red "failed" badge, even when worker.status is 'Failed'.
//
// Mirrors the rendering style of task-row.test.tsx (ChatContext.Provider +
// dynamic import; no react-router-dom or @tanstack/react-query involved).
// Uses @testing-library/react with happy-dom (configured in tests/setup.ts).

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { ChatContext } from '../src/client/lib/chat-context';
import type { Task } from '../src/client/lib/types';

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

async function renderTaskRow(task: Task, col: string) {
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

describe('TaskRow "waiting for input" badge', () => {
  afterEach(cleanup);

  it('shows an amber "waiting for input" badge and no "failed" when the worker run is WaitingForInput (worker.status Failed)', async () => {
    const task: Task = {
      ...stubTask,
      workerRunPhase: 'WaitingForInput',
      status: { phase: 'failed', worker: { status: 'Failed' } },
    };
    await renderTaskRow(task, 'review');
    const badge = screen.getByText('waiting for input');
    expect(badge.className).toContain('text-amber-400');
    expect(badge.getAttribute('title')).toContain('Run is waiting for user input');
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('shows the waiting badge (not failed) when the worker run is WaitingForInput and worker.status is Running', async () => {
    const task: Task = {
      ...stubTask,
      workerRunPhase: 'WaitingForInput',
      status: { phase: 'waiting-for-input', worker: { status: 'Running' } },
    };
    await renderTaskRow(task, 'review');
    expect(screen.getByText('waiting for input')).toBeTruthy();
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('shows the waiting badge for a waiting-for-input phase task with no run phase attached', async () => {
    const task: Task = {
      ...stubTask,
      status: { phase: 'waiting-for-input', worker: { status: 'Running' } },
    };
    await renderTaskRow(task, 'review');
    expect(screen.getByText('waiting for input')).toBeTruthy();
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('still shows "failed" for a plain failed task', async () => {
    const task: Task = {
      ...stubTask,
      status: { phase: 'failed', worker: { status: 'Failed' } },
    };
    await renderTaskRow(task, 'review');
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.queryByText('waiting for input')).toBeNull();
  });
});

describe('StatusBadge WaitingForInput variant mapping', () => {
  afterEach(cleanup);

  it('maps WaitingForInput to the amber waiting variant', async () => {
    const { default: StatusBadge } = await import('../src/client/components/StatusBadge');
    const { container } = render(React.createElement(StatusBadge, { phase: 'WaitingForInput' }));
    const badge = screen.getByText('WaitingForInput');
    // 'waiting' badge variant uses the phase-pending token family (amber).
    expect(badge.className).toContain('bg-phase-pending/15');
    expect(badge.className).toContain('text-phase-pending');
    // Dot variant pulses while waiting.
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('leaves Failed mapped to the failed variant (regression guard)', async () => {
    const { default: StatusBadge } = await import('../src/client/components/StatusBadge');
    render(React.createElement(StatusBadge, { phase: 'Failed' }));
    const badge = screen.getByText('Failed');
    expect(badge.className).toContain('bg-phase-failed/15');
    expect(badge.className).toContain('text-phase-failed');
  });

  it('renders unknown phases as generic outline', async () => {
    const { default: StatusBadge } = await import('../src/client/components/StatusBadge');
    render(React.createElement(StatusBadge, { phase: 'SomeNewPhase' }));
    const badge = screen.getByText('SomeNewPhase');
    expect(badge.className).toContain('text-text-dim');
  });
});
