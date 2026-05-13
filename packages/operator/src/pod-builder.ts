// pod-builder.ts — renders the Pod, Service, and Ingress for an OpenCodeRun.

import {
  type V1Pod,
  type V1Service,
  type V1Ingress,
} from "@kubernetes/client-node";
import {
  API_GROUP_VERSION,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  CONTAINER_PORT,
  RUNNER_CONTAINER,
  DISPATCHER_CONTAINER,
  type OpenCodeRun,
  type AgentDef,
} from "@percussionist/api";
import {
  RUNNER_IMAGE_DEFAULT,
  DISPATCHER_IMAGE,
  DISPATCHER_SERVICE_ACCOUNT,
  WEB_STATS_URL,
  INGRESS_BASE_URL,
  INGRESS_CLASS,
  INGRESS_ANNOTATIONS,
  EXPOSE_WEB_DEFAULT,
} from "./config.js";

// ---------------------------------------------------------------------------
// Naming helpers

export const serviceName = (run: OpenCodeRun) => run.metadata.name;
export const podName = (run: OpenCodeRun) => run.metadata.name;
export const ingressName = (run: OpenCodeRun) => run.metadata.name;
export const agentsConfigMapName = (run: OpenCodeRun) =>
  `${run.metadata.name}-agents`;

// ---------------------------------------------------------------------------
// Shared metadata helpers

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
  ...(run.spec.project
    ? { [LABELS.projectName]: run.spec.project }
    : {}),
});

// ---------------------------------------------------------------------------
// Ingress helpers

export function shouldCreateIngress(run: OpenCodeRun): boolean {
  if (!INGRESS_BASE_URL) return false;
  const exposeWeb = run.spec?.expose?.web;
  return exposeWeb === undefined ? EXPOSE_WEB_DEFAULT : exposeWeb;
}

export function webURLFor(run: OpenCodeRun): string {
  const url = new URL(INGRESS_BASE_URL);
  url.hostname = `${run.metadata.name}.${url.hostname}`;
  url.pathname = "/";
  return url.toString();
}

// ---------------------------------------------------------------------------
// Renderers

export function renderService(run: OpenCodeRun): V1Service {
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
      publishNotReadyAddresses: true,
      selector: { [LABELS.runName]: run.metadata.name },
      ports: [
        {
          name: "http",
          port: CONTAINER_PORT,
          targetPort: "http" as unknown as number,
        },
      ],
    },
  };
}

export function renderIngress(run: OpenCodeRun): V1Ingress {
  const host = new URL(INGRESS_BASE_URL).hostname;
  const runHost = `${run.metadata.name}.${host}`;
  const ingress: V1Ingress = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: ingressName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "opencode-web" },
      annotations: { ...INGRESS_ANNOTATIONS },
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
  if (INGRESS_CLASS) ingress.spec!.ingressClassName = INGRESS_CLASS;
  return ingress;
}

export function renderAgentsConfigMap(
  run: OpenCodeRun,
  agents: AgentDef[],
): object {
  const data: Record<string, string> = {};
  for (const a of agents) {
    data[`${a.name}.md`] = a.content;
  }
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: agentsConfigMapName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "agents" },
      ownerReferences: ownerRefsFor(run),
    },
    data,
  };
}

export function renderPod(run: OpenCodeRun, resolvedAgents: AgentDef[]): V1Pod {
  const spec = run.spec;
  const llmKeysSecret = spec.secrets?.llmKeysSecret;
  const image = spec.image ?? RUNNER_IMAGE_DEFAULT;
  const git = spec.source?.git;
  const sshSecret = git?.sshSecret;
  const hasAgents = resolvedAgents.length > 0;

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
    ...(hasAgents
      ? [{ name: "agents-volume", configMap: { name: agentsConfigMapName(run) } }]
      : []),
  ];

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName(run),
      namespace: run.metadata.namespace!,
      labels: { ...commonLabels(run), [LABELS.component]: "runner" },
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
            { name: "NODE_OPTIONS", value: "--max-old-space-size=1536" },
            sshSecret
              ? {
                  name: "GIT_SSH_COMMAND",
                  value:
                    "ssh -i /etc/git-ssh/id -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes",
                }
              : {
                  name: "GIT_SSH_COMMAND",
                  value:
                    "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
                },
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
            // Always inject the cluster-wide opencode config (providers, models, etc.)
            // from the well-known "lmstudio-config" configmap.  Optional so pods start
            // cleanly even if the configmap hasn't been created.
            {
              name: "OPENCODE_CONFIG_CONTENT",
              valueFrom: {
                configMapKeyRef: {
                  name: "opencode-config",
                  key: "opencode.json",
                  optional: true,
                },
              },
            },
            // Per-run override from spec.secrets.opencodeConfigMap (takes precedence).
            ...(spec.secrets?.opencodeConfigMap
              ? [
                  {
                    name: "OPENCODE_CONFIG_CONTENT",
                    valueFrom: {
                      configMapKeyRef: {
                        name: spec.secrets.opencodeConfigMap.name,
                        key: spec.secrets.opencodeConfigMap.key,
                      },
                    },
                  },
                ]
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
            ...(hasAgents
              ? [
                  {
                    name: "agents-volume",
                    mountPath: "/root/.config/opencode/agents",
                  },
                ]
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
            {
              name: "OPENCODE_BASE_URL",
              value: `http://127.0.0.1:${CONTAINER_PORT}`,
            },
            { name: "WEB_STATS_URL", value: WEB_STATS_URL },
            ...(spec.task && !spec.interactive
              ? [{ name: "RUN_TASK", value: spec.task }]
              : []),
            ...(spec.interactive
              ? [{ name: "RUN_INTERACTIVE", value: "1" }]
              : []),
            ...(spec.model ? [{ name: "RUN_MODEL", value: spec.model }] : []),
            ...(spec.agent ? [{ name: "RUN_AGENT", value: spec.agent }] : []),
            { name: "RUN_TIMEOUT_SECONDS", value: String(spec.timeoutSeconds ?? 3600) },
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
