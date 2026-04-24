// Operator entrypoint.
//
// Watches OpenCodeRun resources across a single namespace and reconciles each
// into:
//   - a Service exposing port 4096
//   - a Pod with two containers:
//       * `opencode`   running `opencode serve --hostname 0.0.0.0`
//       * `dispatcher` driving the session and writing /status
//   - (optional) a per-run Ingress when PERCUSSIONIST_INGRESS_BASE_URL is
//     set, exposing the opencode web UI at <baseURL-with-run-subdomain>/
//
// Uses informer-driven reconciliation with a simple work queue.

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  makeInformer,
  PatchStrategy,
  setHeaderOptions,
  type V1Pod,
  type V1Service,
  type V1Ingress,
} from "@kubernetes/client-node";
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

// When set, the dispatcher POSTs full session data here after each run for
// persistent analytics storage (bun:sqlite in the web pod).
// Default: auto-resolve to the web service in the same namespace.
const WEB_STATS_URL =
  process.env.WEB_STATS_URL ??
  `http://percussionist-web.${NAMESPACE}.svc.cluster.local:8080`;

// Ingress config — all optional. Feature is disabled when BASE_URL is unset.
//
// PERCUSSIONIST_INGRESS_BASE_URL — full URL prefix used to build per-run URLs.
//   Format: scheme://host[:port]  (no trailing slash)
//   Example (traefik.me + NodePort 30080):
//     http://192.168.49.2.traefik.me:30080
//   The per-run URL becomes:
//     http://<run>.192.168.49.2.traefik.me:30080/
//
// Legacy PERCUSSIONIST_INGRESS_BASE_DOMAIN is still accepted for plain http port-80
// setups — it is equivalent to setting BASE_URL=http://<domain>.
const _rawBaseURL = process.env.PERCUSSIONIST_INGRESS_BASE_URL ?? "";
const _legacyDomain = process.env.PERCUSSIONIST_INGRESS_BASE_DOMAIN ?? "";
const INGRESS_BASE_URL: string = _rawBaseURL
  ? _rawBaseURL.replace(/\/$/, "")
  : _legacyDomain
    ? `http://${_legacyDomain}`
    : "";

const INGRESS_CLASS = process.env.PERCUSSIONIST_INGRESS_CLASS ?? "";
// JSON object of extra annotations to merge onto each Ingress, e.g.:
//   '{"nginx.ingress.kubernetes.io/proxy-read-timeout":"3600"}'
const INGRESS_ANNOTATIONS_RAW = process.env.PERCUSSIONIST_INGRESS_ANNOTATIONS ?? "{}";
let INGRESS_ANNOTATIONS: Record<string, string> = {};
try {
  INGRESS_ANNOTATIONS = JSON.parse(INGRESS_ANNOTATIONS_RAW);
} catch {
  // ignore malformed value
}
// Default for spec.expose.web when unspecified — true when a base URL is set.
const EXPOSE_WEB_DEFAULT =
  process.env.PERCUSSIONIST_EXPOSE_WEB_DEFAULT !== "false";

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
const networking = kc.makeApiClient(NetworkingV1Api);

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

const serviceName = (run: OpenCodeRun) => run.metadata.name;
const podName = (run: OpenCodeRun) => run.metadata.name;
const ingressName = (run: OpenCodeRun) => run.metadata.name;

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
      // Always include the pod in endpoints even when the dispatcher sidecar
      // has exited (NotReady). The opencode container serves traffic on its own.
      publishNotReadyAddresses: true,
      selector: { [LABELS.runName]: run.metadata.name },
      ports: [
        { name: "http", port: CONTAINER_PORT, targetPort: "http" as unknown as number },
      ],
    },
  };
}

function renderIngress(run: OpenCodeRun): V1Ingress {
  const host = new URL(INGRESS_BASE_URL).hostname;
  const runHost = `${run.metadata.name}.${host}`;
  const annotations: Record<string, string> = {
    // SSE streams (opencode /event endpoint) need long read timeouts and
    // disabled buffering on nginx-ingress. Merge user-supplied annotations
    // on top so they can override.
    ...INGRESS_ANNOTATIONS,
  };
  const ingress: V1Ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: ingressName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "opencode-web" },
      annotations,
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      rules: [
        {
          host: runHost,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: serviceName(run),
                    port: { number: CONTAINER_PORT },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
  if (INGRESS_CLASS) {
    ingress.spec!.ingressClassName = INGRESS_CLASS;
  }
  return ingress;
}

function renderPod(run: OpenCodeRun): V1Pod {
  const spec = OpenCodeRunSpecSchema.parse(run.spec);
  const llmKeysSecret = spec.secrets?.llmKeysSecret;
  const image = spec.image ?? RUNNER_IMAGE_DEFAULT;

  const git = spec.source?.git;
  const sshSecret = git?.sshSecret;
  const gitAuthorEnv = git?.author
    ? [
        { name: "GIT_AUTHOR_NAME", value: git.author.name },
        { name: "GIT_AUTHOR_EMAIL", value: git.author.email },
        { name: "GIT_COMMITTER_NAME", value: git.author.name },
        { name: "GIT_COMMITTER_EMAIL", value: git.author.email },
      ]
    : [];

  const initContainers = git
    ? [
        {
          name: "git-clone",
          image,
          imagePullPolicy: "IfNotPresent" as const,
          command: ["/bin/sh", "-c"],
          args: [
            [
              "set -eo pipefail",
              'echo "[git-clone] cloning ${GIT_URL} ref=${GIT_REF:-<default>} into /workspace"',
              // Always disable host-key checking so SSH URLs work without a
              // pre-populated known_hosts. When an explicit key file is
              // mounted we also force IdentitiesOnly so the agent is bypassed
              // and only the provided key is used. Without a key file we omit
              // IdentitiesOnly so the SSH agent (if present) can still be
              // consulted — useful for interactive debugging.
              'if [ -f /etc/git-ssh/id ]; then',
              '  export GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes"',
              '  echo "[git-clone] using ssh key from secret"',
              'else',
              '  export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"',
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
            { name: "GIT_TERMINAL_PROMPT", value: "0" },
            ...gitAuthorEnv,
          ],
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            ...(sshSecret
              ? [{ name: "git-ssh", mountPath: "/etc/git-ssh", readOnly: true }]
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
              items: [{ key: sshSecret.key, path: "id" }],
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
          workingDir: "/workspace",
          command: [
            "opencode",
            "web",
            "--hostname",
            "0.0.0.0",
            "--port",
            String(CONTAINER_PORT),
          ],
          ports: [{ name: "http", containerPort: CONTAINER_PORT }],
          env: [
            // Give Node.js (tsc, eslint, etc.) up to 1.5 GB of heap.
            // The runner container limit is 2 Gi; leaving ~512 Mi for the
            // OS and the opencode process itself.
            { name: "NODE_OPTIONS", value: "--max-old-space-size=1536" },
            // Always set GIT_SSH_COMMAND so any git operation the agent runs
            // (fetch, push, clone) works over SSH without a known_hosts file.
            // When the run has an sshSecret the key is mounted at
            // /etc/git-ssh/id and IdentitiesOnly forces its use exclusively.
            sshSecret
              ? {
                  name: "GIT_SSH_COMMAND",
                  value:
                    "ssh -i /etc/git-ssh/id -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes",
                }
              : {
                  name: "GIT_SSH_COMMAND",
                  value: "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
                },
            // OPENCODE_AUTH_CONTENT: opencode checks this env var before
            // reading ~/.local/share/opencode/auth.json.
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
              ? [{ name: "_LLM_KEYS_MARKER", value: "see envFrom" }]
              : []),
            ...gitAuthorEnv,
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
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            ...(sshSecret
              ? [{ name: "git-ssh", mountPath: "/etc/git-ssh", readOnly: true }]
              : []),
          ],
        },
        {
          name: DISPATCHER_CONTAINER,
          image: DISPATCHER_IMAGE,
          imagePullPolicy: "IfNotPresent",
          env: [
            { name: "RUN_NAME", value: run.metadata.name },
            { name: "RUN_NAMESPACE", value: run.metadata.namespace! },
            { name: "RUN_UID", value: run.metadata.uid! },
            { name: "OPENCODE_BASE_URL", value: `http://127.0.0.1:${CONTAINER_PORT}` },
            { name: "WEB_STATS_URL", value: WEB_STATS_URL },
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
// Helpers

function shouldCreateIngress(run: OpenCodeRun): boolean {
  if (!INGRESS_BASE_URL) return false;
  const exposeWeb = run.spec?.expose?.web;
  return exposeWeb === undefined ? EXPOSE_WEB_DEFAULT : exposeWeb;
}

function webURLFor(run: OpenCodeRun): string {
  // INGRESS_BASE_URL = scheme://host[:port]
  // Insert the run name as the leftmost subdomain of the host.
  const url = new URL(INGRESS_BASE_URL);
  url.hostname = `${run.metadata.name}.${url.hostname}`;
  url.pathname = "/";
  return url.toString();
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

  // Ensure Ingress exists (when configured).
  if (shouldCreateIngress(run)) {
    try {
      await networking.readNamespacedIngress({ name: ingressName(run), namespace: ns });
    } catch {
      try {
        await networking.createNamespacedIngress({
          namespace: ns,
          body: renderIngress(run),
        });
        log(`created ingress ${ns}/${ingressName(run)} → ${webURLFor(run)}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/already exists/i.test(msg)) throw e;
      }
    }
    // Backfill webURL/ingressName into status if missing (e.g. operator restarted
    // after ingress feature was enabled, or run existed before the feature).
    if (!run.status?.webURL) {
      await patchStatus(run, {
        ingressName: ingressName(run),
        webURL: webURLFor(run),
      });
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
        body: renderPod(run),
      });
      log(`created pod ${ns}/${podName(run)}`);
      await patchStatus(run, {
        phase: RunPhase.Initializing,
        podName: podName(run),
        serviceName: serviceName(run),
        ...(shouldCreateIngress(run) ? {
          ingressName: ingressName(run),
          webURL: webURLFor(run),
        } : {}),
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
  const podPhase = pod?.status?.phase;
  if (!currentPhase || currentPhase === RunPhase.Pending) {
    await patchStatus(run, {
      phase: RunPhase.Initializing,
      podName: podName(run),
      serviceName: serviceName(run),
      ...(shouldCreateIngress(run) ? {
        ingressName: ingressName(run),
        webURL: webURLFor(run),
      } : {}),
      message: `pod phase: ${podPhase ?? "Unknown"}`,
    });
  }

  // Terminal reflection from pod.
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
  // Check init containers first — when they fail the main containers never
  // start, so containerStatuses has no terminated entries to inspect.
  for (const c of pod?.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated;
    if (t && (t.exitCode ?? 0) !== 0) {
      const detail = t.message?.trim();
      const base = `init container ${c.name} failed (exit ${t.exitCode ?? "?"})`;
      return detail ? `${base}: ${detail}` : base;
    }
  }
  // Main containers.
  const reasons = (pod?.status?.containerStatuses ?? [])
    .map((c) => {
      const t = c.state?.terminated;
      if (!t) return null;
      const detail = t.message?.trim();
      const base = `${c.name}: ${t.reason ?? "Error"} (exit ${t.exitCode ?? "?"})`;
      return detail ? `${base}: ${detail}` : base;
    })
    .filter(Boolean);
  return reasons.length ? reasons.join("; ") : pod?.status?.reason ?? "pod failed";
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
      setTimeout(() => {
        const current = seen.get(key);
        if (current) enqueue(current);
      }, 5000);
    }
  }
}

function periodicResync(): void {
  setInterval(() => {
    for (const run of seen.values()) enqueue(run);
  }, 10_000).unref();
}

// ---------------------------------------------------------------------------
// Informer

async function run(): Promise<void> {
  log(`watching ${API_GROUP_VERSION}/${PLURAL_RUN} in namespace=${NAMESPACE}`);
  if (INGRESS_BASE_URL) {
    log(`ingress base URL: ${INGRESS_BASE_URL}${INGRESS_CLASS ? ` (class: ${INGRESS_CLASS})` : ""}`);
  } else {
    log("no PERCUSSIONIST_INGRESS_BASE_URL set — per-run ingress disabled");
  }

  const path = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${PLURAL_RUN}`;
  const listFn = async () => {
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
