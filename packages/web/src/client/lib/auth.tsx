// Client-side auth — a thin wrapper over better-auth's React client.
//
// The session lives in an httpOnly cookie set by the server, so there is no
// token in localStorage and nothing for page JavaScript to read or leak. The
// SPA is served from the same origin as the API, which means cookies ride along
// on ordinary fetch, SSE (EventSource) and WebSocket connections with no extra
// work — that is why none of those need a `?token=` query parameter any more.
//
// `AuthContextValue` keeps its original shape so existing consumers compile;
// `token` is retained as a nullable field but is always null under cookie auth.

import { deviceAuthorizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';

/**
 * Same-origin base URL for the auth client.
 *
 * better-auth infers this from `window.location.origin` when omitted and throws
 * at module load if the origin is not a real http(s) URL — which is the case in
 * any opaque-origin context (a sandboxed iframe, `about:blank`, or the happy-dom
 * environment the component tests run in). Resolving it defensively keeps
 * importing this module side-effect-free.
 */
function resolveBaseURL(): string {
  const origin = typeof window === 'undefined' ? '' : (window.location?.origin ?? '');
  return origin.startsWith('http') ? origin : 'http://localhost';
}

export const authClient = createAuthClient({
  baseURL: resolveBaseURL(),
  basePath: '/api/auth',
  plugins: [deviceAuthorizationClient()],
});

/**
 * Empty by design: the session cookie authenticates same-origin requests.
 *
 * Kept so call sites that spread `authHeaders()` into fetch options don't all
 * have to change, and so there is one obvious place to look when wondering
 * where the Authorization header went.
 */
export function authHeaders(): Record<string, string> {
  return {};
}

export interface AuthContextValue {
  /** Always null under cookie auth. Retained for call-site compatibility. */
  token: string | null;
  isAuthenticated: boolean;
  isPending: boolean;
  user: { name?: string; email?: string; image?: string | null } | null;
  signInWithGithub: (callbackURL?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  isAuthenticated: false,
  isPending: true,
  user: null,
  signInWithGithub: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  const signInWithGithub = useCallback(async (callbackURL = '/') => {
    await authClient.signIn.social({ provider: 'github', callbackURL });
  }, []);

  const logout = useCallback(() => {
    void authClient.signOut().then(() => {
      window.location.href = '/login';
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: null,
      isAuthenticated: session != null,
      isPending,
      user: session?.user ?? null,
      signInWithGithub,
      logout,
    }),
    [session, isPending, signInWithGithub, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
