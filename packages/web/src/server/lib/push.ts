// lib/push.ts — Web Push: VAPID key management, subscription storage, dispatch.
//
// The VAPID keypair identifies this deployment to browser push services. It is
// generated on first use and persisted in the stats DB rather than a Kubernetes
// Secret, deliberately: subscriptions are only valid for the keypair they were
// created under, and both live in the same database, so they can never drift
// apart — dropping the database invalidates keys and subscriptions together.
//
// Payloads are end-to-end encrypted by the web-push protocol (RFC 8291) with
// the per-subscription client keys; the push services (Google/Mozilla/Apple)
// relay ciphertext only.
//
// Dispatch is best-effort per device: a failure on one subscription never
// blocks the others, and subscriptions the push service reports as gone
// (404/410) are deleted so dead devices don't accumulate.

import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import { getDb } from '../db.js';
import { pushSubscription, pushVapid } from '../schema.js';

/** Shape the service worker's push handler expects (see client public/sw.js). */
export interface PushPayload {
  title: string;
  body?: string;
  /** Coalesces notifications: a new push with the same tag replaces the old. */
  tag?: string;
  /** App-relative path opened when the notification is clicked. */
  url?: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ---------------------------------------------------------------------------
// Test seams
//
// Real sends would hit Google/Mozilla push services; tests inject a fake.

type WebPushLike = Pick<typeof webpush, 'sendNotification' | 'generateVAPIDKeys'>;

let _webpush: WebPushLike = webpush;

export function _setWebPushForTests(impl: WebPushLike | null): void {
  _webpush = impl ?? webpush;
}

/** Drops the cached keypair so a fresh database is picked up. */
export function _resetVapidCacheForTests(): void {
  _vapid = null;
}

// ---------------------------------------------------------------------------
// VAPID keypair

let _vapid: { publicKey: string; privateKey: string } | null = null;

/** Return the deployment's VAPID keypair, generating and persisting on first use. */
export async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (_vapid) return _vapid;

  const db = getDb();
  const existing = (await db.select().from(pushVapid).where(eq(pushVapid.id, 1)))[0];
  if (existing) {
    _vapid = { publicKey: existing.publicKey, privateKey: existing.privateKey };
    return _vapid;
  }

  const generated = _webpush.generateVAPIDKeys();
  // A concurrent first-request race loses to the unique id; re-read on conflict.
  try {
    await db
      .insert(pushVapid)
      .values({ id: 1, publicKey: generated.publicKey, privateKey: generated.privateKey });
    console.log('[push] generated new VAPID keypair');
  } catch {
    const row = (await db.select().from(pushVapid).where(eq(pushVapid.id, 1)))[0];
    if (!row) throw new Error('VAPID keypair insert failed and no existing row found');
    _vapid = { publicKey: row.publicKey, privateKey: row.privateKey };
    return _vapid;
  }

  _vapid = generated;
  return _vapid;
}

/**
 * VAPID subject — a contact for push-service operators to reach the sender.
 * Must be an https: or mailto: URL; WEB_BASE_URL qualifies only when https.
 */
function vapidSubject(): string {
  const base = process.env.WEB_BASE_URL;
  if (base?.startsWith('https://')) return base;
  return 'mailto:admin@percussionist.local';
}

// ---------------------------------------------------------------------------
// Subscription storage

/** Upsert a subscription for a user. Re-subscribing an endpoint re-binds it. */
export async function saveSubscription(
  userId: string,
  sub: PushSubscriptionKeys,
  userAgent?: string,
): Promise<void> {
  await getDb()
    .insert(pushSubscription)
    .values({
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      userAgent: userAgent ?? null,
    })
    // The endpoint may already exist: the same browser re-subscribing (possibly
    // as a different user after sign-out/sign-in) must take ownership, not 500.
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { userId, p256dh: sub.p256dh, auth: sub.auth, userAgent: userAgent ?? null },
    });
}

/** Delete one of the user's subscriptions. Returns true if a row was removed. */
export async function deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
  const removed = await getDb()
    .delete(pushSubscription)
    .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
    .returning({ id: pushSubscription.id });
  return removed.length > 0;
}

export async function listSubscriptions(
  userId: string,
): Promise<Array<{ endpoint: string; userAgent: string | null; createdAt: string }>> {
  return getDb()
    .select({
      endpoint: pushSubscription.endpoint,
      userAgent: pushSubscription.userAgent,
      createdAt: pushSubscription.createdAt,
    })
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId));
}

// ---------------------------------------------------------------------------
// Dispatch

async function sendToSubscription(
  row: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<'sent' | 'gone' | 'failed'> {
  const keys = await getVapidKeys();
  try {
    await _webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: vapidSubject(),
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        // Push services queue for offline devices; a day is plenty for the
        // "come look at this" notifications we send.
        TTL: 24 * 60 * 60,
      },
    );
    return 'sent';
  } catch (e) {
    const status = (e as webpush.WebPushError).statusCode;
    if (status === 404 || status === 410) return 'gone';
    console.warn(`[push] send failed (${status ?? 'no status'}):`, (e as Error).message);
    return 'failed';
  }
}

/** Send to each row concurrently, pruning subscriptions the service reports gone. */
async function dispatch(
  rows: Array<{ endpoint: string; p256dh: string; auth: string }>,
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  const db = getDb();
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      const outcome = await sendToSubscription(row, payload);
      if (outcome === 'gone') {
        await db.delete(pushSubscription).where(eq(pushSubscription.endpoint, row.endpoint));
      }
      return outcome;
    }),
  );
  return {
    sent: outcomes.filter((o) => o === 'sent').length,
    failed: outcomes.filter((o) => o === 'failed').length,
    pruned: outcomes.filter((o) => o === 'gone').length,
  };
}

/**
 * Send a payload to every device a user has enabled push on.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  const rows = await getDb()
    .select()
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId));
  return dispatch(rows, payload);
}

/**
 * Send a payload to every subscription in the deployment — the sink the
 * server-side notification triggers will use until per-user subscription
 * preferences exist (today every signed-in user is an operator).
 */
export async function sendPushToAll(
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  return dispatch(await getDb().select().from(pushSubscription), payload);
}
