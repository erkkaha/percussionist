import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DrumLogo } from '../components/app-sidebar';
import { useAuth } from '../lib/auth';

/**
 * Sign-in page. GitHub is the only identity provider — there is no SMTP in this
 * deployment, so email/password and password reset are not available, and only
 * the GitHub logins in GITHUB_ALLOWED_LOGINS may sign in.
 */
export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { isAuthenticated, isPending, signInWithGithub } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  // better-auth redirects back here with ?error=... when the callback is
  // rejected — most often because the GitHub account is not allowlisted.
  const callbackError = params.get('error');

  useEffect(() => {
    if (!isPending && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isPending, isAuthenticated, navigate]);

  async function handleGithub() {
    setLoading(true);
    setError(null);
    try {
      await signInWithGithub('/');
    } catch (e) {
      setError((e as Error).message || 'Could not start GitHub sign-in');
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <DrumLogo playing={false} size={64} />
          <h1 className="text-lg font-semibold text-text">Percussionist</h1>
          <p className="text-sm text-text-dim">Sign in to continue</p>
        </div>

        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={handleGithub}
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-md bg-accent text-on-primary px-3 py-2 text-sm font-medium hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="currentColor"
              className="shrink-0"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            {loading ? 'Redirecting…' : 'Continue with GitHub'}
          </button>

          {(error ?? callbackError) && (
            <p className="text-sm text-phase-failed">{error ?? callbackError}</p>
          )}

          <p className="text-xs text-text-dim text-center">
            Only allowlisted GitHub accounts can sign in. Manage the allowlist with{' '}
            <code>beatctl auth github allow</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
