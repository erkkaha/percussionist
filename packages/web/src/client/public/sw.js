// sw.js — Percussionist service worker.
//
// Served verbatim from public/ at the origin root, so its scope covers the
// whole app. Registered by src/client/lib/pwa.ts (production builds only).
//
// This worker deliberately has NO fetch handler: the dashboard is a real-time
// view over SSE and WebSockets, so serving stale cached assets would be worse
// than the network round-trip, and Vite already content-hashes the bundles.
// The worker exists for two reasons:
//
//   1. It completes the installable-PWA story (manifest + icons + worker).
//   2. It is the delivery point for Web Push: the push/notificationclick
//      handlers below run even when no tab is open. The server-side half
//      (VAPID subscription + dispatch) lands separately; until then no push
//      events ever arrive and the handlers are inert.

// Version: 2 — bump this comment on behaviour changes; the browser re-installs
// the worker whenever the file's bytes differ.

self.addEventListener('install', () => {
  // Take over from any previous version immediately — there is no cache to
  // warm and no fetch interception, so there is nothing to wait for.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// Web Push
//
// Expected payload (JSON, encrypted end-to-end by the web-push protocol):
//   { title: string, body?: string, tag?: string, url?: string }
// `url` is an app-relative path (e.g. /projects/foo/board) opened on click.

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — show something rather than dropping it silently.
    payload = { title: 'Percussionist', body: event.data ? event.data.text() : undefined };
  }

  const { title = 'Percussionist', body, tag, url } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/icon-192.png',
      // Android status-bar icon: alpha-only silhouette. A colored icon here
      // masks to a solid grey rectangle.
      badge: '/badge-96.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      // Focus an existing app window and navigate it, rather than piling up
      // new windows on every notification tap.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
