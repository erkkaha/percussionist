// run-key-client.ts — mint and revoke the per-run API key that a run pod uses
// to report stats.
//
// Why per-run: the key ends up as a literal env var in the run pod, readable by
// the agent itself and by anyone who can `get pods`. Previously that value was
// the shared web-auth token, which unlocked the entire web API — secrets CRUD,
// project deletion, upgrades. A per-run key is scoped to stats:write and expires
// shortly after the run's timeout, so leaking it buys almost nothing.
//
// Minting goes through the web server, which is the only component with database
// access. The operator authenticates with its own standing key (WEB_AUTH_TOKEN,
// sourced from the operator-api-key Secret) carrying runkeys:mint and nothing
// else. The web endpoint fixes the granted scope, so a stolen operator key
// cannot be used to mint a broader one.
//
// Failure is never fatal: a run without a key falls back to the shared token
// (if one is configured) and at worst loses stats reporting, which must not
// prevent the run from starting.

import { WEB_AUTH_TOKEN, WEB_STATS_URL } from './config.js';

const log = (...args: unknown[]) => console.log(`[run-keys ${new Date().toISOString()}]`, ...args);

/** Requests time out fast — pod creation must not block on the web server. */
const TIMEOUT_MS = 5_000;

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(WEB_AUTH_TOKEN ? { Authorization: `Bearer ${WEB_AUTH_TOKEN}` } : {}),
  };
}

export interface MintRunKeyArgs {
  runName: string;
  runUid?: string;
  project?: string;
  timeoutSeconds?: number;
}

/**
 * Mint a stats-scoped key for a run. Returns null when minting is unavailable,
 * in which case the caller should fall back to the shared token.
 */
/**
 * Warn once, not per-run, when the operator has no credential.
 *
 * This is normal on a dev/e2e cluster (AUTH_DISABLED), but on a real cluster it
 * means run pods will get no usable token and silently lose stats reporting —
 * most likely because the operator was restarted before the web server had
 * created the operator-api-key Secret. Worth one loud line either way.
 */
let warnedMissingToken = false;

function warnMissingTokenOnce(): void {
  if (warnedMissingToken) return;
  warnedMissingToken = true;
  log(
    'no WEB_AUTH_TOKEN configured — per-run stats keys will not be minted. ' +
      'On a cluster with auth enabled, ensure the web server has created the ' +
      'operator-api-key Secret, then restart this Deployment.',
  );
}

/**
 * Whether the target web server enforces auth at all, resolved once from
 * /api/health.
 *
 * The e2e harness repoints this operator at a test namespace running a web
 * server with AUTH_DISABLED=1; minting keys against it would be pointless (and
 * that server has no session secret configured). Asking the server rather than
 * inferring from local config keeps the operator correct in both worlds.
 *
 * Failure to reach health is treated as "auth enabled": attempting to mint and
 * falling back is safer than assuming a dev cluster.
 */
let authEnabledPromise: Promise<boolean> | null = null;

async function isAuthEnabled(): Promise<boolean> {
  authEnabledPromise ??= (async () => {
    try {
      const res = await fetch(`${WEB_STATS_URL}/api/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return true;
      const body = (await res.json()) as { authDisabled?: boolean };
      if (body.authDisabled === true) {
        log('web server reports auth disabled — per-run keys will not be minted');
        return false;
      }
      return true;
    } catch {
      return true;
    }
  })();
  return authEnabledPromise;
}

export async function mintRunKey(args: MintRunKeyArgs): Promise<string | null> {
  if (!(await isAuthEnabled())) return null;

  if (!WEB_AUTH_TOKEN) {
    warnMissingTokenOnce();
    return null;
  }

  try {
    const res = await fetch(`${WEB_STATS_URL}/api/internal/run-keys`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`mint for ${args.runName} failed: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== 'string' || body.key.length === 0) {
      log(`mint for ${args.runName} returned no key`);
      return null;
    }
    return body.key;
  } catch (e) {
    log(`mint for ${args.runName} failed:`, (e as Error).message);
    return null;
  }
}

/**
 * Revoke a run's key. Best-effort: keys also carry an expiry, so a missed
 * revocation self-heals rather than leaving a credential valid indefinitely.
 */
export async function revokeRunKey(runName: string): Promise<void> {
  if (!WEB_AUTH_TOKEN) return;
  if (!(await isAuthEnabled())) return;

  try {
    const res = await fetch(
      `${WEB_STATS_URL}/api/internal/run-keys/${encodeURIComponent(runName)}`,
      {
        method: 'DELETE',
        headers: headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      log(`revoke for ${runName} failed: HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { revoked?: number };
    if (body.revoked) log(`revoked key for ${runName}`);
  } catch (e) {
    log(`revoke for ${runName} failed:`, (e as Error).message);
  }
}
