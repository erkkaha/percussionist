// pwa.ts — service worker registration.
//
// Registers /sw.js (see public/sw.js) so the app is installable and, once the
// server-side push routes land, can receive Web Push with no tab open.
//
// Production builds only: in `vite dev` the worker would outlive the dev
// session and confuse hot reload, and it provides nothing there — it has no
// fetch handler and push requires the canonical HTTPS origin anyway.

/** How long to wait for the worker to become active before giving up. */
const REGISTRATION_READY_TIMEOUT_MS = 10_000;

/** The active registration, for the push-subscription flow to build on. */
let _registration: ServiceWorkerRegistration | null = null;

export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return _registration;
}

/**
 * Resolve the service worker registration without racing `window.load`.
 *
 * `_registration` is only populated after `load` plus the async register
 * round-trip, so reading it synchronously right after mount can report "no
 * worker" while the registration is still in flight. `navigator.serviceWorker.ready`
 * is the reliable "at least one active worker" signal — it resolves once a
 * worker is active, whenever that happens. Bounded by a timeout so a failed
 * registration (or a dev build that never registers) returns null instead of
 * hanging the caller forever.
 */
export async function waitForServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<void>((resolve) => setTimeout(resolve, REGISTRATION_READY_TIMEOUT_MS)),
    ]);
  } catch {
    // `ready` is not expected to reject, but on the odd implementation that
    // does, fall through to the direct lookup so a present registration still
    // wins.
  }
  return (await navigator.serviceWorker.getRegistration('/sw.js').catch(() => null)) ?? null;
}

export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return;
  // Requires a secure context (HTTPS or localhost) — silently unavailable
  // otherwise, same as the Notification API this feeds into.
  if (!('serviceWorker' in navigator)) return;

  // After load, so registration never competes with first paint for bandwidth.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        _registration = reg;
        // The worker calls skipWaiting() and intercepts nothing, so a new
        // version activating under a running page is safe — no reload dance.
      })
      .catch((err) => {
        console.warn('[pwa] service worker registration failed:', err);
      });
  });
}
