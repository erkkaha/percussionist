// lib/agent-keys.ts — minting, revoking and bootstrapping agent API keys.
//
// Agent keys are owned by a synthetic service user rather than by the human
// operator's account, so that deleting or re-creating the operator's GitHub
// login does not cascade-delete every agent credential.
//
// Two lifetimes:
//
//   * Standing keys — one per long-lived component (operator, manager
//     controller). Created on web startup if missing and written into a
//     dedicated k8s Secret that the component mounts. Web is the only
//     component with database access, so it is the only one that can mint
//     these; doing it at startup avoids a bootstrap chicken-and-egg where you
//     would need a credential in order to create the first credential.
//
//   * Per-run keys — one per Run, minted by the operator through
//     POST /api/internal/run-keys, scoped to stats:write only, expiring shortly
//     after the run's timeout, and revoked when the run reaches a terminal
//     phase. This is what makes the token in a run pod's environment
//     uninteresting to steal.
//
// Reads and deletes go straight to the `apikey` table via drizzle — we own the
// database, and deleting the row *is* revocation. Creation goes through
// better-auth so the key is hashed and formatted the way verification expects.

import { and, eq, like, lt } from 'drizzle-orm';
import { getDb } from '../db.js';
import { core, NAMESPACE } from '../kube.js';
import { apikey, user } from '../schema.js';
import {
  getAuth,
  MANAGER_KEY_PERMISSIONS,
  OPERATOR_KEY_PERMISSIONS,
  RUN_KEY_PERMISSIONS,
} from './better-auth.js';
import { upsertSecret } from './kube-upsert.js';

const log = (...args: unknown[]) => console.log('[agent-keys]', ...args);

/** Owner of every agent key. Not a login — there is no credential on this row. */
export const SERVICE_USER_ID = 'svc-percussionist-agents';

const RUN_KEY_PREFIX = 'run:';
const COMPONENT_KEY_PREFIX = 'component:';

/** Grace period added to a run's timeout before its key expires. */
const RUN_KEY_GRACE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Standing component keys

export const COMPONENTS = {
  operator: {
    /** Secret the operator Deployment mounts as WEB_AUTH_TOKEN. */
    secretName: 'operator-api-key',
    permissions: OPERATOR_KEY_PERMISSIONS,
  },
  manager: {
    secretName: 'manager-api-key',
    permissions: MANAGER_KEY_PERMISSIONS,
  },
} as const;

export type ComponentName = keyof typeof COMPONENTS;

// ---------------------------------------------------------------------------
// Service user

export async function ensureServiceUser(): Promise<string> {
  const db = getDb();
  const existing = await db.select().from(user).where(eq(user.id, SERVICE_USER_ID)).limit(1);
  if (existing.length > 0) return SERVICE_USER_ID;

  const now = new Date();
  await db
    .insert(user)
    .values({
      id: SERVICE_USER_ID,
      name: 'Percussionist agents',
      // .invalid is reserved by RFC 2606 and can never receive mail, which is
      // the point: this row must not be usable as a sign-in identity.
      email: 'agents@percussionist.invalid',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return SERVICE_USER_ID;
}

// ---------------------------------------------------------------------------
// Minting

export interface MintOptions {
  /** Human-readable key name; also the handle used to revoke it. */
  name: string;
  permissions: Record<string, string[]>;
  /** Seconds until expiry. Omit for a non-expiring key. */
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Create a key and return its plaintext value.
 *
 * The plaintext is only ever available here — the database stores a SHA-256
 * hash — so the caller must persist it (into a Secret or a pod env var) before
 * discarding it.
 *
 * Called with no `headers`, which better-auth treats as a trusted server-side
 * call. That matters: `permissions` is rejected as a "server only property" on
 * any request that carries headers, so scopes can only be set from in-process
 * code like this. It is also why the operator mints run keys through our own
 * endpoint instead of better-auth's public create endpoint.
 */
export async function mintKey(opts: MintOptions): Promise<string> {
  const userId = await ensureServiceUser();
  const created = await getAuth().api.createApiKey({
    body: {
      name: opts.name,
      userId,
      permissions: opts.permissions,
      ...(opts.expiresInSeconds ? { expiresIn: opts.expiresInSeconds } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
  });
  return created.key;
}

/** Delete every key with this exact name. Returns how many were revoked. */
export async function revokeKeysByName(name: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(apikey)
    .where(and(eq(apikey.name, name), eq(apikey.referenceId, SERVICE_USER_ID)))
    .returning({ id: apikey.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Per-run keys

export function runKeyName(runName: string): string {
  return `${RUN_KEY_PREFIX}${runName}`;
}

export interface RunKeyRequest {
  runName: string;
  runUid?: string;
  project?: string;
  /** The run's timeout; the key outlives it by RUN_KEY_GRACE_SECONDS. */
  timeoutSeconds?: number;
}

export async function mintRunKey(req: RunKeyRequest): Promise<{ key: string; expiresIn: number }> {
  // Re-minting for the same run replaces the old key, so a reconcile that
  // retries pod creation cannot leave orphans behind.
  await revokeKeysByName(runKeyName(req.runName));

  const expiresIn = (req.timeoutSeconds ?? 3600) + RUN_KEY_GRACE_SECONDS;
  const key = await mintKey({
    name: runKeyName(req.runName),
    permissions: RUN_KEY_PERMISSIONS,
    expiresInSeconds: expiresIn,
    metadata: {
      kind: 'run',
      runName: req.runName,
      ...(req.runUid ? { runUid: req.runUid } : {}),
      ...(req.project ? { project: req.project } : {}),
    },
  });
  return { key, expiresIn };
}

export async function revokeRunKey(runName: string): Promise<number> {
  return revokeKeysByName(runKeyName(runName));
}

/**
 * Drop run keys whose expiry has passed.
 *
 * better-auth deletes an expired key the next time it is presented, but a run
 * whose pod died never presents its key again — without this, those rows would
 * accumulate forever. Expired keys are already refused by verification, so this
 * is housekeeping rather than a security control.
 */
export async function pruneExpiredRunKeys(): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(apikey)
    .where(
      and(
        eq(apikey.referenceId, SERVICE_USER_ID),
        like(apikey.name, `${RUN_KEY_PREFIX}%`),
        lt(apikey.expiresAt, new Date()),
      ),
    )
    .returning({ id: apikey.id });
  if (rows.length > 0) log(`pruned ${rows.length} expired run key(s)`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Standing component keys — bootstrap & rotation

function componentKeyName(component: ComponentName): string {
  return `${COMPONENT_KEY_PREFIX}${component}`;
}

/**
 * Mint a fresh key for a component and write it into that component's Secret,
 * revoking whatever key it held before.
 *
 * The component reads the Secret via secretKeyRef, so its Deployment must be
 * restarted to observe a rotation — env vars are resolved at pod start.
 */
export async function rotateComponentKey(component: ComponentName): Promise<string> {
  const { secretName, permissions } = COMPONENTS[component];
  await revokeKeysByName(componentKeyName(component));
  const key = await mintKey({
    name: componentKeyName(component),
    permissions,
    metadata: { kind: 'component', component },
  });
  await upsertSecret(secretName, { token: key });
  log(`rotated key for ${component} into Secret ${secretName}`);
  return key;
}

/**
 * Ensure every standing component has a key and a populated Secret.
 *
 * Runs on web startup. Idempotent: a component that already has both a key row
 * and a Secret is left alone, because the plaintext cannot be recovered from
 * the database to rewrite the Secret with.
 */
export async function bootstrapAgentKeys(): Promise<void> {
  const db = getDb();
  for (const component of Object.keys(COMPONENTS) as ComponentName[]) {
    const { secretName } = COMPONENTS[component];
    try {
      const rows = await db
        .select({ id: apikey.id })
        .from(apikey)
        .where(
          and(
            eq(apikey.name, componentKeyName(component)),
            eq(apikey.referenceId, SERVICE_USER_ID),
          ),
        )
        .limit(1);
      const secretHasToken = await secretTokenExists(secretName);

      if (rows.length > 0 && secretHasToken) continue;

      // Either side missing means the pair is out of sync — the key row without
      // a Secret is unusable (plaintext is unrecoverable), and a Secret without
      // a key row would fail verification. Mint a fresh pair.
      await rotateComponentKey(component);
    } catch (e) {
      // Never block startup on this: the cluster may not grant Secret access in
      // every environment (e2e namespaces, local dev without kube).
      console.error(`[agent-keys] bootstrap for ${component} failed:`, (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Secret plumbing

async function secretTokenExists(name: string): Promise<boolean> {
  try {
    const secret = await core().readNamespacedSecret({ name, namespace: NAMESPACE });
    const token = secret.data?.token;
    return typeof token === 'string' && token.length > 0;
  } catch {
    return false;
  }
}
