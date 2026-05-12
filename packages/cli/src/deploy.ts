// `beatctl deploy` — install/remove cluster-side percussionist resources.
//
// Unified deploy entrypoint for CRDs + operator + web.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_NAMESPACE, fatal } from "./kube.js";

export interface DeployOpts {
  namespace?: string;
  repoRoot?: string;
  down?: boolean;
  wait?: boolean;
}

function runKubectl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? 1) === 0) {
        resolve();
        return;
      }
      reject(new Error(`kubectl ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function resolveManifest(repoRoot: string, rel: string): string {
  const full = path.resolve(repoRoot, rel);
  if (!existsSync(full)) {
    throw new Error(`missing manifest: ${full}`);
  }
  return full;
}

function looksLikeRepoRoot(dir: string): boolean {
  return (
    existsSync(path.join(dir, "crds", "opencoderun.yaml")) &&
    existsSync(path.join(dir, "deploy", "operator.yaml"))
  );
}

function findRepoRoot(hint?: string): string {
  const candidates = [
    hint,
    process.env.PERCUSSIONIST_REPO_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter((v): v is string => Boolean(v));

  for (const c of candidates) {
    let dir = path.resolve(c);
    for (let i = 0; i < 6; i += 1) {
      if (looksLikeRepoRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    "could not locate repo root with crds/ and deploy/ (pass --repo-root)",
  );
}

export async function runDeploy(opts: DeployOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const repoRoot = findRepoRoot(opts.repoRoot);

  const manifests = {
    runCrd: resolveManifest(repoRoot, "crds/opencoderun.yaml"),
    projectCrd: resolveManifest(repoRoot, "crds/opencodeproject.yaml"),
    operator: resolveManifest(repoRoot, "deploy/operator.yaml"),
    web: resolveManifest(repoRoot, "deploy/web.yaml"),
  };

  if (opts.down) {
    try {
      console.log("beatctl: deleting web + operator deployments/RBAC...");
      await runKubectl(["delete", "-f", manifests.web, "--ignore-not-found", "--wait=false"]);
      await runKubectl(["delete", "-f", manifests.operator, "--ignore-not-found", "--wait=false"]);

      console.log("beatctl: deleting CRDs...");
      await runKubectl(["delete", "-f", manifests.projectCrd, "--ignore-not-found", "--wait=false"]);
      await runKubectl(["delete", "-f", manifests.runCrd, "--ignore-not-found", "--wait=false"]);
      console.log("beatctl: deploy --down complete");
      return;
    } catch (e) {
      fatal("deploy --down failed", e);
    }
  }

  try {
    console.log("beatctl: applying CRDs...");
    await runKubectl(["apply", "-f", manifests.runCrd]);
    await runKubectl(["apply", "-f", manifests.projectCrd]);

    console.log("beatctl: waiting for CRDs to establish...");
    await runKubectl([
      "wait",
      "--for=condition=Established",
      "crd/opencoderuns.percussionist.dev",
      "--timeout=30s",
    ]);
    await runKubectl([
      "wait",
      "--for=condition=Established",
      "crd/opencodeprojects.percussionist.dev",
      "--timeout=30s",
    ]);

    console.log("beatctl: applying operator and web manifests...");
    await runKubectl(["apply", "-f", manifests.operator]);
    await runKubectl(["apply", "-f", manifests.web]);

    if (opts.wait !== false) {
      console.log(`beatctl: waiting for rollouts in namespace ${ns}...`);
      await runKubectl([
        "-n",
        ns,
        "rollout",
        "status",
        "deploy/percussionist-operator",
        "--timeout=120s",
      ]);
      await runKubectl([
        "-n",
        ns,
        "rollout",
        "status",
        "deploy/percussionist-web",
        "--timeout=120s",
      ]);
    }

    console.log("beatctl: deploy complete");
  } catch (e) {
    fatal("deploy failed", e);
  }
}
