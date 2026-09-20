// notification-bell.test.tsx — NotificationBell dropdown link + attention behavior.
//
// Entries with a `url` render as react-router `Link`s that navigate and close
// the panel; entries without one stay plain, non-clickable rows. Above them the
// bell renders a persistent, server-backed "Needs attention" row linking to
// /attention, and folds that count into the bell badge.
//
// react-router-dom is deliberately NOT mocked — a real MemoryRouter is mounted
// so rendered anchors carry real hrefs and clicking them performs real SPA
// navigation. See the notes in board-header.test.tsx for why stubbing `Link`
// leaks process-globally and breaks other suites' `link` role queries.
//
// useAttention (react-query) is mocked at the module level so this suite needs
// no QueryClientProvider/network, following the app-sidebar.test.tsx pattern.
// Module-level `_history` / `_shown` state persists across tests within this
// file (the `--isolate` flag only isolates per file), so every test seeds via
// `notify()` with a unique `key`.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mutable mock state for the server-backed attention hook.
// ---------------------------------------------------------------------------

const attentionMock: { data: { count: number } | undefined } = { data: undefined };

mock.module(path.resolve('src/client/hooks/useAttention'), () => ({
  useAttention: () => ({ data: attentionMock.data }),
}));

import { notify } from '../src/client/lib/notifications';

const { default: NotificationBell } = await import('../src/client/components/NotificationBell');

// ---------------------------------------------------------------------------
// Helpers

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderBell() {
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      React.createElement(
        React.Fragment,
        null,
        React.createElement(NotificationBell),
        React.createElement(LocationProbe),
      ),
    ),
  );
}

async function openPanel() {
  const bell = await screen.findByRole('button', { name: /notifications/i });
  fireEvent.click(bell);
}

// ---------------------------------------------------------------------------
// Tests

describe('NotificationBell dropdown links', () => {
  beforeEach(() => {
    attentionMock.data = { count: 0 };
  });
  afterEach(cleanup);

  it('renders an entry with url as a link carrying the destination href', async () => {
    notify({ key: 'bell-link', title: 'Run done', sound: 'success', url: '/runs/r1' });
    renderBell();
    await openPanel();

    const link = screen.getByRole('link', { name: /Run done/ });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/runs/r1');
  });

  it('navigates and closes the panel when a notification link is clicked', async () => {
    notify({ key: 'bell-click', title: 'Task failed', sound: 'failure', url: '/runs/r2' });
    renderBell();
    await openPanel();

    const link = screen.getByRole('link', { name: /Task failed/ });
    fireEvent.click(link);

    // Panel closed: the dropdown (and its links) are gone.
    expect(screen.queryByRole('link', { name: /Task failed/ })).toBeNull();

    // Navigation happened: the router location moved to the linked URL.
    expect(screen.getByTestId('location').textContent).toBe('/runs/r2');
  });

  it('keeps entries without url as plain non-clickable rows', async () => {
    notify({ key: 'bell-plain', title: 'Run started', sound: 'running' });
    renderBell();
    await openPanel();

    const row = screen.getByText('Run started');
    expect(row).toBeTruthy();
    // Not wrapped in an anchor: no link role, and the closest anchor is null.
    expect(row.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /Run started/ })).toBeNull();
  });

  it('renders mixed history with links only for entries that have urls', async () => {
    notify({
      key: 'bell-mix-link',
      title: 'Escalated',
      sound: 'escalated',
      url: '/projects/p/board?task=t1',
    });
    notify({ key: 'bell-mix-plain', title: 'Cancelled', sound: 'cancelled' });
    renderBell();
    await openPanel();

    // Only the entry with a url is a link.
    const link = screen.getByRole('link', { name: /Escalated/ });
    expect(link.getAttribute('href')).toBe('/projects/p/board?task=t1');

    const plain = screen.getByText('Cancelled');
    expect(plain.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /Cancelled/ })).toBeNull();
  });
});

describe('NotificationBell needs-attention section', () => {
  beforeEach(() => {
    attentionMock.data = { count: 0 };
  });
  afterEach(cleanup);

  it('renders a persistent Needs attention row linking to /attention', async () => {
    attentionMock.data = { count: 2 };
    renderBell();
    await openPanel();

    const link = screen.getByRole('link', { name: /Needs attention/ });
    expect(link.getAttribute('href')).toBe('/attention');
    // Server count is shown inline so the two lists are distinguishable.
    expect(link.textContent).toContain('(2)');
  });

  it('reflects the server attention count in the bell badge', async () => {
    attentionMock.data = { count: 4 };
    renderBell();

    expect(screen.getByTestId('notification-badge').textContent).toBe('4');
  });

  it('uses the larger of unread events and attention count for the badge', async () => {
    attentionMock.data = { count: 1 };
    renderBell();

    // A live in-session event takes the badge above the (smaller) server count.
    act(() => {
      notify({ key: 'bell-badge-live-a', title: 'Run finished', sound: 'success' });
      notify({ key: 'bell-badge-live-b', title: 'Run failed', sound: 'failure' });
    });

    expect(screen.getByTestId('notification-badge').textContent).toBe('2');
  });

  it('still renders the ephemeral event history below the attention row', async () => {
    attentionMock.data = { count: 1 };
    notify({ key: 'bell-attn-history', title: 'Review requested', sound: 'escalated' });
    renderBell();
    await openPanel();

    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('Review requested')).toBeTruthy();
  });
});
