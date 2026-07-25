import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Gate that redirects to /login when there is no session.
 *
 * Dev mode (AUTH_DISABLED=1 on the server) is detected from /api/health, which
 * reports it explicitly. This previously inferred it from a bare 200 on that
 * endpoint — but /api/health is public, so the probe always succeeded and the
 * guard never redirected: the login gate was effectively disabled in production.
 */
export default function AuthGuard() {
  const { isAuthenticated, isPending } = useAuth();
  const [authDisabled, setAuthDisabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { authDisabled?: boolean } | null) => {
        if (!cancelled) setAuthDisabled(body?.authDisabled === true);
      })
      .catch(() => {
        // Unreachable server — assume auth is enforced rather than opening up.
        if (!cancelled) setAuthDisabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isPending || authDisabled === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-text-dim">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated && !authDisabled) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
