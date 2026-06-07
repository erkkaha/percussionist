import { useState, useEffect } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth, clearToken } from "../lib/auth";

export default function AuthGuard() {
  const { isAuthenticated } = useAuth();
  const [authActive, setAuthActive] = useState(true);
  const [checking, setChecking] = useState(!isAuthenticated);

  useEffect(() => {
    if (isAuthenticated) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    fetch("/api/health")
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setAuthActive(false);
        } else if (r.status === 401) {
          setAuthActive(true);
        }
      })
      .catch(() => {
        if (!cancelled) setAuthActive(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-text-dim">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated && authActive) {
    clearToken();
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
