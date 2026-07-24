// log-viewer.test.tsx — Regression tests for LogViewer auto-scroll toggle.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks xterm terminal dependencies and the useLogs hook to
// isolate the component under test from terminal-rendering side effects and
// query infrastructure.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// These run before any dynamic import of the component, so the resolved
// modules are replaced before LogViewer ever references them.
// ---------------------------------------------------------------------------

// Mock xterm Terminal — we only need method signatures used by LogViewer.
mock.module('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon() {}
    open() {}
    write(_data: string) {}
    reset() {}
    scrollToBottom() {}
    dispose() {}
  }
  return { Terminal: MockTerminal };
});

// Mock xterm FitAddon — used in the ResizeObserver callback.
mock.module('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit() {}
  }
  return { FitAddon: MockFitAddon };
});

// CSS imports are side-effects that bun test does not need to process.
mock.module('@xterm/xterm/css/xterm.css', () => ({}));

// Mock useLogs hook so tests don't depend on @tanstack/react-query or the
// real fetchLogs API call.
const useLogsMock: {
  data: { lines: string } | null;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
} = {
  data: null,
  error: null,
  isLoading: false,
  isFetching: false,
};

mock.module(path.resolve('src/client/hooks/useLogs'), () => ({
  useLogs: () => useLogsMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderLogViewer() {
  const { default: LogViewer } = await import('../src/client/components/LogViewer');
  return render(
    React.createElement(LogViewer, {
      name: 'test-run',
      active: false,
      sseConnected: false,
      eventTick: 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogViewer auto-scroll toggle', () => {
  afterEach(cleanup);

  it('renders auto-scroll control with shadcn/Radix checkbox semantics', async () => {
    await renderLogViewer();

    // The Radix checkbox primitive renders a <button> with role="checkbox"
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.tagName).toBe('BUTTON');

    // No native <input type="checkbox"> should be present
    const nativeCheckboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(nativeCheckboxes.length).toBe(0);

    // Label text is rendered
    expect(screen.getByText('auto-scroll')).toBeInTheDocument();
  });

  it('defaults to enabled (aria-checked="true")', async () => {
    await renderLogViewer();

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles checked state when clicked', async () => {
    await renderLogViewer();

    const checkbox = screen.getByRole('checkbox');

    // Default: enabled
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    // Click to disable
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    // Click to re-enable
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });

  it('label text click toggles checkbox state', async () => {
    await renderLogViewer();

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    // Click the label text ("auto-scroll") — the checkbox is inside a <label>,
    // so the click event propagates to the checkbox button.
    fireEvent.click(screen.getByText('auto-scroll'));
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    // Click label text again to re-enable
    fireEvent.click(screen.getByText('auto-scroll'));
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });
});
