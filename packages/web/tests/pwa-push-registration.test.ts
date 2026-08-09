// pwa-push-registration.test.ts — regression tests for the service-worker
// registration race (dashboard bug 8b): isPushSupported()/getPushSubscription()
// used to read a module var that was only populated after `window.load` + async
// register, so the push toggle could permanently show "Unavailable". They now
// await navigator.serviceWorker.ready via waitForServiceWorkerRegistration().
//
// bun's global `navigator` is a separate object from happy-dom's
// `window.navigator` (tests/setup.ts), and the modules under test reference the
// bare global, so a fake installed on `navigator` is exactly what they see.
// Everything is read at call time — nothing at import time — so the modules are
// imported statically and the fakes are installed per test.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getPushSubscription, isPushSupported, subscribeToPush } from '../src/client/lib/push.js';
import { waitForServiceWorkerRegistration } from '../src/client/lib/pwa.js';

// ---------------------------------------------------------------------------
// Fakes

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fake registration whose pushManager reports the current `subscription`. */
function makeRegistration(): ServiceWorkerRegistration {
  return {
    scope: '/',
    active: { state: 'activated' },
    pushManager: {
      getSubscription: async () => subscription,
    },
  } as unknown as ServiceWorkerRegistration;
}

/** The subscription the fake registration's pushManager reports. */
let subscription: PushSubscription | null = null;

interface SwFake {
  ready: Promise<ServiceWorkerRegistration>;
  resolveReady: (reg: ServiceWorkerRegistration) => void;
  /** What `getRegistration('/sw.js')` currently reports. */
  registered: ServiceWorkerRegistration | null;
}

/** Install a controllable navigator.serviceWorker fake on the global. */
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

beforeEach(() => {
  subscription = null;
  removeServiceWorkerFake();
  removeBrowserPushApis();
});

afterEach(() => {
  removeServiceWorkerFake();
  removeBrowserPushApis();
});

// ---------------------------------------------------------------------------
// waitForServiceWorkerRegistration

describe('waitForServiceWorkerRegistration', () => {
  it('awaits ready and returns the registration even when the worker finishes registering after the call (the race)', async () => {
    const fake = installServiceWorkerFake();
    const reg = makeRegistration();
    // The worker is still registering when the call starts: getRegistration
    // reports nothing yet.
    const pending = waitForServiceWorkerRegistration();

    // Activation completes *after* the caller asked — previously the module
    // var was still null and callers saw a permanent "no registration".
    fake.registered = reg;
    fake.resolveReady(reg);

    expect(await pending).toBe(reg);
  });

  it('returns null when the service worker API is unavailable', async () => {
    expect(await waitForServiceWorkerRegistration()).toBeNull();
  });

  it('returns null when ready resolves but nothing is registered at /sw.js', async () => {
    const fake = installServiceWorkerFake();
    fake.resolveReady(makeRegistration());
    expect(await waitForServiceWorkerRegistration()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPushSubscription / subscribeToPush

describe('getPushSubscription', () => {
  it('returns the current subscription once the worker is ready — no early-null race', async () => {
    const fake = installServiceWorkerFake();
    subscription = { endpoint: 'https://push.example/dev-1' } as unknown as PushSubscription;
    const reg = makeRegistration();
    const pending = getPushSubscription();

    fake.registered = reg;
    fake.resolveReady(reg);

    expect(await pending).toBe(subscription);
  });

  it('returns null when nothing is subscribed even though the worker is ready', async () => {
    const fake = installServiceWorkerFake();
    const reg = makeRegistration();
    const pending = getPushSubscription();

    fake.registered = reg;
    fake.resolveReady(reg);

    expect(await pending).toBeNull();
  });

  it('returns null when there is no service worker at all', async () => {
    expect(await getPushSubscription()).toBeNull();
  });
});

describe('subscribeToPush', () => {
  it('reports unavailable when there is no service worker', async () => {
    await expect(subscribeToPush()).rejects.toThrow('Push is unavailable');
  });
});

// ---------------------------------------------------------------------------
// isPushSupported

describe('isPushSupported', () => {
  it('is a cheap sync guard independent of registration timing', () => {
    installBrowserPushApis();
    installServiceWorkerFake(); // registered: nothing yet — and that is fine
    expect(isPushSupported()).toBe(true);
  });

  it('returns false when the browser lacks the push APIs', () => {
    expect(isPushSupported()).toBe(false);
  });
});
