// Tests for Web Push: VAPID key persistence, subscription storage, dispatch
// pruning, and the /api/push routes' auth-disabled behaviour.
//
// The web-push implementation is replaced via _setWebPushForTests so nothing
// talks to real push services; VAPID "keys" are deterministic strings.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { WebPushError } from 'web-push';
import { closeDb, getDb } from '../src/server/db.js';
import {
  _resetVapidCacheForTests,
  _setWebPushForTests,
  deleteSubscription,
  getVapidKeys,
  listSubscriptions,
  saveSubscription,
  sendPushToUser,
} from '../src/server/lib/push.js';
import pushRoute from '../src/server/routes/push.js';
import { pushSubscription, user } from '../src/server/schema.js';

const prevAuthDisabled = process.env.AUTH_DISABLED;
process.env.AUTH_DISABLED = '1';

const dataDirs: string[] = [];
let keyCounter = 0;

/** Deterministic fake web-push: records sends, fails endpoints by marker. */
function fakeWebPush() {
  const sent: string[] = [];
  _setWebPushForTests({
    generateVAPIDKeys: () => {
      keyCounter++;
      return { publicKey: `pub-${keyCounter}`, privateKey: `priv-${keyCounter}` };
    },
    sendNotification: async (sub) => {
      const endpoint = (sub as { endpoint: string }).endpoint;
      if (endpoint.includes('gone')) {
        throw Object.assign(new Error('Gone'), { statusCode: 410 }) as WebPushError;
      }
      if (endpoint.includes('flaky')) {
        throw Object.assign(new Error('Server error'), { statusCode: 500 }) as WebPushError;
      }
      sent.push(endpoint);
      return { statusCode: 201, body: '', headers: {} };
    },
  });
  return sent;
}

function freshDb(): void {
  const dataDir = join('/tmp', `percussionist-push-${Date.now()}-${Math.random()}`);
  dataDirs.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  closeDb();
  _resetVapidCacheForTests();
}

function seedUser(id: string): void {
  getDb()
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

const SUB = { endpoint: 'https://push.example/dev-1', p256dh: 'p256', auth: 'authkey' };

beforeEach(() => {
  process.env.AUTH_DISABLED = '1';
  freshDb();
});

afterEach(() => {
  closeDb();
  _resetVapidCacheForTests();
  _setWebPushForTests(null);
  delete process.env.DATA_DIR;
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (prevAuthDisabled !== undefined) process.env.AUTH_DISABLED = prevAuthDisabled;
  else delete process.env.AUTH_DISABLED;
});

describe('VAPID keypair', () => {
  it('is generated once and returned stably from the DB afterwards', () => {
    fakeWebPush();
    const first = getVapidKeys();
    const second = getVapidKeys();
    expect(second).toEqual(first);

    // Survives the in-memory cache being dropped — read back from the DB.
    _resetVapidCacheForTests();
    expect(getVapidKeys()).toEqual(first);
  });
});

describe('subscription storage', () => {
  it('saves, lists, and deletes a subscription for its owner', () => {
    seedUser('alice');
    saveSubscription('alice', SUB, 'TestBrowser/1.0');

    const listed = listSubscriptions('alice');
    expect(listed).toHaveLength(1);
    expect(listed[0].endpoint).toBe(SUB.endpoint);
    expect(listed[0].userAgent).toBe('TestBrowser/1.0');

    // Someone else cannot remove it.
    seedUser('mallory');
    expect(deleteSubscription('mallory', SUB.endpoint)).toBe(false);
    expect(deleteSubscription('alice', SUB.endpoint)).toBe(true);
    expect(listSubscriptions('alice')).toHaveLength(0);
  });

  it('re-binds an endpoint to the new user on re-subscribe (sign-out/sign-in)', () => {
    seedUser('alice');
    seedUser('bob');
    saveSubscription('alice', SUB);
    saveSubscription('bob', { ...SUB, p256dh: 'p256-new' });

    expect(listSubscriptions('alice')).toHaveLength(0);
    const bobs = listSubscriptions('bob');
    expect(bobs).toHaveLength(1);
    expect(bobs[0].endpoint).toBe(SUB.endpoint);
  });
});

describe('sendPushToUser', () => {
  it('sends to every device, counts failures, and prunes gone subscriptions', async () => {
    const sent = fakeWebPush();
    seedUser('alice');
    saveSubscription('alice', { endpoint: 'https://push.example/ok', p256dh: 'k', auth: 'a' });
    saveSubscription('alice', { endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a' });
    saveSubscription('alice', { endpoint: 'https://push.example/flaky', p256dh: 'k', auth: 'a' });

    const result = await sendPushToUser('alice', { title: 'Test' });
    expect(result).toEqual({ sent: 1, failed: 1, pruned: 1 });
    expect(sent).toEqual(['https://push.example/ok']);

    // The gone endpoint was deleted; the flaky one is retained for next time.
    const remaining = getDb().select().from(pushSubscription).all();
    expect(remaining.map((r) => r.endpoint).sort()).toEqual([
      'https://push.example/flaky',
      'https://push.example/ok',
    ]);
  });
});

describe('routes with AUTH_DISABLED', () => {
  it('answers 501 on every endpoint — there is no user to bind to', async () => {
    fakeWebPush();
    const app = new Hono();
    app.route('/api/push', pushRoute);

    for (const [method, path] of [
      ['GET', '/api/push/public-key'],
      ['GET', '/api/push/subscriptions'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions'],
      ['POST', '/api/push/test'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({}),
      });
      expect(res.status).toBe(501);
    }
  });
});
