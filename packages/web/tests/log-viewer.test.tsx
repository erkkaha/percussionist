// log-viewer.test.tsx — Regression tests for LogViewer auto-scroll toggle.
//
// Uses @testing-library/react with happy-dom DOM environment (configured in
// tests/setup.ts). Mocks xterm terminal dependencies and the useLogs hook to
// isolate the component under test from terminal-rendering side effects and
// query infrastructure.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — intercept at the module resolution level.
// These run before any dynamic import of the component, so the resolved
// modules are replaced before LogViewer ever references them.
// ---------------------------------------------------------------------------

// Capture what gets written to / how often the mock terminal is reset so the
// content-overlap diff regression tests can assert on the write behaviour.
// These live in the file scope of this test module (each file runs in its own
// isolate), so cross-test leakage is bounded by the afterEach resets below.
const terminalWrites: string[] = [];
let terminalResets = 0;

// Mock xterm Terminal — we only need method signatures used by LogViewer.
mock.module('@xterm/xterm', () => {
  class MockTerminal {
    loadAddon() {}
    open() {}
    write(data: string) {
      terminalWrites.push(data);
    }
    reset() {
      terminalResets += 1;
    }
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

/** Records the container name LogViewer asks useLogs for. */
let containerArgSpy = '';

mock.module(path.resolve('src/client/hooks/useLogs'), () => ({
  useLogs: (_name: string, container: string) => {
    containerArgSpy = container;
    return useLogsMock;
  },
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

// The runner container is named `opencode` in the pod spec whichever engine the
// run uses, so the logs API needs that exact value while the button must not
// name a specific engine.
describe('LogViewer container labels', () => {
  afterEach(cleanup);

  it('labels the runner log source "engine", not "opencode"', async () => {
    await renderLogViewer();

    expect(screen.getByRole('button', { name: 'engine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'opencode' })).toBeNull();
  });

  it('still offers the bootstrap and dispatcher sources', async () => {
    await renderLogViewer();

    expect(screen.getByRole('button', { name: 'bootstrap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dispatcher' })).toBeInTheDocument();
  });

  // The label is cosmetic; the value passed to the logs API must stay `opencode`
  // or the container will not resolve.
  it('requests the opencode container when the engine source is selected', async () => {
    await renderLogViewer();

    fireEvent.click(screen.getByRole('button', { name: 'engine' }));
    expect(containerArgSpy).toBe('opencode');
  });
});

// ---------------------------------------------------------------------------
// Content-overlap diff regression tests (Bug 1: tail-window corruption).
//
// The server returns the LAST N lines, which is not append-only once the log
// exceeds the tail window. writeData() must diff by content overlap instead of
// slicing by character offset, and fall back to a full reset+rewrite when the
// windows no longer line up (no overlap, or the payload shrank).
// ---------------------------------------------------------------------------
describe('LogViewer content-overlap diff', () => {
  afterEach(() => {
    cleanup();
    useLogsMock.data = null;
    terminalWrites.length = 0;
    terminalResets = 0;
  });

  // Let the mount effect's requestAnimationFrame callback fire (happy-dom
  // schedules it via setTimeout) and flush any pending React updates.
  async function flushPendingWork() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  // Render with no data first so the mount rAF writes nothing, then reset the
  // capture arrays — the scenario below is the only thing being asserted on.
  async function mountDiffViewer() {
    useLogsMock.data = null;
    const view = await renderLogViewer();
    await flushPendingWork();
    terminalWrites.length = 0;
    terminalResets = 0;
    return view;
  }

  // Point the (mocked) useLogs hook at a new payload and re-render with
  // identical props so writeData re-runs with the new data.
  async function pushLogs(view: ReturnType<typeof render>, lines: string) {
    useLogsMock.data = { lines };
    const { default: LogViewer } = await import('../src/client/components/LogViewer');
    await act(async () => {
      view.rerender(
        React.createElement(LogViewer, {
          name: 'test-run',
          active: false,
          sseConnected: false,
          eventTick: 0,
        }),
      );
    });
  }

  it('appends only the new remainder when a longer payload follows a short one', async () => {
    const view = await mountDiffViewer();

    // First payload: full write (CRLF-converted).
    await pushLogs(view, 'line1\nline2');
    expect(terminalWrites).toEqual(['line1\r\nline2']);

    // Longer payload sharing the previous content as a prefix: only the delta
    // is written — no duplication of the already-shown prefix.
    await pushLogs(view, 'line1\nline2\nline3');
    expect(terminalWrites).toEqual(['line1\r\nline2', '\r\nline3']);
    expect(terminalResets).toBe(0);
  });

  it('rewrites from a reset when the payload moves forward without overlap', async () => {
    const view = await mountDiffViewer();

    await pushLogs(view, 'line1\nline2');
    expect(terminalWrites).toEqual(['line1\r\nline2']);

    // A payload of equal/greater length that shares no suffix/prefix with the
    // previous window (the tail window slid past everything we had) must force
    // a full reset+rewrite — never a mid-line slice (garbling/duplication).
    const resetsBefore = terminalResets;
    await pushLogs(view, 'line3\nline4\nline5');
    expect(terminalResets).toBe(resetsBefore + 1);
    expect(terminalWrites).toEqual(['line1\r\nline2', 'line3\r\nline4\r\nline5']);
  });

  it('rewrites from a reset when the payload is shorter (window dropped shown lines)', async () => {
    const view = await mountDiffViewer();

    await pushLogs(view, 'line1\nline2\nline3');
    expect(terminalWrites).toEqual(['line1\r\nline2\r\nline3']);

    // The new payload is shorter than what we already showed — even though it
    // is a suffix of the previous window, the dropped head must not linger.
    const resetsBefore = terminalResets;
    await pushLogs(view, 'line2\nline3');
    expect(terminalResets).toBe(resetsBefore + 1);
    expect(terminalWrites).toEqual(['line1\r\nline2\r\nline3', 'line2\r\nline3']);
  });

  it('full reset + rewrite when the container source is switched', async () => {
    const view = await mountDiffViewer();

    await pushLogs(view, 'line1\nline2');
    expect(terminalWrites).toEqual(['line1\r\nline2']);

    // Switching container changes the write key → full reset, then the payload
    // is written again in full (lastKeyRef changed branch).
    const resetsBefore = terminalResets;
    fireEvent.click(screen.getByRole('button', { name: 'engine' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(terminalResets).toBe(resetsBefore + 1);
    expect(terminalWrites).toEqual(['line1\r\nline2', 'line1\r\nline2']);
  });
});
