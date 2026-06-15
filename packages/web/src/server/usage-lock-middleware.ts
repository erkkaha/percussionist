import type { MiddlewareHandler } from 'hono';
import { getAuthValue, isValidToken } from './auth.js';

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
 * Exempt routes: /api/usage/*, /api/health, /login, /api/settings (and static).
 */
export function usageLockMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const url = c.req.path;

    if (
      url.startsWith('/api/usage/') ||
      url === '/api/health' ||
      url === '/login' ||
      url.startsWith('/api/settings')
    ) {
      await next();
      return;
    }

    // Only enforce lock for authenticated requests.
    if (process.env.AUTH_DISABLED !== '1') {
      const token = getAuthValue(c);
      if (!token || !isValidToken(token)) {
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
