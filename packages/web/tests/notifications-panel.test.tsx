// notifications-panel.test.tsx — regression for the push toggle service-worker
// race (dashboard bug 8b): PushSection used to decide "Unavailable"
// synchronously from a module var that is only populated after `window.load` +
// async register, so a worker that was still registering after initial render
// left the toggle permanently stuck. It now awaits
// waitForServiceWorkerRegistration() (navigator.serviceWorker.ready), so the
// toggle resolves to a live switch whenever the worker eventually activates.
//
// happy-dom provides no Notification/PushManager/serviceWorker, so all three
// are stubbed. The fake service worker is installed per-test so each test gets
// a fresh, controllable `ready` promise. The module under test reads these
// globals at call time only, but it is imported dynamically in `beforeAll`
// (after the stubs exist) to match the notifications.test.ts pattern.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

// The Radix-backed ui components are stubbed with plain elements to keep the
// test focused on PushSection (same convention as the app-sidebar / usage-bar
// tests). NotificationsPanel imports them relatively, so the mocks key on the
// resolved module path. mock.module is process-global but --isolate scopes it
// to this file.
mock.module(resolve('src/client/components/ui/card'), () => ({
  Card: 'div',
  CardHeader: 'div',
  CardTitle: 'h3',
  CardDescription: 'p',
  CardContent: 'div',
}));
mock.module(resolve('src/client/components/ui/separator'), () => ({ Separator: 'div' }));
mock.module(resolve('src/client/components/ui/button'), () => ({ Button: 'button' }));
mock.module(resolve('src/client/components/ui/switch'), () => ({
  Switch: (props: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    React.createElement('button', {
      role: 'switch',
      'aria-checked': props.checked ?? false,
      disabled: props.disabled,
      onClick: () => props.onCheckedChange?.(!(props.checked ?? false)),
    }),
}));

// ---------------------------------------------------------------------------
// Fakes

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fake registration whose pushManager reports "nothing subscribed". */
function makeRegistration(): ServiceWorkerRegistration {
  return {
    scope: '/',
    active: { state: 'activated' },
    pushManager: {
      getSubscription: async () => null,
    },
  } as unknown as ServiceWorkerRegistration;
}

interface SwFake {
  ready: Promise<ServiceWorkerRegistration>;
  resolveReady: (reg: ServiceWorkerRegistration) => void;
  /** What `getRegistration('/sw.js')` currently reports. */
  registered: ServiceWorkerRegistration | null;
}

function installServiceWorkerFake(): SwFake {
  const ready = deferred<ServiceWorkerRegistration>();
  const fake: SwFake = {
    ready: ready.promise,
    resolveReady: ready.resolve,
    registered: null,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: fake.ready,
      getRegistration: async () => fake.registered,
      register: async () => fake.registered,
    },
  });
  return fake;
}

function removeServiceWorkerFake(): void {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
}

function installBrowserPushApis(): void {
  // A plain object is enough — the modules only read `Notification.permission`
  // and `typeof Notification`, never construct it (in these tests).
  (globalThis as { Notification?: unknown }).Notification = {
    permission: 'granted',
  } as unknown as Notification;
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
}

function removeBrowserPushApis(): void {
  delete (globalThis as { Notification?: unknown }).Notification;
  delete (window as unknown as Record<string, unknown>).PushManager;
}

// ---------------------------------------------------------------------------
// Module under test (loaded after the stubs are in place)

let NotificationsPanel: React.ComponentType;

beforeAll(async () => {
  const mod = await import('../src/client/components/NotificationsPanel');
  NotificationsPanel = mod.default;
});

let fake: SwFake;

beforeEach(() => {
  installBrowserPushApis();
  fake = installServiceWorkerFake();
});

afterEach(() => {
  removeServiceWorkerFake();
  removeBrowserPushApis();
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests

describe('PushSection service-worker race', () => {
  it('resolves to a live toggle when the worker finishes registering after render', async () => {
    // The worker is still registering when the panel mounts: getRegistration
    // reports nothing yet, so the old code would have shown "Unavailable" here.
    render(React.createElement(NotificationsPanel));

    // While registering, the push section stays pending — no premature
    // "Unavailable" verdict, no toggle yet.
    expect(screen.queryByText(/Unavailable here/)).toBeNull();

    // The worker activates after mount (the race the fix targets).
    const reg = makeRegistration();
    fake.registered = reg;
    fake.resolveReady(reg);

    // The toggle resolves to a live switch instead of staying "Unavailable".
    expect(
      await screen.findByText('Notify this device even when the dashboard is closed'),
    ).toBeTruthy();
    expect(screen.queryByText(/Unavailable here/)).toBeNull();
    // Two switches now: the sound toggle plus the push toggle.
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('shows the unavailable verdict when push cannot work here', async () => {
    // No service worker API at all → isPushSupported() is false.
    removeServiceWorkerFake();
    render(React.createElement(NotificationsPanel));

    expect(await screen.findByText(/Unavailable here/)).toBeTruthy();
  });
});
