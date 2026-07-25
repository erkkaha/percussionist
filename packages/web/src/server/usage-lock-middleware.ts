import type { MiddlewareHandler } from 'hono';
import { getAuthValue } from './auth.js';

/**
 * In-memory lock state, updated by /api/usage/* routes after each DB heartbeat.
 * The middleware reads this flag instead of hitting the DB on every request,
 * avoiding test-isolation issues with the getDb() singleton.
 */
let _cachedLocked = false;

export function setCachedLocked(locked: boolean): void {
  _cachedLocked = locked;
}

export function isCachedLocked(): boolean {
  return _cachedLocked;
}

/**
 * Middleware that rejects authenticated requests with 423 Locked when the
 * daily usage limit has been reached and lockOnMax is enabled.
 *
 * Exempt routes: /api/usage/*, /api/auth/*, /api/health, /login, /api/settings
 * (and static).
 */
export function usageLockMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const url = c.req.path;

    if (
      url.startsWith('/api/usage/') ||
      // Signing in and refreshing a session must work while locked, otherwise
      // the lock cannot be lifted from the UI.
      url.startsWith('/api/auth/') ||
      url === '/api/health' ||
      url === '/login' ||
      url.startsWith('/api/settings')
    ) {
      await next();
      return;
    }

    // Only enforce the lock for requests that carry a credential — the auth
    // middleware on the route itself is what rejects the rest. Validating the
    // credential here as well would mean a second session/key lookup on every
    // request, so we only check that one is present.
    if (process.env.AUTH_DISABLED !== '1') {
      const hasCredential = c.req.header('Cookie') !== undefined || getAuthValue(c) !== null;
      if (!hasCredential) {
        await next();
        return;
      }
    }

    if (_cachedLocked) {
      return c.json({ error: 'Daily limit reached', locked: true }, 423);
    }

    await next();
  };
}
