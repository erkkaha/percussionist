// Operator entrypoint.
//
// Watches OpenCodeRun resources across a single namespace (METRICS: we'll
// extend to cluster-wide later) and reconciles each into:
//   - a Secret holding the basic-auth password for opencode serve (if the
//     user didn't supply one via spec.secrets.serverPasswordSecret)
//   - a Service exposing port 4096
//   - a Pod with two containers:
//       * `opencode`   running `opencode serve --hostname 0.0.0.0`
//       * `dispatcher` driving the session and writing /status
//
// Uses informer-driven reconciliation with a simple work queue. Not
// production hardened (no leader election, no retry budget, no metrics),
// but sufficient for M2 validation.

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  makeInformer,
  PatchStrategy,
  setHeaderOptions,
  type V1Pod,
  type V1Service,
  type V1Secret,
} from "@kubernetes/client-node";
import { randomBytes } from "node:crypto";
import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  KIND_RUN,
  PLURAL_RUN,
  LABELS,
  MANAGED_BY,
  CONTAINER_PORT,
  RUNNER_CONTAINER,
  DISPATCHER_CONTAINER,
  OpenCodeRunSpecSchema,
  RunPhase,
  TERMINAL_PHASES,
  type OpenCodeRun,
  type OpenCodeRunStatus,
} from "@percussionist/api";

const NAMESPACE = process.env.WATCH_NAMESPACE ?? "percussionist";
const RUNNER_IMAGE_DEFAULT =
  process.env.RUNNER_IMAGE_DEFAULT ?? "percussionist/runner:dev";
const DISPATCHER_IMAGE =
  process.env.DISPATCHER_IMAGE ?? "percussionist/dispatcher:dev";
const DISPATCHER_SERVICE_ACCOUNT =
  process.env.DISPATCHER_SERVICE_ACCOUNT ?? "percussionist-dispatcher";

const log = (...args: unknown[]) =>
  console.log(`[operator ${new Date().toISOString()}]`, ...args);
const err = (...args: unknown[]) =>
  console.error(`[operator ${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// K8s clients

const kc = new KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(CoreV1Api);
const co = kc.makeApiClient(CustomObjectsApi);

// ---------------------------------------------------------------------------
// Rendering helpers

const ownerRefsFor = (run: OpenCodeRun) => [
  {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    name: run.metadata.name,
    uid: run.metadata.uid!,
    controller: true,
    blockOwnerDeletion: true,
  },
];

const commonLabels = (run: OpenCodeRun) => ({
  [LABELS.managedBy]: MANAGED_BY,
  [LABELS.runName]: run.metadata.name,
});

const passwordSecretName = (run: OpenCodeRun) =>
  `${run.metadata.name}-auth`;
const serviceName = (run: OpenCodeRun) => run.metadata.name;
const podName = (run: OpenCodeRun) => run.metadata.name;

function renderPasswordSecret(run: OpenCodeRun): V1Secret {
  const password = randomBytes(18).toString("base64url");
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: passwordSecretName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "auth" },
      ownerReferences: ownerRefsFor(run),
    },
    stringData: { password },
  };
}

function renderService(run: OpenCodeRun): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "runner" },
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      type: "ClusterIP",
      selector: { [LABELS.runName]: run.metadata.name },
      ports: [
        { name: "http", port: CONTAINER_PORT, targetPort: "http" as unknown as number },
      ],
    },
  };
}

function renderPod(run: OpenCodeRun, passwordSecret: string): V1Pod {
  const spec = OpenCodeRunSpecSchema.parse(run.spec);
  const llmKeysSecret = spec.secrets?.llmKeysSecret;
  const image = spec.image ?? RUNNER_IMAGE_DEFAULT;

  // --- workspace source wiring ---------------------------------------------
  // When spec.source.git is set we inject an init container that clones the
  // repo into the shared `workspace` emptyDir before the runner starts.
  // Auth: if sshSecret is present we mount it at /etc/git-ssh (read-only,
  // mode 0400 via defaultMode) and tell git to use it via GIT_SSH_COMMAND.
  //
  // We deliberately use the runner image for the init container so we
  // don't have to maintain a second base — it already has git + openssh.
  const git = spec.source?.git;
  const sshSecret = git?.sshSecret;

  const initContainers = git
    ? [
        {
          name: "git-clone",
          image,
          imagePullPolicy: "IfNotPresent" as const,
          // Inline script keeps the contract visible in the Pod spec
          // (easy to read via `kubectl get pod -o yaml`). Logic:
          //   1. Prepare GIT_SSH_COMMAND if a key is mounted.
          //   2. If ref is empty, clone default branch (--depth=1).
          //   3. If ref looks like a full SHA, do a full clone then checkout.
          //   4. Otherwise assume branch/tag and use --branch --depth=1.
          // `set -eo pipefail` so any failure bubbles up as init-container
          // failed; kubelet will mark the Pod Failed and the operator's
          // pod-phase mirror propagates that to the CR.
          command: ["/bin/sh", "-c"],
          args: [
            [
              "set -eo pipefail",
              'echo "[git-clone] cloning ${GIT_URL} ref=${GIT_REF:-<default>} into /workspace"',
              // SSH setup. The mounted key has mode 0400 from defaultMode,
              // but git/ssh still insists on an absolute path and no
              // known_hosts surprises. StrictHostKeyChecking=no is fine for
              // the homelab; tighten once we ship known_hosts support.
              'if [ -f /etc/git-ssh/id ]; then',
              '  export GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes"',
              '  echo "[git-clone] using ssh key from secret"',
              'fi',
              'cd /workspace',
              'if [ -z "${GIT_REF}" ]; then',
              '  git clone --depth=1 "${GIT_URL}" .',
              'elif echo "${GIT_REF}" | grep -Eq "^[0-9a-f]{7,40}$"; then',
              '  git clone "${GIT_URL}" .',
              '  git checkout --detach "${GIT_REF}"',
              'else',
              '  git clone --depth=1 --branch "${GIT_REF}" "${GIT_URL}" .',
              'fi',
              'echo "[git-clone] HEAD=$(git rev-parse HEAD)"',
            ].join("\n"),
          ],
          env: [
            { name: "GIT_URL", value: git.url },
            ...(git.ref ? [{ name: "GIT_REF", value: git.ref }] : []),
            // Disable interactive prompts — no TTY here.
            { name: "GIT_TERMINAL_PROMPT", value: "0" },
          ],
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            ...(sshSecret
              ? [
                  {
                    name: "git-ssh",
                    mountPath: "/etc/git-ssh",
                    readOnly: true,
                  },
                ]
              : []),
          ],
          resources: {
            requests: { cpu: "50m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
        },
      ]
    : undefined;

  const volumes = [
    { name: "workspace", emptyDir: {} },
    ...(sshSecret
      ? [
          {
            name: "git-ssh",
            secret: {
              secretName: sshSecret.name,
              // Rename the user-supplied key to a stable path (`id`) so
              // GIT_SSH_COMMAND above doesn't need to know the original key.
              items: [{ key: sshSecret.key, path: "id" }],
              // 0400 — ssh refuses keys with looser perms.
              defaultMode: 0o400,
            },
          },
        ]
      : []),
  ];

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName(run),
      namespace: run.metadata.namespace!,
      labels: {
        ...commonLabels(run),
        [LABELS.component]: "runner",
        // The service selector requires this label on the pod too.
      },
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: DISPATCHER_SERVICE_ACCOUNT,
      activeDeadlineSeconds: spec.timeoutSeconds,
      ...(initContainers ? { initContainers } : {}),
      containers: [
        {
          name: RUNNER_CONTAINER,
          image,
          imagePullPolicy: "IfNotPresent",
          // When a source is configured the agent should start *inside*
          // the cloned tree so `ls`, reads, git, etc. just work. Without
          // a source /workspace is an empty dir — still a fine CWD.
          workingDir: "/workspace",
          command: [
            "opencode",
            "serve",
            "--hostname",
            "0.0.0.0",
            "--port",
            String(CONTAINER_PORT),
          ],
          ports: [{ name: "http", containerPort: CONTAINER_PORT }],
          env: [
            {
              name: "OPENCODE_SERVER_PASSWORD",
              valueFrom: {
                secretKeyRef: { name: passwordSecret, key: "password" },
              },
            },
            // OPENCODE_AUTH_CONTENT: opencode checks this env var before
            // reading ~/.local/share/opencode/auth.json, so projecting the
            // full JSON blob from a Secret gives us a zero-file headless
            // credential path. Carries OAuth/device-flow tokens (GitHub
            // Copilot, ChatGPT Plus, Claude Pro) that can't be expressed
            // as simple provider-keyed env vars.
            ...(spec.secrets?.opencodeAuthSecret
              ? [
                  {
                    name: "OPENCODE_AUTH_CONTENT",
                    valueFrom: {
                      secretKeyRef: {
                        name: spec.secrets.opencodeAuthSecret.name,
                        key: spec.secrets.opencodeAuthSecret.key,
                      },
                    },
                  },
                ]
              : []),
            ...(llmKeysSecret
              ? [
                  {
                    name: "_LLM_KEYS_MARKER",
                    value: "see envFrom",
                  },
                ]
              : []),
          ],
          envFrom: llmKeysSecret
            ? [{ secretRef: { name: llmKeysSecret, optional: true } }]
            : [],
          readinessProbe: {
            tcpSocket: { port: "http" as unknown as number },
            initialDelaySeconds: 2,
            periodSeconds: 3,
            failureThreshold: 30,
          },
          resources: spec.resources ?? {
            requests: { cpu: "200m", memory: "512Mi" },
            limits: { cpu: "2", memory: "2Gi" },
          },
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
        },
        {
          name: DISPATCHER_CONTAINER,
          image: DISPATCHER_IMAGE,
          imagePullPolicy: "IfNotPresent",
          env: [
            { name: "RUN_NAME", value: run.metadata.name },
            { name: "RUN_NAMESPACE", value: run.metadata.namespace! },
            { name: "OPENCODE_BASE_URL", value: `http://127.0.0.1:${CONTAINER_PORT}` },
            {
              name: "OPENCODE_SERVER_PASSWORD",
              valueFrom: {
                secretKeyRef: { name: passwordSecret, key: "password" },
              },
            },
            // RUN_TASK is only set in non-interactive mode; the dispatcher
            // treats missing task + RUN_INTERACTIVE=1 as "wait for attach".
            ...(spec.task && !spec.interactive
              ? [{ name: "RUN_TASK", value: spec.task }]
              : []),
            ...(spec.interactive
              ? [{ name: "RUN_INTERACTIVE", value: "1" }]
              : []),
            ...(spec.model ? [{ name: "RUN_MODEL", value: spec.model }] : []),
            ...(spec.agent ? [{ name: "RUN_AGENT", value: spec.agent }] : []),
          ],
          resources: {
            requests: { cpu: "50m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
        },
      ],
      volumes,
    },
  };
}

// ---------------------------------------------------------------------------
// Status writer

async function patchStatus(
  run: OpenCodeRun,
  patch: OpenCodeRunStatus,
): Promise<void> {
  const body = { status: patch };
  try {
    await co.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace: run.metadata.namespace!,
        plural: PLURAL_RUN,
        name: run.metadata.name,
        body,
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  } catch (e) {
    err(`patchStatus(${run.metadata.name}):`, (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Reconcile

async function reconcile(run: OpenCodeRun): Promise<void> {
  const name = run.metadata.name;
  const ns = run.metadata.namespace!;
  const currentPhase = run.status?.phase;

  // Skip terminal phases — no further work to do.
  if (currentPhase && TERMINAL_PHASES.has(currentPhase)) {
    return;
  }

  // Ensure auth secret exists (generate if caller didn't provide one).
  const userSecret = run.spec.secrets?.serverPasswordSecret;
  const secretName = userSecret ?? passwordSecretName(run);
  if (!userSecret) {
    try {
      await core.readNamespacedSecret({ name: secretName, namespace: ns });
    } catch {
      const secret = renderPasswordSecret(run);
      try {
        await core.createNamespacedSecret({ namespace: ns, body: secret });
        log(`created secret ${ns}/${secretName}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/already exists/i.test(msg)) throw e;
      }
    }
  }

  // Ensure service exists.
  try {
    await core.readNamespacedService({ name: serviceName(run), namespace: ns });
  } catch {
    try {
      await core.createNamespacedService({
        namespace: ns,
        body: renderService(run),
      });
      log(`created service ${ns}/${serviceName(run)}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/already exists/i.test(msg)) throw e;
    }
  }

  // Ensure pod exists.
  let pod: V1Pod | undefined;
  try {
    pod = await core.readNamespacedPod({ name: podName(run), namespace: ns });
  } catch {
    try {
      pod = await core.createNamespacedPod({
        namespace: ns,
        body: renderPod(run, secretName),
      });
      log(`created pod ${ns}/${podName(run)}`);
      await patchStatus(run, {
        phase: RunPhase.Initializing,
        podName: podName(run),
        serviceName: serviceName(run),
        message: "pod created",
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/already exists/i.test(msg)) {
        await patchStatus(run, {
          phase: RunPhase.Failed,
          message: `failed to create pod: ${msg}`,
        });
        throw e;
      }
      pod = await core.readNamespacedPod({ name: podName(run), namespace: ns });
    }
  }

  // Mirror pod phase into CR status when the dispatcher hasn't claimed it yet.
  // Dispatcher's Running/Succeeded writes take precedence over anything we
  // infer here because of the order: we only write when currentPhase is
  // Pending/Initializing.
  const podPhase = pod?.status?.phase;
  if (!currentPhase || currentPhase === RunPhase.Pending) {
    await patchStatus(run, {
      phase: RunPhase.Initializing,
      podName: podName(run),
      serviceName: serviceName(run),
      message: `pod phase: ${podPhase ?? "Unknown"}`,
    });
  }

  // Terminal reflection from pod:
  // - Pod Succeeded: dispatcher exited 0, session completed.
  // - Pod Failed:    either container died non-zero.
  if (podPhase === "Succeeded" && currentPhase !== RunPhase.Succeeded) {
    await patchStatus(run, {
      phase: RunPhase.Succeeded,
      completedAt: new Date().toISOString(),
      message: "pod succeeded",
    });
  } else if (podPhase === "Failed" && currentPhase !== RunPhase.Failed) {
    await patchStatus(run, {
      phase: RunPhase.Failed,
      completedAt: new Date().toISOString(),
      message: summarizePodFailure(pod),
    });
  }
}

function summarizePodFailure(pod?: V1Pod): string {
  if (!pod?.status?.containerStatuses) return "pod failed";
  const reasons = pod.status.containerStatuses
    .map((c) => {
      const t = c.state?.terminated;
      if (!t) return null;
      return `${c.name}: ${t.reason ?? "Error"} (exit ${t.exitCode ?? "?"})`;
    })
    .filter(Boolean);
  return reasons.length ? reasons.join("; ") : pod.status.reason ?? "pod failed";
}

// ---------------------------------------------------------------------------
// Work queue

const queue: string[] = [];
const pending = new Set<string>();
const seen = new Map<string, OpenCodeRun>();

function enqueue(run: OpenCodeRun): void {
  const key = `${run.metadata.namespace}/${run.metadata.name}`;
  seen.set(key, run);
  if (!pending.has(key)) {
    pending.add(key);
    queue.push(key);
  }
}

async function worker(): Promise<void> {
  while (true) {
    const key = queue.shift();
    if (!key) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    pending.delete(key);
    const run = seen.get(key);
    if (!run) continue;
    try {
      await reconcile(run);
    } catch (e) {
      err(`reconcile(${key}) failed:`, (e as Error).message);
      // Simple linear backoff: re-enqueue after 5s.
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    }
  }
}

// Periodic resync so we catch pod phase transitions even when no CR event
// fires (e.g. pod succeeded 10s after last CR update).
function periodicResync(): void {
  setInterval(() => {
    for (const run of seen.values()) enqueue(run);
  }, 10_000).unref();
}

// ---------------------------------------------------------------------------
// Informer

async function run(): Promise<void> {
  log(`watching ${API_GROUP_VERSION}/${PLURAL_RUN} in namespace=${NAMESPACE}`);

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_RUN}`;
  const listFn = async () => {
    // makeInformer wants a { response, body: { items } } shape OR a promise
    // resolving to { items }. v1.x returns the list object directly.
    const res = await co.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: PLURAL_RUN,
    });
    return res as unknown as { items: OpenCodeRun[] };
  };

  const informer = makeInformer(kc, path, listFn as never);
  informer.on("add", (obj) => enqueue(obj as unknown as OpenCodeRun));
  informer.on("update", (obj) => enqueue(obj as unknown as OpenCodeRun));
  informer.on("delete", (obj) => {
    const md = (obj as { metadata?: { namespace?: string; name?: string } }).metadata;
    const key = `${md?.namespace}/${md?.name}`;
    seen.delete(key);
  });
  informer.on("error", (e) => {
    err("informer error:", (e as Error).message);
    setTimeout(() => informer.start().catch((err) => console.error(err)), 2000);
  });
  await informer.start();

  periodicResync();
  await worker();
}

run().catch((e) => {
  err("fatal:", e);
  process.exit(1);
});
