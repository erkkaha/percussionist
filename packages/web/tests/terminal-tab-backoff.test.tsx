// terminal-tab-backoff.test.tsx — Bug 2 regression: the attach terminal's
// reconnect backoff must grow on repeated failed attaches and only reset on a
// successful open (or a manual Reconnect).
//
// TerminalTab.connect() used to reset retryCountRef to 0 on every attempt, so
// a pod that never accepted the attach got hammered with a fresh 500ms retry
// forever. The counter now resets only in ws.onopen, in the mount cleanup, and
// in the manual Reconnect button.
//
// Uses @testing-library/react with the happy-dom environment from tests/setup.ts.
// xterm is mocked (as in log-viewer.test.tsx); WebSocket is replaced by a fake
// whose onclose/onopen the tests drive by hand to simulate failed attaches
// (onclose without onopen) and successful ones.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Module mocks — replace xterm so TerminalTab can mount without a canvas.
// ---------------------------------------------------------------------------

mock.module('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    write() {}
    reset() {}
    dispose() {}
    open() {}
    loadAddon() {}
    onData() {}
  }
  return { Terminal: MockTerminal };
});

mock.module('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit() {}
  }
  return { FitAddon: MockFitAddon };
});

mock.module('@xterm/xterm/css/xterm.css', () => ({}));

// ---------------------------------------------------------------------------
// Fake WebSocket — records every socket the component opens; tests fire
// onclose/onopen manually to simulate failed and successful attaches.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  binaryType = 'blob';
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // connect() nulls out the previous socket's handlers before closing it,
    // so this never schedules a retry on the socket being replaced.
    this.onclose?.();
  }

  /** Successful attach: the server accepted the socket. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Failed attach: the socket closed without ever opening. */
  fail() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

// ---------------------------------------------------------------------------
// Timer harness — records every setTimeout so tests can read the retry delay
// and fire the retry immediately instead of waiting real seconds. Real timers
// still run underneath so React/act keep working; a recorded callback is
// cancelled before being invoked by hand.
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface RecordedTimer {
  id: number;
  delay: number;
  cb: () => void;
}

let recordedTimers: RecordedTimer[] = [];
let nextTimerId = 0;
const timerRealIds = new Map<number, ReturnType<typeof setTimeout>>();

function installTimerHarness() {
  recordedTimers = [];
  nextTimerId = 0;
  timerRealIds.clear();
  globalThis.setTimeout = ((
    cb: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const realId = realSetTimeout(cb, delay, ...rest);
    const id = nextTimerId++;
    timerRealIds.set(id, realId);
    recordedTimers.push({ id, delay: delay ?? 0, cb: () => cb(...rest) });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    const realId = timerRealIds.get(id);
    if (realId !== undefined) {
      timerRealIds.delete(id);
      realClearTimeout(realId);
    }
  }) as typeof clearTimeout;
}

function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  timerRealIds.clear();
}

/** Cancel the n-th recorded timer's real timeout and run its callback now. */
function fireRecordedTimer(index: number) {
  const timer = recordedTimers[index];
  if (!timer) throw new Error(`no recorded timer at index ${index}`);
  globalThis.clearTimeout(timer.id);
  timer.cb();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderTerminalTab() {
  const { default: TerminalTab } = await import('../src/client/components/TerminalTab');
  return render(React.createElement(TerminalTab, { runName: 'test-run', active: true }));
}

/** Latest socket the component opened. */
function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error('no WebSocket was created');
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalTab reconnect backoff', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    installTimerHarness();
  });

  afterEach(() => {
    restoreTimers();
    cleanup();
  });

  it('grows the retry delay after repeated failed attaches', async () => {
    await renderTerminalTab();
    const ws1 = lastSocket();

    // First failed attach (onclose without onopen) schedules the base-500ms
    // retry: 500 * 2^0, with up to 500ms of jitter.
    act(() => {
      ws1.fail();
    });
    expect(recordedTimers.length).toBe(1);
    const firstDelay = recordedTimers[0].delay;
    expect(firstDelay).toBeGreaterThanOrEqual(500);
    expect(firstDelay).toBeLessThan(1000);

    // Let the retry fire: connect() opens a second socket.
    act(() => {
      fireRecordedTimer(0);
    });
    const ws2 = lastSocket();
    expect(ws2).not.toBe(ws1);

    // Second failed attach must back off to the base-1000ms bucket — connect()
    // no longer resets the counter, so the server is not hammered every 500ms.
    act(() => {
      ws2.fail();
    });
    expect(recordedTimers.length).toBe(2);
    const secondDelay = recordedTimers[1].delay;
    expect(secondDelay).toBeGreaterThan(firstDelay);
    expect(secondDelay).toBeGreaterThanOrEqual(1000);
  });

  it('resets the backoff to 500ms after a successful onopen', async () => {
    await renderTerminalTab();
    const ws1 = lastSocket();

    act(() => {
      ws1.fail();
    });
    expect(recordedTimers[0].delay).toBeLessThan(1000);

    // Retry, then the socket actually opens — the counter resets here, so the
    // next failure starts over at base 500ms instead of continuing to grow.
    act(() => {
      fireRecordedTimer(0);
    });
    const ws2 = lastSocket();
    act(() => {
      ws2.open();
    });

    act(() => {
      ws2.fail();
    });
    expect(recordedTimers.length).toBe(2);
    expect(recordedTimers[1].delay).toBeGreaterThanOrEqual(500);
    expect(recordedTimers[1].delay).toBeLessThan(1000);
  });

  it('resets the backoff when the user clicks Reconnect', async () => {
    await renderTerminalTab();
    const ws1 = lastSocket();

    // Two failed attaches grow the backoff into the base-1000ms bucket.
    act(() => {
      ws1.fail();
    });
    act(() => {
      fireRecordedTimer(0);
    });
    const ws2 = lastSocket();
    act(() => {
      ws2.fail();
    });
    expect(recordedTimers[1].delay).toBeGreaterThanOrEqual(1000);

    // Manual Reconnect is an intentional fresh attempt — it resets the counter
    // before connecting, so the next failure is back at base 500ms.
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    const ws3 = lastSocket();
    expect(ws3).not.toBe(ws2);

    act(() => {
      ws3.fail();
    });
    expect(recordedTimers.length).toBe(3);
    expect(recordedTimers[2].delay).toBeGreaterThanOrEqual(500);
    expect(recordedTimers[2].delay).toBeLessThan(1000);
  });
});
