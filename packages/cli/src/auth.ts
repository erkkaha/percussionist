// `beatctl auth import` — push the user's local opencode auth.json into
// a cluster Secret so run pods can consume it via OPENCODE_AUTH_CONTENT.
//
// Why this exists
// ---------------
// Several opencode providers only auth via OAuth device-code flow (GitHub
// Copilot, ChatGPT Plus, Claude Pro). There's no static API key to drop
// into `llmKeysSecret`. The resulting credentials land in
// $XDG_DATA_HOME/opencode/auth.json on the workstation where the user ran
// `opencode auth login <provider>`. opencode also respects an
// `OPENCODE_AUTH_CONTENT` env var holding the same JSON — so the path is:
//
//   workstation: `opencode auth login github-copilot`   (once, interactively)
//   workstation: `beatctl auth import`                  (copy into cluster)
//   cluster:     spec.secrets.authSecret        (operator wires env)
//   pod:         opencode reads OPENCODE_AUTH_CONTENT   (zero config)
//
// Default behaviour is "import every provider found locally" because
// that's what most users want the first time. Filter with `--provider`.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoreV1Api, V1Secret } from '@kubernetes/client-node';
import { fatal, loadKube } from './kube.js';

export interface AuthImportOpts {
  namespace: string;
  name: string;
  key: string;
  provider?: string[];
  file?: string;
  dryRun?: boolean;
}

// opencode's auth.json shape (subset we need). We don't re-validate the
// entries — that's opencode's job. We just pass the blob through.
type AuthEntry = Record<string, unknown>;
type AuthFile = Record<string, AuthEntry>;

function authJsonPath(override?: string): string {
  if (override) return override;
  // Honour $XDG_DATA_HOME first (opencode does the same), fall back to
  // the Linux/macOS default of ~/.local/share. Windows is outside
  // percussionist's support surface.
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'auth.json');
}

function readAuth(file: string): AuthFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error(`beatctl: ${file} not found. Run \`opencode auth login <provider>\` first.`);
      process.exit(1);
    }
    throw e;
  }
  try {
    const obj = JSON.parse(raw) as AuthFile;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('expected a JSON object at the top level');
    }
    return obj;
  } catch (e) {
    console.error(`beatctl: failed to parse ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Present a token safely — never print the raw value, but give enough
// signal that the user can tell providers apart ("yes that's the right
// Copilot account").
function summarise(entry: AuthEntry): string {
  const parts: string[] = [];
  const t = typeof entry.type === 'string' ? entry.type : 'unknown';
  parts.push(`type=${t}`);
  if (t === 'oauth') {
    // Show only provenance-level hints. `refresh`/`access` are the same
    // long-lived GitHub OAuth token for copilot; for other providers the
    // distinction may matter, but we don't need to know.
    const ref = typeof entry.refresh === 'string' ? entry.refresh : '';
    if (ref) parts.push(`token=${ref.slice(0, 4)}…${ref.slice(-4)} (${ref.length}c)`);
    if (typeof entry.enterpriseUrl === 'string' && entry.enterpriseUrl) {
      parts.push(`ghe=${entry.enterpriseUrl}`);
    }
  } else if (t === 'api') {
    const k = typeof entry.key === 'string' ? entry.key : '';
    if (k) parts.push(`key=${k.slice(0, 4)}…${k.slice(-4)} (${k.length}c)`);
  }
  return parts.join(', ');
}

async function upsertSecret(
  core: CoreV1Api,
  namespace: string,
  name: string,
  key: string,
  jsonBlob: string,
): Promise<'created' | 'updated'> {
  const body: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        // Mirror the managed-by convention even though the operator
        // doesn't reconcile this Secret — helps humans running kubectl.
        'app.kubernetes.io/managed-by': 'percussionist',
        'percussionist.dev/component': 'auth',
      },
    },
    type: 'Opaque',
    stringData: { [key]: jsonBlob },
  };

  try {
    await core.readNamespacedSecret({ name, namespace });
    // Exists: replace. We prefer replace over patch here because the
    // user's auth.json is authoritative — partial merges invite
    // "stale entry kept around" bugs after a logout.
    await core.replaceNamespacedSecret({ name, namespace, body });
    return 'updated';
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 404) throw e;
    await core.createNamespacedSecret({ namespace, body });
    return 'created';
  }
}

export async function runAuthImport(opts: AuthImportOpts): Promise<void> {
  const file = authJsonPath(opts.file);
  const auth = readAuth(file);
  const allProviders = Object.keys(auth);

  if (allProviders.length === 0) {
    console.error(`beatctl: ${file} is empty. Run \`opencode auth login <provider>\` first.`);
    process.exit(1);
  }

  // Resolve the requested filter. --provider is repeatable; absent
  // means "import everything" per the session design decision.
  let pick: string[];
  if (opts.provider && opts.provider.length > 0) {
    const missing = opts.provider.filter((p) => !(p in auth));
    if (missing.length > 0) {
      console.error(`beatctl: provider(s) not found in ${file}: ${missing.join(', ')}`);
      console.error(`         available: ${allProviders.join(', ')}`);
      process.exit(1);
    }
    pick = opts.provider;
  } else {
    pick = allProviders;
  }

  const subset: AuthFile = {};
  for (const id of pick) {
    const entry = auth[id];
    if (!entry) {
      console.error(`Provider "${id}" not found in auth file`);
      process.exit(1);
    }
    subset[id] = entry;
  }

  // Human-readable preamble. Always printed, including under --dry-run.
  console.error(`Source: ${file}`);
  console.error(`Target: Secret "${opts.name}" (key "${opts.key}") in ns "${opts.namespace}"`);
  console.error('Providers:');
  for (const id of pick) {
    const entry = auth[id];
    if (!entry) {
      console.error(`Provider "${id}" not found in auth file`);
      process.exit(1);
    }
    console.error(`  - ${id}  [${summarise(entry)}]`);
  }

  const blob = JSON.stringify(subset);

  if (opts.dryRun) {
    console.error(`\n--dry-run: no changes made. Secret payload size: ${blob.length} bytes.`);
    return;
  }

  const { core } = loadKube();
  const action = await upsertSecret(core, opts.namespace, opts.name, opts.key, blob).catch((e) =>
    fatal('upsert secret', e),
  );
  console.error(`\nSecret ${action}.`);
  console.error(`\nReference it in Run specs with:`);
  console.error(`  spec:`);
  console.error(`    secrets:`);
  console.error(`      authSecret:`);
  console.error(`        name: ${opts.name}`);
  if (opts.key !== 'auth.json') {
    console.error(`        key: ${opts.key}`);
  }
  console.error(
    `\nOr with beatctl submit --auth-secret ${opts.name}${opts.key !== 'auth.json' ? ` --auth-key ${opts.key}` : ''}.`,
  );
}

// ---------------------------------------------------------------------------
// `beatctl auth web-token` — manage the web UI auth token.
//
// The token is stored in a K8s Secret named "web-auth" with keys:
//   token     — the AUTH_SECRET value (any string)
//   disabled  — "1" when auth is disabled, absent otherwise
//
// The web Deployment reads these via envFrom/secretKeyRef (see k8s/deploy/web.yaml).

const WEB_AUTH_SECRET = 'web-auth';
const TOKEN_KEY = 'token';
const DISABLED_KEY = 'disabled';

export interface WebTokenShowOpts {
  namespace: string;
}

export async function runWebTokenShow(opts: WebTokenShowOpts): Promise<void> {
  const { core } = loadKube();

  let secret: V1Secret;
  try {
    secret = await core.readNamespacedSecret({ name: WEB_AUTH_SECRET, namespace: opts.namespace });
  } catch {
    console.error('beatctl: no web-auth Secret found — auth is not configured.');
    console.error('         Set a token with: beatctl auth web-token set <token>');
    process.exit(1);
  }

  const token = secret.data?.[TOKEN_KEY];
  const disabled = secret.data?.[DISABLED_KEY];
  const isDisabled = disabled && atob(disabled) === '1';

  if (token) {
    const decoded = atob(token);
    console.log(decoded);
  }

  if (isDisabled) {
    console.error(
      '\nAuth is DISABLED (AUTH_DISABLED=1). Use `beatctl auth web-token enable` to enforce.',
    );
  } else if (!token) {
    console.error('\nNo token set. Auth is effectively disabled (AUTH_SECRET is empty).');
    console.error('Set a token with: beatctl auth web-token set <token>');
  }
}

export interface WebTokenSetOpts {
  namespace: string;
  token: string;
  dryRun?: boolean;
}

export async function runWebTokenSet(opts: WebTokenSetOpts): Promise<void> {
  const { core } = loadKube();

  const body: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: WEB_AUTH_SECRET,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'percussionist',
        'percussionist.dev/component': 'web-auth',
      },
    },
    type: 'Opaque',
    stringData: { [TOKEN_KEY]: opts.token },
  };

  if (opts.dryRun) {
    console.error(
      `--dry-run: would create/update Secret "${WEB_AUTH_SECRET}" in ns "${opts.namespace}"`,
    );
    return;
  }

  try {
    await core.readNamespacedSecret({ name: WEB_AUTH_SECRET, namespace: opts.namespace });
    await core.replaceNamespacedSecret({ name: WEB_AUTH_SECRET, namespace: opts.namespace, body });
    console.error(`Updated Secret "${WEB_AUTH_SECRET}" in ns "${opts.namespace}".`);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 404) throw e;
    await core.createNamespacedSecret({ namespace: opts.namespace, body });
    console.error(`Created Secret "${WEB_AUTH_SECRET}" in ns "${opts.namespace}".`);
  }

  console.error('\nAuth token updated. The web pod will pick it up on next restart.');
  console.error('If auth was previously disabled, re-enable with:\n');
  console.error('  beatctl auth web-token enable');
  console.error('  kubectl -n percussionist rollout restart deploy/percussionist-web');
}

export interface WebTokenRotateOpts {
  namespace: string;
  dryRun?: boolean;
}

export async function runWebTokenRotate(opts: WebTokenRotateOpts): Promise<void> {
  const token = randomBytes(32).toString('hex');
  if (opts.dryRun) {
    console.error(`--dry-run: would set token to "${token}"`);
    return;
  }
  await runWebTokenSet({ namespace: opts.namespace, token, dryRun: false });
}

export interface WebTokenToggleOpts {
  namespace: string;
  disable: boolean;
  dryRun?: boolean;
}

export async function runWebTokenToggle(opts: WebTokenToggleOpts): Promise<void> {
  const { core } = loadKube();

  if (opts.dryRun) {
    console.error(
      `--dry-run: would ${opts.disable ? 'disable' : 'enable'} auth on Secret "${WEB_AUTH_SECRET}"`,
    );
    return;
  }

  if (opts.disable) {
    // Upsert with disabled="1"
    const body: V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: WEB_AUTH_SECRET,
        namespace: opts.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'percussionist',
          'percussionist.dev/component': 'web-auth',
        },
      },
      type: 'Opaque',
      stringData: { [DISABLED_KEY]: '1' },
    };

    try {
      await core.readNamespacedSecret({ name: WEB_AUTH_SECRET, namespace: opts.namespace });
      await core.replaceNamespacedSecret({
        name: WEB_AUTH_SECRET,
        namespace: opts.namespace,
        body,
      });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 404) throw e;
      await core.createNamespacedSecret({ namespace: opts.namespace, body });
    }
    console.error(`Auth DISABLED for ns "${opts.namespace}". Restart the web pod to apply:\n`);
    console.error(`  kubectl -n ${opts.namespace} rollout restart deploy/percussionist-web`);
  } else {
    // Remove the disabled key from the Secret.
    try {
      const existing = await core.readNamespacedSecret({
        name: WEB_AUTH_SECRET,
        namespace: opts.namespace,
      });
      delete existing.data?.[DISABLED_KEY];
      if (existing.data) {
        existing.stringData = {};
        for (const [k, v] of Object.entries(existing.data)) {
          existing.stringData[k] = atob(v);
        }
        delete existing.data;
      }
      await core.replaceNamespacedSecret({
        name: WEB_AUTH_SECRET,
        namespace: opts.namespace,
        body: existing,
      });
      console.error(`Auth ENABLED for ns "${opts.namespace}". Restart the web pod to apply:\n`);
      console.error(`  kubectl -n ${opts.namespace} rollout restart deploy/percussionist-web`);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 404) {
        console.error('beatctl: no web-auth Secret found. Set a token first with:\n');
        console.error('  beatctl auth web-token set <token>');
      } else {
        throw e;
      }
    }
  }
}
