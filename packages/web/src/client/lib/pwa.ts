// pwa.ts — service worker registration.
//
// Registers /sw.js (see public/sw.js) so the app is installable and, once the
// server-side push routes land, can receive Web Push with no tab open.
//
// Production builds only: in `vite dev` the worker would outlive the dev
// session and confuse hot reload, and it provides nothing there — it has no
// fetch handler and push requires the canonical HTTPS origin anyway.

/** The active registration, for the push-subscription flow to build on. */
let _registration: ServiceWorkerRegistration | null = null;

export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return _registration;
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
