/**
 * Shared cluster setup steps common to all three e2e test suites.
 */

import { resolve } from 'node:path';
import {
  createLLMSecret,
  deleteNamespace,
  ensureNamespace,
  kubectl,
  kubectlApply,
  kubectlApplyFile,
  kubectlRolloutStatus,
  kubectlSetEnv,
  kubectlSilent,
} from './kubectl.ts';

// Repo root resolved relative to this file: tests/e2e/helpers/ → ../../..
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const MANIFESTS = resolve(REPO_ROOT, 'k8s/tests');
export const OPERATOR_NS = 'percussionist';

/** Known-safe kubectl contexts (local/homelab clusters). */
const SAFE_CONTEXTS = ['k3s', 'kind', 'docker-desktop', 'homelab', 'minikube', 'rancher'];

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

export interface ClusterConfig {
  ns: string;
  llmSecret: string;
}

/** Options controlling setup/teardown behavior. */
export interface SetupOptions {
  /** Timeout in seconds for rollout status waits (default: 120). */
  rolloutTimeoutSec?: number;
  /** Whether to delete the namespace on teardown (default: true). Set false for debugging. */
  cleanupNamespace?: boolean;
  /** Whether to restore PERCUSSIONIST_NAMESPACE after teardown (default: true). */
  restoreWatchNamespace?: boolean;
}

const DEFAULT_OPTIONS: SetupOptions = {
  rolloutTimeoutSec: 120,
  cleanupNamespace: true,
  restoreWatchNamespace: true,
};

// ---------------------------------------------------------------------------
// Unique namespace generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique namespace suffix for test isolation.
 * Format: `<prefix>-<timestamp>-<random>` to avoid collisions across
 * parallel runs and repeated executions.
 */
export function generateUniqueName(prefix: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Generate a unique namespace name. Defaults to `percussionist-e2e-<unique>`.
 */
export function generateUniqueNamespace(prefix?: string): string {
  const base = prefix ?? 'percussionist-e2e';
  return generateUniqueName(base);
}

// ---------------------------------------------------------------------------
// Environment restoration helpers
// ---------------------------------------------------------------------------

/**
 * Restore PERCUSSIONIST_NAMESPACE on both operator and manager deployments.
 * Called during teardown to ensure the cluster is left in a clean state.
 */
export async function restoreWatchNamespace(originalNs: string = OPERATOR_NS): Promise<void> {
  await kubectlSetEnv('percussionist-operator', OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: originalNs,
  }).catch(() => undefined);
  await kubectlSetEnv('percussionist-manager', OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: originalNs,
  }).catch(() => undefined);
}

/**
 * Assert-safe teardown wrapper. Ensures namespace cleanup and env restoration
 * even when assertion errors occur in test cases.
 */
export async function safeTeardown(
  ns: string,
  options: SetupOptions = DEFAULT_OPTIONS,
): Promise<void> {
  try {
    if (options.cleanupNamespace) {
      await deleteNamespace(ns);
    }
  } finally {
    if (options.restoreWatchNamespace) {
      await restoreWatchNamespace();
    }
  }
}

/**
 * Register a global error handler that runs teardown on unhandled assertion errors.
 * Call this once at the top of your test file's `beforeAll` to ensure cleanup
 * even when assertions fail inside `it()` blocks.
 *
 * Returns an unsubscribe function — call it in `afterAll`.
 */
export function registerErrorTeardown(ns: string, options?: SetupOptions): () => void {
  const handler = (_event: ErrorEvent | PromiseRejectionEvent) => {
    // Best-effort teardown on unhandled errors.
    safeTeardown(ns, options).catch(() => undefined);
  };

  process.on('uncaughtException', handler as (...args: unknown[]) => void);
  process.on('unhandledRejection', handler as (...args: unknown[]) => void);

  return () => {
    process.off('uncaughtException', handler as (...args: unknown[]) => void);
    process.off('unhandledRejection', handler as (...args: unknown[]) => void);
  };
}

/**
 * Preflight: verify kubectl is available and warn if context looks like prod.
 * In CI (non-interactive) we skip the 5-second pause.
 */
export async function preflight(): Promise<void> {
  const ctx = (await kubectlSilent(['config', 'current-context'])) ?? 'none';
  console.log(`    kubectl context: ${ctx}`);
  const isSafe = SAFE_CONTEXTS.some((c) => ctx.includes(c));
  if (!isSafe) {
    console.warn(`WARNING: context does not look like a local/homelab cluster (${ctx}).`);
    if (process.stdout.isTTY) {
      console.warn('Resources will be created there. Ctrl-C within 5s to abort.');
      await Bun.sleep(5000);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GITHUB_TOKEN) {
    console.warn('WARNING: no ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN found.');
    console.warn('LLM calls will fail; some tests may still pass.');
  }
}

/** Step 1: Apply CRDs. */
export async function applyCRDs(): Promise<void> {
  console.log('==> Step 1: Apply CRDs');
  await kubectlApplyFile(resolve(REPO_ROOT, 'k8s/crds/'), /* serverSide */ true);
  console.log('    CRDs applied');
}

/** Step 2: Deploy operator + manager-controller manifests.
 *
 * Supports local image overrides via env vars so that locally-built images
 * can be tested in kind without pushing to a registry:
 *
 *   E2E_OPERATOR_IMAGE=ghcr.io/erkkaha/percussionist/operator:e2e-local
 *   E2E_MANAGER_IMAGE=ghcr.io/erkkaha/percussionist/manager:e2e-local
 *
 * When set, `kubectl set image` patches the deployments immediately after
 * applying the standard manifests.
 */
export async function deployComponents(): Promise<void> {
  console.log('==> Step 2: Deploy operator and manager');
  await kubectlApplyFile(resolve(REPO_ROOT, 'k8s/deploy/operator.yaml'));
  await kubectlApplyFile(resolve(REPO_ROOT, 'k8s/deploy/manager-controller.yaml'));

  const operatorImage = process.env.E2E_OPERATOR_IMAGE;
  const managerImage = process.env.E2E_MANAGER_IMAGE;
  if (operatorImage) {
    await kubectl([
      '-n',
      OPERATOR_NS,
      'set',
      'image',
      'deployment/percussionist-operator',
      `operator=${operatorImage}`,
    ]);
    console.log(`    Operator image overridden → ${operatorImage}`);
  }
  if (managerImage) {
    await kubectl([
      '-n',
      OPERATOR_NS,
      'set',
      'image',
      'deployment/percussionist-manager',
      `manager=${managerImage}`,
    ]);
    console.log(`    Manager image overridden → ${managerImage}`);
  }

  console.log('    Deployments applied');
}

/**
 * Step 3: Patch PERCUSSIONIST_NAMESPACE on both deployments to the e2e
 * namespace and wait for rollout so they are watching the right namespace
 * before resources are created.
 */
export async function patchWatchNamespace(
  ns: string,
  options: SetupOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const timeoutSec = options.rolloutTimeoutSec ?? DEFAULT_OPTIONS.rolloutTimeoutSec;
  console.log(`==> Step 3: Patch PERCUSSIONIST_NAMESPACE=${ns} on operator and manager`);
  await kubectlSetEnv('percussionist-operator', OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: ns,
  });
  await kubectlSetEnv('percussionist-manager', OPERATOR_NS, {
    PERCUSSIONIST_NAMESPACE: ns,
  });
  await kubectlRolloutStatus('percussionist-operator', OPERATOR_NS, timeoutSec);
  await kubectlRolloutStatus('percussionist-manager', OPERATOR_NS, timeoutSec);
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
    resources: ["runs"]
    verbs: ["get", "list", "patch"]
  - apiGroups: ["percussionist.dev"]
    resources: ["runs/status"]
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
export async function setupCluster(
  config: ClusterConfig,
  options: SetupOptions = DEFAULT_OPTIONS,
): Promise<void> {
  await preflight();
  await applyCRDs();
  await deployComponents();
  await patchWatchNamespace(config.ns, options);
  await setupNamespace(config.ns);
  await setupDispatcherRBAC(config.ns);
  await setupLLMSecret(config.ns, config.llmSecret);
}

/**
 * Convenience: generate a unique namespace and run full cluster setup.
 * Returns the generated namespace name for use in teardown.
 */
export async function setupClusterUnique(
  opts: { llmSecret?: string; prefix?: string } & Partial<SetupOptions> = {},
): Promise<string> {
  const ns = generateUniqueNamespace(opts.prefix);
  await setupCluster({ ns, llmSecret: opts.llmSecret ?? 'llm-keys' }, opts as SetupOptions);
  return ns;
}

/**
 * Apply one or more ClusterAgent manifests from `k8s/tests/`.
 */
export async function applyClusterAgents(fileNames: string[]): Promise<void> {
  console.log(`==> Apply ClusterAgents: ${fileNames.join(', ')}`);
  for (const f of fileNames) {
    await kubectlApplyFile(resolve(MANIFESTS, f));
  }
  console.log('    ClusterAgents applied');
}

/**
 * Apply a Project manifest inline using top-level spec fields (new CRD format).
 * `model` is omitted from the YAML if not provided.
 */
export async function applyProject(opts: {
  name: string;
  ns: string;
  displayName: string;
  llmSecret: string;
  model?: string;
  phase?: string; // defaults to "Active"
  maxParallel?: number; // defaults to 1
  agents?: Array<{ name: string; model?: string }>; // list of agent refs
  timeoutSeconds?: number; // run timeout override
  sourceYaml?: string; // optional `source:` block (indented 2 spaces)
  flowYaml?: string; // optional `flow:` block (indented 2 spaces)
}): Promise<void> {
  const modelLine = opts.model ? `  model: "${opts.model}"\n` : '';
  const sourceLine = opts.sourceYaml ? `${opts.sourceYaml}\n` : '';
  const flowLine = opts.flowYaml ? `${opts.flowYaml}\n` : '';
  const phase = opts.phase ?? 'Active';
  const maxParallel = opts.maxParallel ?? 1;
  const agentsBlock =
    opts.agents && opts.agents.length > 0
      ? `  agents:\n${opts.agents.map((a) => (a.model ? `    - name: ${a.name}\n      model: "${a.model}"` : `    - name: ${a.name}`)).join('\n')}\n`
      : '';
  const timeoutLine = opts.timeoutSeconds ? `  timeoutSeconds: ${opts.timeoutSeconds}\n` : '';
  await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: ${opts.name}
  namespace: ${opts.ns}
spec:
  displayName: "${opts.displayName}"
${modelLine}\
  phase: ${phase}
  maxParallel: ${maxParallel}
${agentsBlock}\
${timeoutLine}\
  secrets:
    llmKeysSecret: "${opts.llmSecret}"
${sourceLine}\
${flowLine}\
`);
  console.log(`    Project ${opts.name} applied`);
}

/**
 * Apply a Task CR inline.
 * The task metadata.name is used as the canonical task identifier.
 */
export async function applyTask(opts: {
  name: string; // metadata.name — the canonical task ID
  ns: string;
  projectRef: string;
  type?: 'BUILD' | 'PLAN'; // defaults to "BUILD"
  title: string;
  agent: string;
  description?: string;
  priority?: 'high' | 'medium' | 'low';
}): Promise<void> {
  const type = opts.type ?? 'BUILD';
  const descLine = opts.description
    ? `  description: |\n    ${opts.description.replace(/\n/g, '\n    ')}\n`
    : '';
  const priorityLine = opts.priority ? `  priority: ${opts.priority}\n` : '';
  await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: Task
metadata:
  name: ${opts.name}
  namespace: ${opts.ns}
  labels:
    percussionist.dev/project: ${opts.projectRef}
spec:
  projectRef: ${opts.projectRef}
  type: ${type}
  title: "${opts.title}"
  agent: ${opts.agent}
${descLine}\
${priorityLine}\
`);
  console.log(`    Task ${opts.name} applied`);
}

/**
 * Deploy a minimal web pod into the e2e namespace so tests can exercise the
 * web diff/route endpoints against resources in that namespace.
 *
 * Uses an emptyDir for the SQLite database instead of the production PVC, and
 * disables auth so tests can call endpoints without a token.
 */
export async function applyWebDeployment(ns: string): Promise<void> {
  const image = process.env['E2E_WEB_IMAGE'] ?? 'ghcr.io/erkkaha/percussionist/web:latest';
  console.log(`==> Deploy web watcher into ${ns} (${image})`);
  await kubectlApply(`\
apiVersion: v1
kind: ServiceAccount
metadata:
  name: percussionist-web
  namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: percussionist-web
  namespace: ${ns}
rules:
  - apiGroups: ["percussionist.dev"]
    resources: ["runs"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: ["percussionist.dev"]
    resources: ["projects"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["percussionist.dev"]
    resources: ["projects/status"]
    verbs: ["get", "patch"]
  - apiGroups: ["percussionist.dev"]
    resources: ["tasks"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["percussionist.dev"]
    resources: ["tasks/status"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: percussionist-web
  namespace: ${ns}
subjects:
  - kind: ServiceAccount
    name: percussionist-web
    namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: percussionist-web
---
apiVersion: v1
kind: Service
metadata:
  name: percussionist-web
  namespace: ${ns}
spec:
  selector:
    app.kubernetes.io/name: percussionist
    app.kubernetes.io/component: web
  ports:
    - port: 8080
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: percussionist-web
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: percussionist
    app.kubernetes.io/component: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: percussionist
      app.kubernetes.io/component: web
  template:
    metadata:
      labels:
        app.kubernetes.io/name: percussionist
        app.kubernetes.io/component: web
    spec:
      serviceAccountName: percussionist-web
      containers:
        - name: web
          image: ${image}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          env:
            - name: PERCUSSIONIST_NAMESPACE
              value: "${ns}"
            - name: PORT
              value: "8080"
            - name: DATA_DIR
              value: /app/data
            - name: RETENTION_DAYS
              value: "30"
            - name: AUTH_DISABLED
              value: "1"
            - name: NODE_EXTRA_CA_CERTS
              value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          readinessProbe:
            httpGet:
              path: /api/health
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /api/health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          volumeMounts:
            - name: web-db
              mountPath: /app/data
      volumes:
        - name: web-db
          emptyDir: {}
`);
  console.log(`    Web watcher deployed into ${ns}`);
}

/**
 * Teardown: delete the e2e namespace and restore PERCUSSIONIST_NAMESPACE to
 * the default operator namespace on both deployments.
 */
export async function teardown(ns: string, options: SetupOptions = DEFAULT_OPTIONS): Promise<void> {
  console.log(`==> Teardown: deleting namespace ${ns}`);
  try {
    if (options.cleanupNamespace) {
      await deleteNamespace(ns);
    }
  } finally {
    if (options.restoreWatchNamespace) {
      const _timeoutSec = options.rolloutTimeoutSec ?? DEFAULT_OPTIONS.rolloutTimeoutSec;
      console.log(`    Restoring PERCUSSIONIST_NAMESPACE to ${OPERATOR_NS}`);
      await kubectlSetEnv('percussionist-operator', OPERATOR_NS, {
        PERCUSSIONIST_NAMESPACE: OPERATOR_NS,
      }).catch(() => undefined);
      await kubectlSetEnv('percussionist-manager', OPERATOR_NS, {
        PERCUSSIONIST_NAMESPACE: OPERATOR_NS,
      }).catch(() => undefined);
    }
  }
  console.log('    Teardown complete');
}
