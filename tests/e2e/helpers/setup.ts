/**
 * Shared cluster setup steps common to all three e2e test suites.
 */

import { resolve } from "node:path";
import {
  kubectl,
  kubectlApply,
  kubectlApplyFile,
  kubectlSetEnv,
  kubectlRolloutStatus,
  ensureNamespace,
  deleteNamespace,
  kubectlSilent,
  createLLMSecret,
} from "./kubectl.ts";

// Repo root resolved relative to this file: tests/e2e/helpers/ → ../../..
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const MANIFESTS = resolve(REPO_ROOT, "k8s/tests");
export const OPERATOR_NS = "percussionist";

/** Known-safe kubectl contexts (local/homelab clusters). */
const SAFE_CONTEXTS = ["k3s", "kind", "docker-desktop", "homelab", "minikube", "rancher"];

export interface ClusterConfig {
  ns: string;
  llmSecret: string;
}

/**
 * Preflight: verify kubectl is available and warn if context looks like prod.
 * In CI (non-interactive) we skip the 5-second pause.
 */
export async function preflight(): Promise<void> {
  const ctx =
    (await kubectlSilent(["config", "current-context"])) ?? "none";
  console.log(`    kubectl context: ${ctx}`);
  const isSafe = SAFE_CONTEXTS.some((c) => ctx.includes(c));
  if (!isSafe) {
    console.warn(
      `WARNING: context does not look like a local/homelab cluster (${ctx}).`,
    );
    if (process.stdout.isTTY) {
      console.warn("Resources will be created there. Ctrl-C within 5s to abort.");
      await Bun.sleep(5000);
    }
  }

  if (
    !process.env["ANTHROPIC_API_KEY"] &&
    !process.env["OPENAI_API_KEY"] &&
    !process.env["GITHUB_TOKEN"]
  ) {
    console.warn(
      "WARNING: no ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN found.",
    );
    console.warn("LLM calls will fail; some tests may still pass.");
  }
}

/** Step 1: Apply CRDs. */
export async function applyCRDs(): Promise<void> {
  console.log("==> Step 1: Apply CRDs");
  await kubectlApplyFile(resolve(REPO_ROOT, "k8s/crds/"), /* serverSide */ true);
  console.log("    CRDs applied");
}

/** Step 2: Deploy operator + manager-controller manifests. */
export async function deployComponents(): Promise<void> {
  console.log("==> Step 2: Deploy operator and manager");
  await kubectlApplyFile(resolve(REPO_ROOT, "k8s/deploy/operator.yaml"));
  await kubectlApplyFile(resolve(REPO_ROOT, "k8s/deploy/manager-controller.yaml"));
  console.log("    Deployments applied");
}

/**
 * Step 3: Patch PERCUSSIONIST_NAMESPACE on both deployments to the e2e
 * namespace and wait for rollout so they are watching the right namespace
 * before resources are created.
 */
export async function patchWatchNamespace(ns: string): Promise<void> {
  console.log(`==> Step 3: Patch PERCUSSIONIST_NAMESPACE=${ns} on operator and manager`);
  await kubectlSetEnv("percussionist-operator", OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: ns,
  });
  await kubectlSetEnv("percussionist-manager", OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: ns,
  });
  await kubectlRolloutStatus("percussionist-operator", OPERATOR_NS, 120);
  await kubectlRolloutStatus("percussionist-manager", OPERATOR_NS, 120);
  console.log(`    Operator and manager watching ${ns}`);
}

/** Step 4: Create the e2e namespace if it doesn't exist. */
export async function setupNamespace(ns: string): Promise<void> {
  console.log(`==> Step 4: Create namespace ${ns}`);
  await ensureNamespace(ns);
  console.log(`    Namespace ${ns} ready`);
}

/** Step 5: Apply dispatcher ServiceAccount + Role + RoleBinding in the e2e namespace. */
export async function setupDispatcherRBAC(ns: string): Promise<void> {
  console.log(`==> Step 5: Create dispatcher ServiceAccount + RBAC in ${ns}`);
  await kubectlApply(`\
apiVersion: v1
kind: ServiceAccount
metadata:
  name: percussionist-dispatcher
  namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: percussionist-dispatcher
  namespace: ${ns}
rules:
  - apiGroups: ["percussionist.dev"]
    resources: ["opencoderuns"]
    verbs: ["get", "list"]
  - apiGroups: ["percussionist.dev"]
    resources: ["opencoderuns/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: percussionist-dispatcher
  namespace: ${ns}
subjects:
  - kind: ServiceAccount
    name: percussionist-dispatcher
    namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: percussionist-dispatcher
`);
  console.log(`    Dispatcher ServiceAccount + RBAC ready in ${ns}`);
}

/** Step 6: Create (or update) the LLM keys secret. */
export async function setupLLMSecret(ns: string, llmSecret: string): Promise<void> {
  console.log(`==> Step 6: Create LLM secret ${llmSecret} in ${ns}`);
  await createLLMSecret(ns, llmSecret);
  console.log(`    Secret ${llmSecret} ready`);
}

/**
 * Run all shared setup steps (1–6).
 * Intended to be called from `beforeAll` in each test file.
 */
export async function setupCluster(config: ClusterConfig): Promise<void> {
  await preflight();
  await applyCRDs();
  await deployComponents();
  await patchWatchNamespace(config.ns);
  await setupNamespace(config.ns);
  await setupDispatcherRBAC(config.ns);
  await setupLLMSecret(config.ns, config.llmSecret);
}

/**
 * Apply one or more ClusterAgent manifests from `k8s/tests/`.
 */
export async function applyClusterAgents(fileNames: string[]): Promise<void> {
  console.log(`==> Apply ClusterAgents: ${fileNames.join(", ")}`);
  for (const f of fileNames) {
    await kubectlApplyFile(resolve(MANIFESTS, f));
  }
  console.log("    ClusterAgents applied");
}

/**
 * Apply an OpenCodeProject manifest inline.
 * `model` is omitted from the YAML if not provided.
 */
export async function applyProject(opts: {
  name: string;
  ns: string;
  displayName: string;
  llmSecret: string;
  model?: string;
  boardYaml: string; // the `board:` block (indented with 2 spaces)
  sourceYaml?: string; // optional `source:` block
}): Promise<void> {
  const modelLine = opts.model ? `  model: "${opts.model}"\n` : "";
  const sourceLine = opts.sourceYaml ? `${opts.sourceYaml}\n` : "";
  await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeProject
metadata:
  name: ${opts.name}
  namespace: ${opts.ns}
spec:
  displayName: "${opts.displayName}"
${modelLine}\
  secrets:
    llmKeysSecret: "${opts.llmSecret}"
${sourceLine}\
${opts.boardYaml}
`);
  console.log(`    Project ${opts.name} applied`);
}

/**
 * Teardown: delete the e2e namespace and restore PERCUSSIONIST_NAMESPACE to
 * the default operator namespace on both deployments.
 */
export async function teardown(ns: string): Promise<void> {
  console.log(`==> Teardown: deleting namespace ${ns}`);
  await deleteNamespace(ns);
  console.log(`    Restoring PERCUSSIONIST_NAMESPACE to ${OPERATOR_NS}`);
  await kubectlSetEnv("percussionist-operator", OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: OPERATOR_NS,
  }).catch(() => undefined);
  await kubectlSetEnv("percussionist-manager", OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: OPERATOR_NS,
  }).catch(() => undefined);
  console.log("    Teardown complete");
}
