import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DrumLogo } from '../components/app-sidebar';
import { authClient } from '../lib/auth';

/**
 * Device authorization approval page (RFC 8628) — the browser half of
 * `beatctl auth login`.
 *
 * The CLI prints a user code and this URL; you enter the code here and approve.
 * Sits behind AuthGuard, so approving requires an existing session: the CLI
 * inherits your identity rather than establishing one of its own.
 */
export default function DevicePage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('user_code') ?? '');
  const [state, setState] = useState<'idle' | 'working' | 'approved' | 'denied'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Prefill from ?user_code= when the CLI opened the URL for you.
  useEffect(() => {
    const fromQuery = params.get('user_code');
    if (fromQuery) setCode(fromQuery);
  }, [params]);

  async function decide(approve: boolean) {
    const userCode = code.trim().toUpperCase();
    if (!userCode) return;
    setState('working');
    setError(null);
    try {
      const res = approve
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode });
      if (res.error) {
        // The device endpoints report RFC 8628 style errors, not the
        // `{ message }` shape the rest of better-auth's client uses.
        setError(res.error.error_description || res.error.error || 'Could not process that code');
        setState('idle');
        return;
      }
      setState(approve ? 'approved' : 'denied');
    } catch (e) {
      setError((e as Error).message || 'Could not process that code');
      setState('idle');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <DrumLogo playing={false} size={64} />
          <h1 className="text-lg font-semibold text-text">Authorize device</h1>
          <p className="text-sm text-text-dim text-center">
            Enter the code shown by <code>beatctl auth login</code>.
          </p>
        </div>

        {state === 'approved' && (
          <p className="text-sm text-text text-center">
            Approved — you can return to the terminal.
          </p>
        )}
        {state === 'denied' && (
          <p className="text-sm text-text-dim text-center">
            Denied. The device was not granted access.
          </p>
        )}

        {(state === 'idle' || state === 'working') && (
          <div className="flex flex-col gap-4">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-1234"
              autoComplete="off"
              spellCheck={false}
              className="rounded-md border border-border bg-surface px-3 py-2 text-center font-mono text-sm tracking-widest text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none"
            />

            {error && <p className="text-sm text-phase-failed">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => decide(true)}
                disabled={state === 'working' || !code.trim()}
                className="flex-1 rounded-md bg-accent text-on-primary px-3 py-2 text-sm font-medium hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {state === 'working' ? 'Working…' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => decide(false)}
                disabled={state === 'working' || !code.trim()}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text-dim hover:text-text disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
