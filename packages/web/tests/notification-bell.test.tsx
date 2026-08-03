// notification-bell.test.tsx — NotificationBell dropdown link behavior.
//
// Entries with a `url` render as react-router `Link`s that navigate and close
// the panel; entries without one stay plain, non-clickable rows.
//
// react-router-dom is deliberately NOT mocked — a real MemoryRouter is mounted
// so rendered anchors carry real hrefs and clicking them performs real SPA
// navigation. See the notes in board-header.test.tsx for why stubbing `Link`
// leaks process-globally and breaks other suites' `link` role queries.
//
// Module-level `_history` / `_shown` state persists across tests within this
// file (the `--isolate` flag only isolates per file), so every test seeds via
// `notify()` with a unique `key`.

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
