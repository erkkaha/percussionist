// `beatctl tailscale-auth create` — store a Tailscale auth key in a
// Kubernetes Secret for use with the tailscale sidecar in the web pod.
//
// The resulting Secret is referenced by the web Deployment; the tailscale
// sidecar uses TS_AUTHKEY to auto-provision and serve HTTPS via Tailscale.
//
// Usage:
//   beatctl tailscale-auth create                          # reads $TS_AUTHKEY
//   beatctl tailscale-auth create --key tskey-auth-xxxxx
//   beatctl tailscale-auth create --name my-key -n my-ns
//
// The command is idempotent: if the Secret already exists it is replaced.

import type { V1Secret } from '@kubernetes/client-node';
import { fatal, loadKube } from './kube.js';

export interface TailscaleAuthCreateOpts {
  namespace: string;
  name: string;
  key?: string;
  dryRun?: boolean;
}

function resolveKey(override?: string): string {
  if (override?.trim()) return override.trim();

  const fromEnv = process.env.TS_AUTHKEY;
  if (fromEnv?.trim()) return fromEnv.trim();

  console.error(
    'beatctl: no Tailscale auth key provided. ' +
      'Pass it with --key <key> or set the TS_AUTHKEY environment variable.',
  );
  process.exit(1);
}

function looksLikeKey(key: string): boolean {
  return /^tskey-auth-/.test(key);
}

async function upsertKeySecret(
  namespace: string,
  name: string,
  key: string,
): Promise<'created' | 'updated'> {
  const { core } = loadKube();

  const body: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'percussionist',
        'percussionist.dev/component': 'tailscale-auth',
      },
    },
    type: 'Opaque',
    stringData: {
      key,
    },
  };

  try {
    await core.readNamespacedSecret({ name, namespace });
    await core.replaceNamespacedSecret({ name, namespace, body });
    return 'updated';
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 404) throw e;
    await core.createNamespacedSecret({ namespace, body });
    return 'created';
  }
}

export async function runTailscaleAuthCreate(opts: TailscaleAuthCreateOpts): Promise<void> {
  const key = resolveKey(opts.key);

  if (!looksLikeKey(key)) {
    console.error(
      "beatctl: warning: key doesn't look like a Tailscale auth key " +
        '(expected prefix: tskey-auth-). ' +
        'Proceeding anyway.',
    );
  }

  const secretName = opts.name;
  const ns = opts.namespace;

  console.error(`Secret:    "${secretName}" (type: Opaque) in ns "${ns}"`);
  console.error(`Key field: key`);

  if (opts.dryRun) {
    console.error('\n--dry-run: no changes made.');
    return;
  }

  const action = await upsertKeySecret(ns, secretName, key).catch((e) => fatal('upsert secret', e));

  console.error(`\nSecret ${action}.`);
  console.error(
    '\nRestart the web pod to pick up the new key:\n' +
      `  kubectl -n ${ns} rollout restart deploy/percussionist-web`,
  );
}
