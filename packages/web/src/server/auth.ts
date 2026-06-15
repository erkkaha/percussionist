// auth.ts — Reusable authentication middleware for web API routes.
//
// Authentication model:
//   - Token-based, verified against the AUTH_SECRET environment variable.
//   - Accepts `Authorization: Bearer <token>` or `x-auth-token` header.
//   - When AUTH_DISABLED=1 is set, all auth checks are skipped (dev/local mode).
//
// Two middleware variants:
//   - `auth()` — requires a valid token; rejects unauthenticated requests with 401.
//     Sets `c.get("auth")` to `{ role: "user" }`.
//   - `adminAuth()` — same as auth() but additionally sets admin flag on context.
//     Use for mutating endpoints (secrets CRUD, run/project deletion, etc.).
//
// Usage in route files:
//   import { auth, adminAuth } from "../auth.js";
//   router.get("/protected", auth(), handler);
//   router.delete("/:name", adminAuth(), deleteHandler);

import type { Context, MiddlewareHandler } from 'hono';

type AuthContext = { role: 'user' | 'admin' };

declare module 'hono' {
  interface ContextVariableMap extends AuthContext {}
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
  const queryToken = c.req.query('token');
  if (queryToken) return queryToken;
  return null;
}

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

// ---------------------------------------------------------------------------
// Middleware factories

/**
 * Auth middleware — requires a valid token.
 * Skipped entirely when AUTH_DISABLED=1.
 */
export function auth(): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.AUTH_DISABLED === '1') {
      c.set('auth', { role: 'user' });
      await next();
      return;
    }

    const token = getAuthValue(c);
    if (!token || !isValidToken(token)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('auth', { role: 'user' });
    await next();
  };
}

/**
 * Admin auth middleware — requires a valid token and sets admin flag.
 * Skipped entirely when AUTH_DISABLED=1.
 */
export function adminAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.AUTH_DISABLED === '1') {
      c.set('auth', { role: 'admin' });
      await next();
      return;
    }

    const token = getAuthValue(c);
    if (!token || !isValidToken(token)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('auth', { role: 'admin' });
    await next();
  };
}
