// routes/run-keys.ts — per-run API key minting for the operator.
//
// Why this exists rather than letting the operator call better-auth's public
// /api/auth/api-key/create: better-auth rejects `permissions` on any request
// that carries headers ("server only property"), so scopes can only be set from
// in-process code. Owning the endpoint also means the granted scope is fixed
// here — the operator asks for "a key for run X" and cannot ask for a broader
// one, so a stolen operator credential does not escalate.
//
//   POST   /api/internal/run-keys           → mint a key for a run
//   DELETE /api/internal/run-keys/:runName  → revoke it
//
// Both require the operator's key (permission runkeys:mint) or a human session.

import { Hono } from 'hono';
import { scoped } from '../auth.js';
import { mintRunKey, revokeRunKey } from '../lib/agent-keys.js';

const runKeys = new Hono();

interface MintBody {
  runName?: unknown;
  runUid?: unknown;
  project?: unknown;
  timeoutSeconds?: unknown;
}

runKeys.post('/', scoped('runkeys', 'mint'), async (c) => {
  // Dev/e2e mode: there is nothing to scope down to, and no session secret with
  // which to mint. Answer successfully with no key so the operator falls back to
  // the shared token instead of treating this as an error.
  if (process.env.AUTH_DISABLED === '1') {
    return c.json({ key: null, authDisabled: true });
  }

  let body: MintBody;
  try {
    body = (await c.req.json()) as MintBody;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const runName = typeof body.runName === 'string' ? body.runName.trim() : '';
  if (!runName) {
    return c.json({ error: 'runName is required' }, 400);
  }

  const timeoutSeconds =
    typeof body.timeoutSeconds === 'number' && Number.isFinite(body.timeoutSeconds)
      ? Math.max(60, Math.floor(body.timeoutSeconds))
      : undefined;

  try {
    const { key, expiresIn } = await mintRunKey({
      runName,
      runUid: typeof body.runUid === 'string' ? body.runUid : undefined,
      project: typeof body.project === 'string' ? body.project : undefined,
      timeoutSeconds,
    });
    // The plaintext is returned exactly once — it is not recoverable from the
    // database afterwards.
    return c.json({ key, expiresIn }, 201);
  } catch (e) {
    console.error(`[run-keys] mint for ${runName} failed:`, (e as Error).message);
    return c.json({ error: 'Failed to mint run key' }, 500);
  }
});

runKeys.delete('/:runName', scoped('runkeys', 'mint'), async (c) => {
  const runName = c.req.param('runName');
  try {
    const revoked = await revokeRunKey(runName);
    return c.json({ revoked });
  } catch (e) {
    console.error(`[run-keys] revoke for ${runName} failed:`, (e as Error).message);
    return c.json({ error: 'Failed to revoke run key' }, 500);
  }
});

export default runKeys;
