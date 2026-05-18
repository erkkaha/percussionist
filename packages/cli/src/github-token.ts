// `beatctl github-token create` — store a GitHub personal access token in a
// Kubernetes Secret for use with spec.source.git.githubTokenSecret.
//
// The resulting Secret is mounted read-only into the runner pod; the operator
// exports GITHUB_TOKEN from it so `gh` CLI is authenticated for the full
// duration of the run (create PRs, comment on issues, etc.).
//
// Usage:
//   beatctl github-token create                          # reads $GITHUB_TOKEN
//   beatctl github-token create --token ghp_xxxx
//   beatctl github-token create --name my-token -n my-ns
//
// The command is idempotent: if the Secret already exists it is replaced.

import type { V1Secret } from "@kubernetes/client-node";
import { DEFAULT_NAMESPACE, fatal, loadKube } from "./kube.js";

export interface GithubTokenCreateOpts {
  namespace: string;
  name: string;
  token?: string;
  dryRun?: boolean;
}

function resolveToken(override?: string): string {
  if (override && override.trim()) return override.trim();

  const fromEnv = process.env["GITHUB_TOKEN"];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  console.error(
    "beatctl: no GitHub token provided. " +
      "Pass it with --token <token> or set the GITHUB_TOKEN environment variable.",
  );
  process.exit(1);
}

function looksLikeToken(token: string): boolean {
  // GitHub tokens start with ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_
  return /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/.test(token);
}

async function upsertTokenSecret(
  namespace: string,
  name: string,
  token: string,
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
        "percussionist.dev/component": "git-github-token",
      },
    },
    type: "Opaque",
    stringData: {
      token,
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

export async function runGithubTokenCreate(
  opts: GithubTokenCreateOpts,
): Promise<void> {
  const token = resolveToken(opts.token);

  if (!looksLikeToken(token)) {
    console.error(
      "beatctl: warning: token doesn't look like a GitHub token " +
        "(expected prefix: ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_). " +
        "Proceeding anyway.",
    );
  }

  const secretName = opts.name;
  const ns = opts.namespace;

  console.error(`Secret:    "${secretName}" (type: Opaque) in ns "${ns}"`);
  console.error(`Key field: token`);

  if (opts.dryRun) {
    console.error("\n--dry-run: no changes made.");
    console.error(
      "\nWhen applied, reference it in Run specs with:\n" +
        "  spec:\n" +
        "    source:\n" +
        "      git:\n" +
        "        url: git@github.com:org/repo.git\n" +
        `        githubTokenSecret:\n` +
        `          name: ${secretName}\n` +
        `\nOr with beatctl submit --git-url git@... --git-github-token-secret ${secretName}`,
    );
    return;
  }

  const action = await upsertTokenSecret(ns, secretName, token).catch((e) =>
    fatal("upsert secret", e),
  );

  console.error(`\nSecret ${action}.`);
  console.error(
    "\nReference it in Run specs with:\n" +
      "  spec:\n" +
      "    source:\n" +
      "      git:\n" +
      "        url: git@github.com:org/repo.git\n" +
      `        githubTokenSecret:\n` +
      `          name: ${secretName}\n` +
      `\nOr with beatctl submit --git-url git@... --git-github-token-secret ${secretName}`,
  );
}
