// `beatctl ssh-key create` — create or update a kubernetes.io/ssh-auth Secret
// from a local SSH private key file.
//
// This is the one-liner that bridges "I have an SSH key on my laptop" and
// "the cluster knows about it" for private repo cloning. The resulting Secret
// is the exact format expected by spec.source.git.sshSecret.
//
// Usage:
//   beatctl ssh-key create                          # uses ~/.ssh/id_ed25519
//   beatctl ssh-key create --key ~/.ssh/deploy_key
//   beatctl ssh-key create --name myrepo-key -n my-ns
//
// The command is idempotent: if the Secret already exists it is replaced
// (same reasoning as `beatctl auth import` — the local key is authoritative).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { V1Secret } from "@kubernetes/client-node";
import { DEFAULT_NAMESPACE, fatal, loadKube } from "./kube.js";

export interface SshKeyCreateOpts {
  namespace: string;
  name: string;
  key?: string;
  dryRun?: boolean;
}

// Ordered list of key file candidates tried when --key is omitted.
const DEFAULT_KEY_CANDIDATES = [
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "id_dsa",
];

function resolveKeyPath(override?: string): string {
  if (override) {
    const p = path.resolve(override);
    if (!fs.existsSync(p)) {
      console.error(`beatctl: key file not found: ${p}`);
      process.exit(1);
    }
    return p;
  }

  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of DEFAULT_KEY_CANDIDATES) {
    const candidate = path.join(sshDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  console.error(
    "beatctl: no SSH private key found in ~/.ssh. " +
      "Generate one with `ssh-keygen -t ed25519` or use --key <path>.",
  );
  process.exit(1);
}

function readKeyFile(keyPath: string): string {
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (e) {
    const nodeErr = e as NodeJS.ErrnoException;
    if (nodeErr.code === "EACCES") {
      console.error(`beatctl: permission denied reading ${keyPath}.`);
    } else {
      console.error(`beatctl: failed to read ${keyPath}: ${nodeErr.message}`);
    }
    process.exit(1);
  }
}

function isLikelyPrivateKey(content: string): boolean {
  return (
    content.includes("BEGIN OPENSSH PRIVATE KEY") ||
    content.includes("BEGIN RSA PRIVATE KEY") ||
    content.includes("BEGIN EC PRIVATE KEY") ||
    content.includes("BEGIN DSA PRIVATE KEY") ||
    content.includes("BEGIN PRIVATE KEY")
  );
}

async function upsertSshSecret(
  namespace: string,
  name: string,
  keyPath: string,
  keyContent: string,
): Promise<"created" | "updated"> {
  const { core } = loadKube();

  const body: V1Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "percussionist",
        "percussionist.dev/component": "git-ssh",
      },
      annotations: {
        // Record where the key came from — helps ops trace secrets back to
        // their origin without exposing the key itself.
        "percussionist.dev/key-source": path.basename(keyPath),
      },
    },
    // kubernetes.io/ssh-auth is the canonical type for SSH credentials.
    // The operator's sshSecret wiring defaults to the `ssh-privatekey` key
    // used by this type, so consumers don't need to set `spec.source.git.sshSecret.key`.
    type: "kubernetes.io/ssh-auth",
    stringData: {
      "ssh-privatekey": keyContent,
    },
  };

  try {
    await core.readNamespacedSecret({ name, namespace });
    await core.replaceNamespacedSecret({ name, namespace, body });
    return "updated";
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 404) throw e;
    await core.createNamespacedSecret({ namespace, body });
    return "created";
  }
}

export async function runSshKeyCreate(opts: SshKeyCreateOpts): Promise<void> {
  const keyPath = resolveKeyPath(opts.key);
  const keyContent = readKeyFile(keyPath);

  if (!isLikelyPrivateKey(keyContent)) {
    // Warn but don't block — users might use a format we don't recognise.
    console.error(
      `beatctl: warning: ${keyPath} doesn't look like a PEM private key. ` +
        "Make sure you're passing the private key file, not the public key.",
    );
  }

  const secretName = opts.name;
  const ns = opts.namespace;

  console.error(`Key file:  ${keyPath}`);
  console.error(`Secret:    "${secretName}" (type: kubernetes.io/ssh-auth) in ns "${ns}"`);
  console.error(`Key field: ssh-privatekey`);

  if (opts.dryRun) {
    console.error("\n--dry-run: no changes made.");
    console.error(
      "\nWhen applied, reference it in Run specs with:\n" +
        "  spec:\n" +
        "    source:\n" +
        "      git:\n" +
        "        url: git@github.com:org/repo.git\n" +
        `        sshSecret:\n` +
        `          name: ${secretName}\n` +
        `\nOr with beatctl submit --git-url git@... --git-ssh-secret ${secretName}`,
    );
    return;
  }

  const action = await upsertSshSecret(ns, secretName, keyPath, keyContent).catch((e) =>
    fatal("upsert secret", e),
  );

  console.error(`\nSecret ${action}.`);
  console.error(
    "\nReference it in Run specs with:\n" +
      "  spec:\n" +
      "    source:\n" +
      "      git:\n" +
      "        url: git@github.com:org/repo.git\n" +
      `        sshSecret:\n` +
      `          name: ${secretName}\n` +
      `\nOr with beatctl submit --git-url git@... --git-ssh-secret ${secretName}`,
  );
}
