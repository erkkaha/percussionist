// auth.ts — authentication middleware for web API routes.
//
// Authentication model
// --------------------
// Two kinds of caller, deliberately separated so that a credential leaked from
// an agent pod cannot be used to administer the cluster:
//
//   1. The human operator — signs in with GitHub (better-auth), holds an
//      httpOnly session cookie. A session may reach every route.
//   2. Agents — dispatcher run pods and manager-controller hold an API key
//      scoped to specific permissions. A key is accepted ONLY on routes marked
//      with `scoped()`. It can never satisfy `auth()` or `adminAuth()`.
//
// Three middleware variants:
//   - `auth()`      — requires a human session. 401 otherwise.
//   - `adminAuth()` — same, and records role "admin". Use for mutating
//                     endpoints (secrets CRUD, run/project deletion, upgrade).
//                     Answers 403 when a valid-but-unprivileged agent key is
//                     presented, so misconfiguration is distinguishable from
//                     a missing credential.
//   - `scoped(r,a)` — requires an agent API key carrying permission `r:[a]`,
//                     or a human session (the operator can always do by hand
//                     what an agent does).
//
// Escape hatches:
//   - AUTH_DISABLED=1     — skip all checks (dev/e2e). Nothing below runs.
//   - LEGACY_TOKEN_AUTH=1 — additionally accept the pre-better-auth shared
//                           secret in AUTH_SECRET, so a rolling upgrade does
//                           not break agents mid-flight. Remove once every
//                           component has been issued a key.
//
// Usage in route files:
//   import { auth, adminAuth, scoped } from "../auth.js";
//   router.get("/protected", auth(), handler);
//   router.delete("/:name", adminAuth(), deleteHandler);
//   router.post("/stats/session", scoped("stats", "write"), statsHandler);

import type { Context, MiddlewareHandler } from 'hono';
import { getAuth, type PermissionResource } from './lib/better-auth.js';

export type AuthSubject = 'human' | 'agent' | 'legacy';

export type AuthContext = {
  role: 'user' | 'admin';
  subject: AuthSubject;
  /** better-auth user id, when the caller holds a human session. */
  userId?: string;
  /** API key id, when the caller authenticated with a key. */
  keyId?: string;
  /** Scopes the key carries, for audit logging. */
  permissions?: Record<string, string[]>;
};

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// ---------------------------------------------------------------------------
// Helpers

export function getAuthValue(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const token = c.req.header('x-auth-token');
  if (token) return token;
  const apiKeyHeader = c.req.header('x-api-key');
  if (apiKeyHeader) return apiKeyHeader;
  const queryToken = c.req.query('token');
  if (queryToken) return queryToken;
  return null;
}

/**
 * Legacy shared-secret check against AUTH_SECRET.
 *
 * Only consulted when LEGACY_TOKEN_AUTH=1. Retained so a partially rolled-out
 * cluster keeps working during the migration to per-caller API keys.
 */
export function isValidToken(token: string): boolean {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  // Constant-time comparison to prevent timing attacks.
  if (token.length !== secret.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return result === 0;
}

function legacyTokenEnabled(): boolean {
  return process.env.LEGACY_TOKEN_AUTH === '1';
}

function authDisabled(): boolean {
  return process.env.AUTH_DISABLED === '1';
}

/**
 * True when the request carries nothing that could possibly authenticate it.
 *
 * Lets the common unauthenticated case answer 401 without constructing the
 * better-auth instance (which opens the DB and applies migrations).
 */
function hasNoCredential(c: Context): boolean {
  return !c.req.header('Cookie') && getAuthValue(c) === null;
}

/** Resolve a human session's user id from the request cookies, or null. */
async function humanSession(c: Context): Promise<string | null> {
  try {
    const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
    return session?.user.id ?? null;
  } catch (e) {
    console.error('[auth] session lookup failed:', (e as Error).message);
    return null;
  }
}

type KeyVerdict =
  | { ok: true; keyId?: string; permissions?: Record<string, string[]> }
  | { ok: false; reason: 'invalid' | 'forbidden' };

/**
 * Verify an API key, optionally requiring a permission.
 *
 * On failure we re-check the key without the permission requirement purely to
 * tell "unknown/expired key" (401) apart from "known key, wrong scope" (403) —
 * better-auth reports both as the same error code.
 */
async function verifyKey(
  key: string,
  required?: { resource: string; action: string },
): Promise<KeyVerdict> {
  const api = getAuth().api;
  try {
    const res = await api.verifyApiKey({
      body: {
        key,
        ...(required ? { permissions: { [required.resource]: [required.action] } } : {}),
      },
    });
    if (res.valid) {
      return {
        ok: true,
        keyId: res.key?.id,
        permissions: (res.key?.permissions as Record<string, string[]> | null) ?? undefined,
      };
    }
    if (!required) return { ok: false, reason: 'invalid' };
    const bare = await api.verifyApiKey({ body: { key } });
    return { ok: false, reason: bare.valid ? 'forbidden' : 'invalid' };
  } catch (e) {
    console.error('[auth] api key verification failed:', (e as Error).message);
    return { ok: false, reason: 'invalid' };
  }
}

// ---------------------------------------------------------------------------
// Middleware factories

/**
 * Requires a human session. Skipped entirely when AUTH_DISABLED=1.
 */
export function auth(): MiddlewareHandler {
  return async (c, next) => {
    if (authDisabled()) {
      c.set('auth', { role: 'user', subject: 'human' });
      await next();
      return;
    }

    if (hasNoCredential(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sessionUserId = await humanSession(c);
    if (sessionUserId) {
      c.set('auth', { role: 'admin', subject: 'human', userId: sessionUserId });
      await next();
      return;
    }

    const token = getAuthValue(c);
    if (token && legacyTokenEnabled() && isValidToken(token)) {
      c.set('auth', { role: 'admin', subject: 'legacy' });
      await next();
      return;
    }

    // A scoped agent key is valid, but not for this route.
    if (token && (await verifyKey(token)).ok) {
      return c.json(
        { error: 'Forbidden: this endpoint requires an interactive session, not an API key' },
        403,
      );
    }

    return c.json({ error: 'Unauthorized' }, 401);
  };
}

/**
 * Requires a human session and records the admin role.
 * Skipped entirely when AUTH_DISABLED=1.
 *
 * Identical in effect to `auth()` today — a session is always admin, and an
 * API key is never admin. Kept as a distinct marker so the mutating endpoints
 * stay labelled, and so a future read-only session role has somewhere to land.
 */
export function adminAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (authDisabled()) {
      c.set('auth', { role: 'admin', subject: 'human' });
      await next();
      return;
    }

    if (hasNoCredential(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const sessionUserId = await humanSession(c);
    if (sessionUserId) {
      c.set('auth', { role: 'admin', subject: 'human', userId: sessionUserId });
      await next();
      return;
    }

    const token = getAuthValue(c);
    if (token && legacyTokenEnabled() && isValidToken(token)) {
      c.set('auth', { role: 'admin', subject: 'legacy' });
      await next();
      return;
    }

    if (token && (await verifyKey(token)).ok) {
      return c.json(
        { error: 'Forbidden: this endpoint requires an interactive session, not an API key' },
        403,
      );
    }

    return c.json({ error: 'Unauthorized' }, 401);
  };
}

/**
 * Requires an agent API key holding `resource:[action]`, or a human session.
 *
 * This is the ONLY way an API key reaches a route, which is what keeps a key
 * scraped out of a run pod from reading settings or applying an upgrade.
 */
export function scoped(resource: PermissionResource, action: string): MiddlewareHandler {
  return async (c, next) => {
    if (authDisabled()) {
      c.set('auth', { role: 'user', subject: 'agent' });
      await next();
      return;
    }

    if (hasNoCredential(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = getAuthValue(c);
    if (token) {
      const verdict = await verifyKey(token, { resource, action });
      if (verdict.ok) {
        c.set('auth', {
          role: 'user',
          subject: 'agent',
          keyId: verdict.keyId,
          permissions: verdict.permissions,
        });
        await next();
        return;
      }
      if (verdict.reason === 'forbidden') {
        return c.json({ error: `Forbidden: key lacks permission ${resource}:${action}` }, 403);
      }
      if (legacyTokenEnabled() && isValidToken(token)) {
        c.set('auth', { role: 'admin', subject: 'legacy' });
        await next();
        return;
      }
    }

    // The operator may always do by hand whatever an agent does.
    const sessionUserId = await humanSession(c);
    if (sessionUserId) {
      c.set('auth', { role: 'admin', subject: 'human', userId: sessionUserId });
      await next();
      return;
    }

    return c.json({ error: 'Unauthorized' }, 401);
  };
}
