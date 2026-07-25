// routes/push.ts — Web Push subscription management.
//
//   GET    /api/push/public-key     → VAPID public key for pushManager.subscribe()
//   GET    /api/push/subscriptions  → the caller's registered devices
//   POST   /api/push/subscriptions  → register this browser's subscription
//   DELETE /api/push/subscriptions  → remove a subscription (body: {endpoint})
//   POST   /api/push/test           → send a test notification to the caller
//
// All routes require a human session (`auth()`), never an agent API key: push
// reaches the operator's personal devices, so an agent credential must not be
// able to register endpoints or make devices buzz.
//
// Subscriptions are bound to the session's user id. When AUTH_DISABLED=1 there
// is no user to bind to, so push is unavailable — the client treats the 501 as
// "feature off" rather than an error.

import { type Context, Hono } from 'hono';
import { auth } from '../auth.js';
import {
  deleteSubscription,
  getVapidKeys,
  listSubscriptions,
  type PushSubscriptionKeys,
  saveSubscription,
  sendPushToUser,
} from '../lib/push.js';

const push = new Hono();

push.use('*', auth());

/** The session's user id, or null when auth is disabled (no user exists). */
function userId(c: Context): string | null {
  return c.get('auth').userId ?? null;
}

const AUTH_DISABLED_ERROR = {
  error: 'Push notifications require authentication to be enabled',
} as const;

push.get('/public-key', (c) => {
  if (!userId(c)) return c.json(AUTH_DISABLED_ERROR, 501);
  return c.json({ publicKey: getVapidKeys().publicKey });
});

push.get('/subscriptions', (c) => {
  const uid = userId(c);
  if (!uid) return c.json(AUTH_DISABLED_ERROR, 501);
  return c.json({ items: listSubscriptions(uid) });
});

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

/** Validate the browser's PushSubscription.toJSON() shape. */
function parseSubscription(body: SubscribeBody): PushSubscriptionKeys | null {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const authKey = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint.startsWith('https://') || !p256dh || !authKey) return null;
  return { endpoint, p256dh, auth: authKey };
}

push.post('/subscriptions', async (c) => {
  const uid = userId(c);
  if (!uid) return c.json(AUTH_DISABLED_ERROR, 501);

  let body: SubscribeBody;
  try {
    body = (await c.req.json()) as SubscribeBody;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const sub = parseSubscription(body);
  if (!sub) {
    return c.json(
      { error: 'Expected {endpoint, keys: {p256dh, auth}} with an https endpoint' },
      400,
    );
  }

  try {
    saveSubscription(uid, sub, c.req.header('User-Agent'));
    return c.json({ ok: true }, 201);
  } catch (e) {
    console.error('[push] subscription save failed:', (e as Error).message);
    return c.json({ error: 'Failed to save subscription' }, 500);
  }
});

push.delete('/subscriptions', async (c) => {
  const uid = userId(c);
  if (!uid) return c.json(AUTH_DISABLED_ERROR, 501);

  let body: { endpoint?: unknown };
  try {
    body = (await c.req.json()) as { endpoint?: unknown };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return c.json({ error: 'endpoint is required' }, 400);

  return c.json({ removed: deleteSubscription(uid, endpoint) });
});

push.post('/test', async (c) => {
  const uid = userId(c);
  if (!uid) return c.json(AUTH_DISABLED_ERROR, 501);

  const result = await sendPushToUser(uid, {
    title: 'Percussionist',
    body: 'Push notifications are working on this device.',
    tag: 'push-test',
    url: '/',
  });
  if (result.sent === 0) {
    return c.json({ ...result, error: 'No subscription accepted the push' }, 502);
  }
  return c.json(result);
});

export default push;
