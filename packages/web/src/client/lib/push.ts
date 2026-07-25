// push.ts — client half of Web Push: browser subscription lifecycle.
//
// Pairs with the service worker's push handlers (public/sw.js) and the server
// routes in server/routes/push.ts. The flow to enable push on a device:
//
//   1. Ask for Notification permission (needed for userVisibleOnly pushes).
//   2. Fetch the deployment's VAPID public key.
//   3. pushManager.subscribe() against the service worker registration.
//   4. POST the resulting subscription to the server, bound to the session.
//
// Push is unavailable (isPushSupported() === false) in dev builds — the
// service worker only registers in production — and on non-secure origins.

import { authHeaders } from './auth';
import { getServiceWorkerRegistration } from './pwa';

const BASE = '/api/push';

/** True when this browser/origin can do Web Push and the worker registered. */
export function isPushSupported(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    'PushManager' in window &&
    getServiceWorkerRegistration() !== null
  );
}

/** The device's current subscription, or null when push is off or unsupported. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = getServiceWorkerRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * pushManager.subscribe() wants the VAPID key as bytes, but it travels from
 * the server as the base64url string VAPID defines.
 */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/**
 * Enable push on this device: request permission, subscribe, register with
 * the server. Throws with a user-presentable message on any failure.
 */
export async function subscribeToPush(): Promise<void> {
  const reg = getServiceWorkerRegistration();
  if (!reg)
    throw new Error('Push is unavailable: no service worker (dev build or insecure origin)');

  if (typeof Notification === 'undefined')
    throw new Error('This browser does not support notifications');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const keyRes = await fetch(`${BASE}/public-key`, { headers: authHeaders() });
  if (!keyRes.ok) {
    const body = await keyRes.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${keyRes.status}`);
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  const subscription = await reg.pushManager.subscribe({
    // Chrome requires it, and it is true: every push shows a notification.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });

  const res = await fetch(`${BASE}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) {
    // Don't leave a browser subscription the server doesn't know about.
    await subscription.unsubscribe().catch(() => undefined);
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

/** Disable push on this device, removing it browser- and server-side. */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getPushSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => undefined);

  // Best-effort: if this fails the server row is pruned on its next failed
  // send (the push service answers 410 for an unsubscribed endpoint).
  await fetch(`${BASE}/subscriptions`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}

/** Ask the server to push a test notification to this user's devices. */
export async function sendTestPush(): Promise<void> {
  const res = await fetch(`${BASE}/test`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}
