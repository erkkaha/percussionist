// Tests for the in-tab browser notification core (`notifications.ts`):
// history recording, and the deep-link plumbing on OS notifications —
// `data.url` plus an `onclick` handler that navigates to the linked content.
//
// happy-dom provides no `Notification`, so we install a capture stub on
// `globalThis` BEFORE importing the module under test. Static ESM imports are
// hoisted above the module body, so the module is loaded via a dynamic import
// inside `beforeAll`.
//
// Module-level `_shown` / `_history` state persists across tests within this
// file (the `--isolate` flag only isolates per file), so every test uses a
// unique `key`.

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { NotificationEntry, NotifyOptions } from '../src/client/lib/notifications.js';

// ---------------------------------------------------------------------------
// Notification stub

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];

  title: string;
  options: NotificationOptions;
  onclick: (() => void) | null = null;
  closed = false;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options ?? {};
    FakeNotification.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Module under test (loaded after the global stub is installed)

let notify: (opts: NotifyOptions) => void;
let getNotificationHistory: () => NotificationEntry[];

beforeAll(async () => {
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  const mod = await import('../src/client/lib/notifications.js');
  notify = mod.notify;
  getNotificationHistory = mod.getNotificationHistory;
});

let navigatedTo: string | null = null;

beforeEach(() => {
  FakeNotification.instances.length = 0;
  navigatedTo = null;
  // Capture navigations instead of letting happy-dom attempt a real one.
  window.location.assign = (url: string | URL) => {
    navigatedTo = String(url);
  };
});

// ---------------------------------------------------------------------------
// History entries

describe('notify() history entries', () => {
  it('records url in the history entry when provided', () => {
    notify({ key: 'hist-url', title: 'Run done', sound: 'success', url: '/runs/r1' });

    const entry = getNotificationHistory().find((e) => e.key === 'hist-url');
    expect(entry).toBeDefined();
    expect(entry?.url).toBe('/runs/r1');
    expect(entry?.title).toBe('Run done');
    expect(entry?.sound).toBe('success');
  });

  it('leaves url undefined in the history entry when omitted', () => {
    notify({ key: 'hist-no-url', title: 'Run started', sound: 'running' });

    const entry = getNotificationHistory().find((e) => e.key === 'hist-no-url');
    expect(entry).toBeDefined();
    expect(entry?.url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OS Notification deep link

describe('OS Notification deep link', () => {
  it('passes data.url and attaches an onclick navigator when url is set', () => {
    notify({ key: 'os-url', title: 'Run failed', sound: 'failure', url: '/runs/r1' });

    const n = FakeNotification.instances.find((i) => i.options.tag === 'os-url');
    expect(n).toBeDefined();
    expect(n?.options.data).toEqual({ url: '/runs/r1' });
    expect(typeof n?.onclick).toBe('function');

    // Simulate a click on the OS notification: window is focused and the
    // app navigates to the linked URL.
    n?.onclick?.();
    expect(navigatedTo).toBe('/runs/r1');
  });

  it('omits data and the click handler when no url is given', () => {
    notify({ key: 'os-no-url', title: 'Run started', sound: 'running' });

    const n = FakeNotification.instances.find((i) => i.options.tag === 'os-no-url');
    expect(n).toBeDefined();
    expect(n?.options.data).toBeUndefined();
    expect(n?.onclick).toBeNull();
  });
});
