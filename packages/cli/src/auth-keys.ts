// auth-keys.ts — `beatctl auth key list|rotate` and `beatctl auth github|session-secret`.
//
// Key inventory and rotation go through the web API, because the web server owns
// the database that holds the keys. GitHub App credentials and the session secret
// are plain Secret values, so those are written straight to Kubernetes.

import { randomBytes } from 'node:crypto';
import type { V1Secret } from '@kubernetes/client-node';
import { DEFAULT_NAMESPACE, loadKube } from './kube.js';
import { webRequest, withWebApi } from './web-client.js';

const WEB_AUTH_SECRET = 'web-auth';

// ---------------------------------------------------------------------------
// `beatctl auth key list`

interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean | null;
  permissions: Record<string, string[]> | null;
  metadata: Record<string, unknown> | null;
  requestCount: number | null;
  lastRequest: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface AuthKeyListOpts {
  namespace?: string;
  json?: boolean;
}

export async function runAuthKeyList(opts: AuthKeyListOpts): Promise<void> {
  await withWebApi(opts.namespace, async (baseUrl) => {
    let items: KeyRow[];
    try {
      const body = await webRequest<{ items: KeyRow[] }>(baseUrl, '/api/internal/agent-keys');
      items = body.items;
    } catch (e) {
      console.error('beatctl:', (e as Error).message);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log('No agent keys.');
      return;
    }

    const fmtScopes = (p: Record<string, string[]> | null) =>
      p
        ? Object.entries(p)
            .map(([r, actions]) => `${r}:${actions.join('|')}`)
            .join(' ')
        : '—';
    const fmtDate = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 16) : '—');

    const rows = items.map((k) => ({
      name: k.name ?? '(unnamed)',
      scopes: fmtScopes(k.permissions),
      expires: fmtDate(k.expiresAt),
      used: String(k.requestCount ?? 0),
      last: fmtDate(k.lastRequest),
    }));

    const widths = {
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      scopes: Math.max(6, ...rows.map((r) => r.scopes.length)),
      expires: 16,
      used: Math.max(4, ...rows.map((r) => r.used.length)),
    };
    const pad = (s: string, n: number) => s.padEnd(n);

    console.log(
      `${pad('NAME', widths.name)}  ${pad('SCOPES', widths.scopes)}  ${pad('EXPIRES', widths.expires)}  ${pad('USED', widths.used)}  LAST USED`,
    );
    for (const r of rows) {
      console.log(
        `${pad(r.name, widths.name)}  ${pad(r.scopes, widths.scopes)}  ${pad(r.expires, widths.expires)}  ${pad(r.used, widths.used)}  ${r.last}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// `beatctl auth key rotate <component>`

export interface AuthKeyRotateOpts {
  namespace?: string;
}

/**
 * Components permitted for `auth key rotate` — mirrors the web server's
 * COMPONENTS table (operator + manager standing keys). The component is
 * interpolated into both the web API path AND the printed kubectl rollout
 * command, so arbitrary input must be rejected rather than echoed (E item).
 */
const ROTATE_COMPONENT_WHITELIST = ['operator', 'manager'];

export function assertRotatableComponent(component: string): void {
  if (!ROTATE_COMPONENT_WHITELIST.includes(component)) {
    throw new Error(
      `unknown component '${component}'. Known: ${ROTATE_COMPONENT_WHITELIST.join(', ')}`,
    );
  }
}

export async function runAuthKeyRotate(component: string, opts: AuthKeyRotateOpts): Promise<void> {
  assertRotatableComponent(component);
  await withWebApi(opts.namespace, async (baseUrl) => {
    try {
      const body = await webRequest<{ secret: string; message: string }>(
        baseUrl,
        `/api/internal/agent-keys/${encodeURIComponent(component)}/rotate`,
        { method: 'POST' },
      );
      console.log(body.message);
      console.log('');
      console.log(
        `  kubectl -n ${opts.namespace ?? DEFAULT_NAMESPACE} rollout restart deploy/percussionist-${component}`,
      );
    } catch (e) {
      console.error('beatctl:', (e as Error).message);
      process.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// Secret plumbing for the values web reads at startup

// Exported for unit tests (create-vs-replace / key-preservation semantics are
// exercised with an injected fake CoreV1Api).
export async function patchWebAuthSecret(
  namespace: string,
  data: Record<string, string>,
  dryRun: boolean,
  coreOverride?: import('@kubernetes/client-node').CoreV1Api,
  removeKeys: string[] = [],
): Promise<void> {
  const core = coreOverride ?? (await loadKube()).core;

  if (dryRun) {
    const setKeys = Object.keys(data);
    const removalMessages = removeKeys.map((k) => `-${k}`);
    console.error(
      `--dry-run: would set ${[...setKeys, ...removalMessages].join(', ')} on Secret "${WEB_AUTH_SECRET}" in ns "${namespace}"`,
    );
    return;
  }

  let existing: V1Secret | null = null;
  try {
    existing = await core.readNamespacedSecret({ name: WEB_AUTH_SECRET, namespace });
  } catch {
    existing = null;
  }

  // Enabling on a Secret that doesn't exist yet is a no-op — there's nothing
  // to clear, and we must not create an empty Secret. Point the user at set.
  if (existing === null && Object.keys(data).length === 0) {
    console.error('beatctl: no web-auth Secret found. Set a token first with:\n');
    console.error('  beatctl auth web-token set <token>');
    return;
  }

  // Carry forward every existing key we're not explicitly removing, then
  // overlay the keys we were asked to set (stringData wins for overlaps).
  const merged: Record<string, string> = { ...(existing?.data ?? {}) };
  for (const key of removeKeys) {
    delete merged[key];
  }

  const body: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: WEB_AUTH_SECRET, namespace },
    data: merged,
    stringData: data,
  };

  if (existing) {
    await core.replaceNamespacedSecret({ name: WEB_AUTH_SECRET, namespace, body });
    console.error(`Updated Secret "${WEB_AUTH_SECRET}" in ns "${namespace}".`);
  } else {
    await core.createNamespacedSecret({ namespace, body });
    console.error(`Created Secret "${WEB_AUTH_SECRET}" in ns "${namespace}".`);
  }
  console.error('');
  console.error('Restart the web server to pick it up:');
  console.error(`  kubectl -n ${namespace} rollout restart deploy/percussionist-web`);
}

// ---------------------------------------------------------------------------
// `beatctl auth github set-app` / `allow`

export interface GithubSetAppOpts {
  namespace: string;
  clientId: string;
  clientSecret: string;
  dryRun?: boolean;
}

export async function runGithubSetApp(opts: GithubSetAppOpts): Promise<void> {
  await patchWebAuthSecret(
    opts.namespace,
    {
      'github-client-id': opts.clientId,
      'github-client-secret': opts.clientSecret,
    },
    opts.dryRun === true,
  );
}

export interface GithubAllowOpts {
  namespace: string;
  logins: string[];
  dryRun?: boolean;
}

export async function runGithubAllow(opts: GithubAllowOpts): Promise<void> {
  const value = opts.logins
    .map((l) => l.trim())
    .filter(Boolean)
    .join(',');
  if (!value) {
    console.error('beatctl: at least one GitHub login is required.');
    process.exit(1);
  }
  console.error(`Allowing GitHub logins: ${value}`);
  console.error('(this replaces the existing allowlist)');
  await patchWebAuthSecret(
    opts.namespace,
    { 'github-allowed-logins': value },
    opts.dryRun === true,
  );
}

// ---------------------------------------------------------------------------
// `beatctl auth session-secret rotate`

export interface SessionSecretOpts {
  namespace: string;
  dryRun?: boolean;
}

export async function runSessionSecretRotate(opts: SessionSecretOpts): Promise<void> {
  const secret = randomBytes(32).toString('hex');
  console.error('Rotating the session signing secret — this signs every existing');
  console.error('browser session out.');
  await patchWebAuthSecret(opts.namespace, { 'session-secret': secret }, opts.dryRun === true);
}

// ---------------------------------------------------------------------------
// `beatctl auth mcp-token rotate`
//
// Shared between the web pod and the manager pod; both must be restarted.

export async function runMcpTokenRotate(opts: SessionSecretOpts): Promise<void> {
  const { core } = loadKube();
  const token = randomBytes(32).toString('hex');
  const name = 'manager-mcp-token';

  if (opts.dryRun) {
    console.error(`--dry-run: would create/update Secret "${name}" in ns "${opts.namespace}"`);
    return;
  }

  const body: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: opts.namespace },
    stringData: { token },
  };

  try {
    await core.readNamespacedSecret({ name, namespace: opts.namespace });
    await core.replaceNamespacedSecret({ name, namespace: opts.namespace, body });
    console.error(`Updated Secret "${name}" in ns "${opts.namespace}".`);
  } catch {
    await core.createNamespacedSecret({ namespace: opts.namespace, body });
    console.error(`Created Secret "${name}" in ns "${opts.namespace}".`);
  }

  console.error('');
  console.error('Restart both pods that share it:');
  console.error(`  kubectl -n ${opts.namespace} rollout restart deploy/percussionist-web`);
  console.error(`  kubectl -n ${opts.namespace} rollout restart deploy/percussionist-manager`);
}
