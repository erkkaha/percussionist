// @percussionist/kube — shared Kubernetes client for all percussionist packages.
//
// Provides:
//   - Lazy singleton K8s client (in-cluster or kubeconfig)
//   - Typed CRUD helpers for all CRDs
//   - Status patch helper (uses raw fetch with merge-patch content-type)
//   - Session proxy helpers for OpenCode API
//   - Render utilities (padCols, age, fatal)
//
// Single env var for namespace: PERCUSSIONIST_NAMESPACE (default: "percussionist")

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {
  AppsV1Api,
  type Configuration,
  CoreV1Api,
  CustomObjectsApi,
  createConfiguration,
  type HttpLibrary,
  KubeConfig,
  PatchStrategy,
  ResponseContext,
  SelfDecodingBody,
  ServerConfiguration,
  setHeaderOptions,
  type V1Pod,
  wrapHttpLibrary,
} from '@kubernetes/client-node';
import {
  type AgentCapability,
  API_GROUP,
  API_GROUP_VERSION,
  API_VERSION,
  type BoardStatus,
  type ClusterAgent,
  type ClusterSettings,
  type Finding,
  KIND_CLUSTER_AGENT,
  KIND_CLUSTER_SETTINGS,
  KIND_PROJECT,
  KIND_TASK,
  LABELS,
  OPENCODE_RUNNER_DEFAULTS,
  PLURAL_CLUSTER_AGENT,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  PLURAL_TASK,
  type Project,
  type Run,
  type RunStatus,
  type Task,
  type TaskStatus,
  type TaskType,
} from '@percussionist/api';

// ---------------------------------------------------------------------------
// Node-native HTTP library (bypasses node-fetch v2 TLS issues on Node 24)

/**
 * Build a native HttpLibrary that replaces IsomorphicFetchHttpLibrary.
 * Uses `https.request()` / `http.request()` with the agent set by
 * KubeConfig.applySecurityAuthentication (so TLS options, proxy, and
 * auth flow through `createAgent` as before — no duplicate TLS logic).
 */
function nodeHttpApi(): HttpLibrary {
  return wrapHttpLibrary({
    async send(request) {
      const url = new URL(request.getUrl());
      const method = request.getHttpMethod().toString();
      const body = request.getBody();
      const signal = request.getSignal();
      const agent = request.getAgent();

      return new Promise<ResponseContext>((resolve, reject) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.getHeaders())) {
          headers[k] = v;
        }

        // Set Content-Length from the body when not already present (match
        // isomorphic-fetch behaviour, avoid chunked encoding).
        if (body !== undefined && !headers['content-length'] && !headers['Content-Length']) {
          if (typeof body === 'string') {
            headers['Content-Length'] = String(Buffer.byteLength(body));
          }
        }

        const opts: http.RequestOptions = {
          hostname: url.hostname,
          ...(url.port ? { port: url.port } : {}),
          path: url.pathname + url.search,
          method,
          headers,
          agent: agent as http.Agent | undefined,
        };

        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.request(opts, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) {
                responseHeaders[k] = v.join(', ');
              } else if (v !== undefined) {
                responseHeaders[k] = v;
              }
            }
            resolve(
              new ResponseContext(
                res.statusCode ?? 0,
                responseHeaders,
                new SelfDecodingBody(Promise.resolve(buf)),
              ),
            );
          });
        });

        req.on('error', reject);

        if (signal) {
          if (signal.aborted) {
            req.destroy();
            reject(new Error(signal.reason?.toString() ?? 'The operation was aborted'));
            return;
          }
          const onAbort = () => {
            req.destroy(
              signal.reason
                ? new Error(String(signal.reason))
                : new Error('The operation was aborted'),
            );
          };
          signal.addEventListener('abort', onAbort, { once: true });
          req.on('close', () => signal.removeEventListener('abort', onAbort));
        }

        if (body !== undefined) {
          if (typeof body === 'string') {
            req.write(body);
          } else {
            // FormData / URLSearchParams — unlikely for K8s APIs, best-effort.
            req.write(String(body));
          }
        }
        req.end();
      });
    },
  });
}

/**
 * Build a K8s API client that uses the native node-http library instead of
 * the default IsomorphicFetchHttpLibrary (node-fetch). Mirror of
 * `KubeConfig.makeApiClient()` but with `httpApi` overridden.
 */
export function makeNodeApiClient<T>(kc: KubeConfig, apiCtor: new (config: Configuration) => T): T {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster!');
  const config = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    httpApi: nodeHttpApi(),
    authMethods: { default: kc },
  });
  return new apiCtor(config);
}

// ---------------------------------------------------------------------------
// Namespace

export const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

// ---------------------------------------------------------------------------
// Client initialisation — two modes:
//   in-cluster: loadFromCluster() (service account token)
//   local dev:  loadFromDefault() (kubeconfig)

let _kc: KubeConfig | undefined;
let _core: CoreV1Api | undefined;
let _custom: CustomObjectsApi | undefined;
let _apps: AppsV1Api | undefined;

function init() {
  if (_kc) return;
  _kc = new KubeConfig();
  try {
    _kc.loadFromCluster();
  } catch {
    _kc.loadFromDefault();
  }
  _core = makeNodeApiClient(_kc, CoreV1Api);
  _custom = makeNodeApiClient(_kc, CustomObjectsApi);
  _apps = makeNodeApiClient(_kc, AppsV1Api);
}

export function kubeConfig(): KubeConfig {
  init();
  return _kc!;
}

export function core(): CoreV1Api {
  init();
  return _core!;
}

export function custom(): CustomObjectsApi {
  init();
  return _custom!;
}

export function apps(): AppsV1Api {
  init();
  return _apps!;
}

// For CLI use — loads from kubeconfig only (no in-cluster fallback).
export function loadFromKubeconfig(): {
  kc: KubeConfig;
  core: CoreV1Api;
  custom: CustomObjectsApi;
} {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return {
    kc,
    core: makeNodeApiClient(kc, CoreV1Api),
    custom: makeNodeApiClient(kc, CustomObjectsApi),
  };
}

function getErrorStatusCode(err: unknown): number | undefined {
  return (
    (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code
  );
}

function isNotFoundError(err: unknown): boolean {
  return getErrorStatusCode(err) === 404;
}

function isConflictError(err: unknown): boolean {
  return getErrorStatusCode(err) === 409;
}

// Merge-patch header for all CRD/ConfigMap PATCH calls via the shared CA-aware
// client (`custom()` / `core()`). TLS trust comes from the loaded KubeConfig
// rather than an ambient NODE_EXTRA_CA_CERTS env var.
const MERGE_PATCH = () => setHeaderOptions('Content-Type', PatchStrategy.MergePatch);

// ---------------------------------------------------------------------------
// Run helpers

export async function listRuns(ns: string = NAMESPACE, client = custom()): Promise<Run[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
  })) as { items: Run[] };
  return res.items ?? [];
}

export async function getRun(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Run> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    name,
  })) as Run;
}

export async function createRun(run: Run, ns: string = NAMESPACE, client = custom()): Promise<Run> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    body: run,
  })) as Run;
}

export async function deleteRun(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_RUN,
    name,
  });
}

export async function patchRunStatus(
  name: string,
  statusPatch: Partial<RunStatus>,
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Run> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    try {
      return (await custom().patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: PLURAL_RUN,
          name,
          body: { status: statusPatch },
        },
        MERGE_PATCH(),
      )) as Run;
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Patch annotations on a Run (metadata only, not status).
export async function patchRunAnnotations(
  name: string,
  annotations: Record<string, string | undefined>,
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Run> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    try {
      return (await custom().patchNamespacedCustomObject(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: PLURAL_RUN,
          name,
          body: { metadata: { annotations } },
        },
        MERGE_PATCH(),
      )) as Run;
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// ClusterAgent helpers (cluster-scoped — no namespace)

export async function listClusterAgents(client = custom()): Promise<ClusterAgent[]> {
  const res = (await client.listClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
  })) as { items: ClusterAgent[] };
  return res.items ?? [];
}

export interface CapabilityValidationSuccess {
  ok: true;
  requiredCapability: AgentCapability;
}

export interface CapabilityValidationFailure {
  ok: false;
  requiredCapability: AgentCapability;
  error: string;
}

export type CapabilityValidationResult = CapabilityValidationSuccess | CapabilityValidationFailure;

export function requiredCapabilityForTaskType(taskType: TaskType): AgentCapability {
  return taskType === 'PLAN' ? 'task.plan.execute' : 'task.build.execute';
}

export async function validateAgentTaskCapability(
  project: Project,
  taskType: TaskType,
  selectedAgent: string,
  client = custom(),
): Promise<CapabilityValidationResult> {
  const requiredCapability = requiredCapabilityForTaskType(taskType);
  const roster = (project.spec.agents ?? []).map((a) => a.name);

  if (!roster.includes(selectedAgent)) {
    return {
      ok: false,
      requiredCapability,
      error: `agent "${selectedAgent}" not in project roster: ${roster.join(', ') || '(empty)'}`,
    };
  }

  const agents = await listClusterAgents(client);
  const clusterAgent = agents.find((agent) => agent.metadata?.name === selectedAgent);
  if (!clusterAgent) {
    return {
      ok: false,
      requiredCapability,
      error: `cluster agent "${selectedAgent}" not found`,
    };
  }

  const capabilities = clusterAgent.spec.capabilities ?? [];
  if (!capabilities.includes(requiredCapability)) {
    return {
      ok: false,
      requiredCapability,
      error: `agent "${selectedAgent}" missing required capability "${requiredCapability}" for ${taskType} tasks`,
    };
  }

  return {
    ok: true,
    requiredCapability,
  };
}

export async function getClusterAgent(name: string, client = custom()): Promise<ClusterAgent> {
  return (await client.getClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  })) as ClusterAgent;
}

export async function createClusterAgent(
  agent: ClusterAgent,
  client = custom(),
): Promise<ClusterAgent> {
  return (await client.createClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    body: agent,
  })) as ClusterAgent;
}

export async function updateClusterAgent(
  name: string,
  spec: ClusterAgent['spec'],
  client = custom(),
): Promise<ClusterAgent> {
  const existing = await getClusterAgent(name, client);
  return (await client.replaceClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_CLUSTER_AGENT,
      metadata: { name, resourceVersion: existing.metadata.resourceVersion },
      spec,
    },
  })) as ClusterAgent;
}

export async function deleteClusterAgent(name: string, client = custom()): Promise<void> {
  await client.deleteClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_AGENT,
    name,
  });
}

// ---------------------------------------------------------------------------
// ClusterSettings helpers (cluster-scoped singleton — name is always "default")

export async function getClusterSettings(
  name = 'default',
  client = custom(),
): Promise<ClusterSettings> {
  return (await client.getClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_SETTINGS,
    name,
  })) as ClusterSettings;
}

export async function updateClusterSettings(
  name: string,
  spec: ClusterSettings['spec'],
  client = custom(),
): Promise<ClusterSettings> {
  let existing: ClusterSettings | null = null;
  try {
    existing = await getClusterSettings(name, client);
  } catch (e) {
    if (!isNotFoundError(e)) {
      console.error(
        `[kube ${new Date().toISOString()}] getClusterSettings(${name}) failed with status=${getErrorStatusCode(e) ?? 'unknown'}`,
        e,
      );
      throw e;
    }
  }
  const body = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_CLUSTER_SETTINGS,
    metadata: { name, resourceVersion: existing?.metadata.resourceVersion },
    spec,
  };
  if (existing) {
    return (await client.replaceClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL_CLUSTER_SETTINGS,
      name,
      body,
    })) as ClusterSettings;
  }
  return (await client.createClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_CLUSTER_SETTINGS,
    body,
  })) as ClusterSettings;
}

// ---------------------------------------------------------------------------
// Project helpers

export async function listProjects(ns: string = NAMESPACE, client = custom()): Promise<Project[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
  })) as { items: Project[] };
  return res.items ?? [];
}

export async function listAllProjects(client = custom()): Promise<Project[]> {
  const res = (await client.listClusterCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    plural: PLURAL_PROJECT,
  })) as { items: Project[] };
  return res.items ?? [];
}

export async function getProject(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
  })) as Project;
}

export async function createProject(
  project: Project,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    body: project,
  })) as Project;
}

export async function updateProject(
  name: string,
  spec: Project['spec'],
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Project> {
  const existing = await getProject(name, ns, client);
  return (await client.replaceNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
    body: {
      apiVersion: API_GROUP_VERSION,
      kind: KIND_PROJECT,
      metadata: { name, resourceVersion: existing.metadata.resourceVersion },
      spec,
    },
  })) as Project;
}

export async function patchProjectSpec(
  name: string,
  specPatch: Partial<Project['spec']>,
  ns: string = NAMESPACE,
): Promise<Project> {
  return (await custom().patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_PROJECT,
      name,
      body: { spec: specPatch },
    },
    MERGE_PATCH(),
  )) as Project;
}

export async function patchProject(
  name: string,
  patch: { metadata?: Partial<Project['metadata']>; spec?: Partial<Project['spec']> },
  ns: string = NAMESPACE,
): Promise<Project> {
  return (await custom().patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_PROJECT,
      name,
      body: patch,
    },
    MERGE_PATCH(),
  )) as Project;
}

export async function patchProjectStatus(
  name: string,
  statusPatch: { board?: Partial<BoardStatus> },
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Project> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    try {
      return (await custom().patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: PLURAL_PROJECT,
          name,
          body: { status: statusPatch },
        },
        MERGE_PATCH(),
      )) as Project;
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function deleteProject(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_PROJECT,
    name,
  });
}

// ---------------------------------------------------------------------------
// Task helpers

export async function listTasks(
  project?: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task[]> {
  const res = (await client.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    ...(project ? { labelSelector: `${LABELS.projectName}=${project}` } : {}),
  })) as { items: Task[] };
  return res.items ?? [];
}

export async function getTask(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  return (await client.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    name,
  })) as Task;
}

export async function createTask(
  task: Task,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  return (await client.createNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    body: task,
  })) as Task;
}

export async function deleteTask(
  name: string,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<void> {
  await client.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: ns,
    plural: PLURAL_TASK,
    name,
  });
}

export async function patchTaskStatus(
  name: string,
  statusPatch: Partial<TaskStatus>,
  ns: string = NAMESPACE,
  maxRetries = 3,
): Promise<Task> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
    try {
      return (await custom().patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: ns,
          plural: PLURAL_TASK,
          name,
          body: { status: statusPatch },
        },
        MERGE_PATCH(),
      )) as Task;
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Patch a Task (metadata + spec, not status).
export async function patchTask(
  name: string,
  patch: Partial<Pick<Task, 'metadata' | 'spec'>>,
  ns: string = NAMESPACE,
  client = custom(),
): Promise<Task> {
  return (await client.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: ns,
      plural: PLURAL_TASK,
      name,
      body: patch,
    },
    MERGE_PATCH(),
  )) as Task;
}

// Build a new Task object ready for createTask().
// projectUid is needed for the ownerReference.
// All tasks must persist a phase; "pending" is the default.
export function buildTask({
  name,
  projectName,
  projectUid,
  ns,
  spec,
}: {
  name: string;
  projectName: string;
  projectUid: string;
  ns: string;
  spec: Task['spec'];
}): Task {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_TASK,
    metadata: {
      name,
      namespace: ns,
      labels: {
        [LABELS.projectName]: projectName,
        [LABELS.component]: 'task',
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name: projectName,
          uid: projectUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec,
    status: { phase: 'pending' as const },
  };
}

// ---------------------------------------------------------------------------
// Pod helpers

export async function readPodLog(
  podName: string,
  container: string,
  tailLines?: number,
  ns: string = NAMESPACE,
): Promise<string> {
  const res = await core().readNamespacedPodLog({
    name: podName,
    namespace: ns,
    container,
    tailLines,
  });
  return res ?? '';
}

export async function getPod(name: string, ns: string = NAMESPACE): Promise<V1Pod> {
  return await core().readNamespacedPod({ name, namespace: ns });
}

export async function listPodsByLabels(
  labels: Record<string, string>,
  ns: string = NAMESPACE,
): Promise<V1Pod[]> {
  const labelSelector = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const res = await core().listNamespacedPod({ namespace: ns, labelSelector });
  return res.items ?? [];
}

export async function listPodEvents(
  podName: string,
  ns: string = NAMESPACE,
): Promise<
  Array<{
    type: string;
    reason: string;
    message: string;
    count: number;
    firstTimestamp: string;
    lastTimestamp: string;
    source: string;
  }>
> {
  const res = await core().listNamespacedEvent({
    namespace: ns,
    fieldSelector: `involvedObject.name=${podName}`,
  });
  return (res.items ?? []).map((e) => ({
    type: e.type ?? '',
    reason: e.reason ?? '',
    message: e.message ?? '',
    count: e.count ?? 1,
    firstTimestamp: e.firstTimestamp?.toISOString() ?? '',
    lastTimestamp: e.lastTimestamp?.toISOString() ?? '',
    source: e.source ? `${e.source.component ?? ''}/${e.source.host ?? ''}` : '',
  }));
}

// ---------------------------------------------------------------------------
// OpenCode API proxy helpers (talk to opencode server inside run pods)

async function readJsonWithLimit(res: Response, maxBytes: number): Promise<unknown> {
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`OpenCode session response too large (${total} bytes)`);
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks, total).toString('utf8');
  return JSON.parse(body) as unknown;
}

export async function fetchSessionMessages(
  serviceName: string,
  sessionID: string,
  ns: string = NAMESPACE,
): Promise<unknown> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/message`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  });

  try {
    if (!res.ok) {
      throw new Error(`OpenCode API ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > 20_000_000) {
      throw new Error(`OpenCode session response too large (${contentLength} bytes)`);
    }

    return readJsonWithLimit(res, 20_000_000);
  } finally {
    clearTimeout(timeout);
  }
}

export async function postSessionMessage(
  serviceName: string,
  sessionID: string,
  text: string,
  ns: string = NAMESPACE,
): Promise<void> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/message`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenCode API ${res.status}: ${await res.text().catch(() => '')}`);
}

export async function postPermissionReply(
  serviceName: string,
  sessionID: string,
  permissionID: string,
  response: 'once' | 'always' | 'reject',
  ns: string = NAMESPACE,
): Promise<void> {
  const url = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${sessionID}/permissions/${permissionID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new Error(`OpenCode permission API ${res.status}: ${await res.text().catch(() => '')}`);
}

// Fetch all sessions and their messages from a live run pod.
// Returns combined messages from all sessions, ordered by session discovery.
export async function fetchAllSessionMessages(
  serviceName: string,
  ns: string = NAMESPACE,
): Promise<{ sessions: Array<{ id: string; messages: unknown[] }>; allMessages: unknown[] }> {
  const listUrl = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session`;
  const listRes = await fetch(listUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!listRes.ok) {
    throw new Error(
      `OpenCode session list API ${listRes.status}: ${await listRes.text().catch(() => '')}`,
    );
  }
  const listData = (await listRes.json()) as unknown;
  const sessionList: Array<{ id: string }> = Array.isArray(listData)
    ? listData
    : (((listData as Record<string, unknown>).items ??
        (listData as Record<string, unknown>).sessions ??
        []) as Array<{ id: string }>);

  const sessions: Array<{ id: string; messages: unknown[] }> = [];
  const allMessages: unknown[] = [];

  for (const session of sessionList) {
    try {
      const msgUrl = `http://${serviceName}.${ns}.svc.cluster.local:${OPENCODE_RUNNER_DEFAULTS.port}/session/${session.id}/message`;
      const msgRes = await fetch(msgUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!msgRes.ok) continue;
      const msgData = (await msgRes.json()) as unknown;
      const messages: unknown[] = Array.isArray(msgData)
        ? msgData
        : (((msgData as Record<string, unknown>).items ?? []) as unknown[]);
      sessions.push({ id: session.id, messages });
      allMessages.push(...messages);
    } catch {
      // Skip sessions that fail to fetch
    }
  }

  return { sessions, allMessages };
}

// Session snapshot from ConfigMap (fallback when pod is gone).
export async function readSessionConfigMap(
  runName: string,
  sessionID: string,
  ns: string = NAMESPACE,
): Promise<{ messages: unknown[]; truncated: boolean } | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const sessionsRaw = cm.data?.['sessions.json'];
    if (!sessionsRaw) return null;
    const sessions: string[] = JSON.parse(sessionsRaw);
    if (!sessions.includes(sessionID)) return null;
    const raw = cm.data![`messages-${sessionID}.json`];
    if (!raw) return null;
    return {
      messages: JSON.parse(raw),
      truncated: cm.data?.[`truncated-${sessionID}`] === 'true',
    };
  } catch (e: unknown) {
    if (
      ((e as { statusCode?: number; code?: number }).statusCode ??
        (e as { code?: number }).code) === 404
    )
      return null;
    throw e;
  }
}

// Read all sessions from ConfigMap snapshot (fallback when pod is gone).
// Returns all sessions with their messages combined.
export async function readAllSessionsFromConfigMap(
  runName: string,
  ns: string = NAMESPACE,
): Promise<{
  sessions: Array<{ id: string; messages: unknown[]; truncated: boolean }>;
  allMessages: unknown[];
} | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${runName}-session`,
      namespace: ns,
    });
    const sessionsRaw = cm.data?.['sessions.json'];
    if (!sessionsRaw) return null;
    const sessionIDs: string[] = JSON.parse(sessionsRaw);

    const sessions: Array<{ id: string; messages: unknown[]; truncated: boolean }> = [];
    const allMessages: unknown[] = [];

    for (const sessionID of sessionIDs) {
      const raw = cm.data?.[`messages-${sessionID}.json`];
      if (!raw) continue;
      const messages: unknown[] = JSON.parse(raw);
      const truncated = cm.data?.[`truncated-${sessionID}`] === 'true';
      sessions.push({ id: sessionID, messages, truncated });
      allMessages.push(...messages);
    }

    return { sessions, allMessages };
  } catch (e: unknown) {
    if (
      ((e as { statusCode?: number; code?: number }).statusCode ??
        (e as { code?: number }).code) === 404
    )
      return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Plan ConfigMap helpers — store/retrieve plan artifacts per project.
// ConfigMap name: {project}-plans, data key: {task}.md

const CONFIGMAP_SIZE_WARN = 900 * 1024; // 900 KB soft limit warning

export async function getPlansConfigMap(
  projectName: string,
  ns: string = NAMESPACE,
): Promise<{
  apiVersion: string;
  kind: string;
  metadata: Record<string, unknown>;
  data?: Record<string, string>;
} | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: `${projectName}-plans`,
      namespace: ns,
    });
    return {
      apiVersion: cm.apiVersion ?? 'v1',
      kind: cm.kind ?? 'ConfigMap',
      metadata: cm.metadata as unknown as Record<string, unknown>,
      data: cm.data,
    };
  } catch (e: unknown) {
    if (
      ((e as { statusCode?: number; code?: number }).statusCode ??
        (e as { code?: number }).code) === 404
    )
      return null;
    throw e;
  }
}

export async function writePlanToConfigMap(
  projectName: string,
  taskName: string,
  content: string,
  ns: string = NAMESPACE,
): Promise<{ written: boolean; sizeBytes: number; warning?: string }> {
  const key = `${taskName}.md`;
  const cmName = `${projectName}-plans`;
  let existing = await getPlansConfigMap(projectName, ns);

  if (!existing) {
    existing = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: cmName,
        namespace: ns,
        labels: {
          [LABELS.projectName]: projectName,
          'percussionist.dev/component': 'plans',
        },
      },
      data: {},
    };
  }

  const newData = { ...existing.data, [key]: content };
  const totalSize = Object.values(newData).reduce(
    (sum, v) => sum + Buffer.byteLength(v, 'utf8'),
    0,
  );
  let warning: string | undefined;
  if (totalSize > CONFIGMAP_SIZE_WARN) {
    warning = `ConfigMap data size (${Math.round(totalSize / 1024)}KB) approaching 1MB limit. Consider removing old plans.`;
  }

  if (!existing.metadata.resourceVersion) {
    // Create new ConfigMap
    await core().createNamespacedConfigMap({
      namespace: ns,
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: existing.metadata as any,
        data: newData,
      },
    });
  } else {
    // Update existing ConfigMap
    await core().replaceNamespacedConfigMap({
      name: cmName,
      namespace: ns,
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          ...existing.metadata,
        } as any,
        data: newData,
      },
    });
  }

  return { written: true, sizeBytes: Buffer.byteLength(content, 'utf8'), warning };
}

export async function readPlanFromConfigMap(
  projectName: string,
  taskName: string,
  ns: string = NAMESPACE,
): Promise<string | null> {
  const cm = await getPlansConfigMap(projectName, ns);
  if (!cm || !cm.data) return null;
  return cm.data[`${taskName}.md`] ?? null;
}

// ---------------------------------------------------------------------------
// Findings ConfigMap helpers — per-project findings inbox and triage.
// ConfigMap name: {project}-findings, data keys: inbox/<id>.json and triaged/<clusterId>.json
//
// IMPORTANT: appendFindingToConfigMap uses K8s strategic merge-patch on the data
// field (setting only a single key) rather than read-modify-write, so concurrent
// agents writing to the same project never clobber each other's findings.

const FINDINGS_COMPONENT = 'findings';

function findingsConfigMapName(project: string): string {
  return `${project}-findings`;
}

/**
 * Append a single finding to the project's findings ConfigMap using merge-patch.
 * Sets only `data["inbox/<finding.id>.json"]` — conflict-free across concurrent agents.
 * Creates the ConfigMap if it does not exist (404 → create).
 */
export async function appendFindingToConfigMap(
  project: string,
  finding: Finding,
  ns: string = NAMESPACE,
): Promise<{ written: true }> {
  const cmName = findingsConfigMapName(project);
  const key = `inbox/${finding.id}.json`;
  const data = { [key]: JSON.stringify(finding) };
  const labels = {
    [LABELS.projectName]: project,
    [LABELS.component]: FINDINGS_COMPONENT,
  };

  // Try merge-patch first (fast path for existing ConfigMap). Sets only the
  // single inbox key — conflict-free across concurrent agents.
  try {
    await core().patchNamespacedConfigMap(
      { name: cmName, namespace: ns, body: { metadata: { labels }, data } },
      MERGE_PATCH(),
    );
    return { written: true };
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }

  // ConfigMap does not exist — create it.
  await core().createNamespacedConfigMap({
    namespace: ns,
    body: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cmName, namespace: ns, labels },
      data,
    },
  });
  return { written: true };
}

/**
 * Read the full findings ConfigMap. Returns null if it does not exist.
 */
export async function getFindingsConfigMap(
  project: string,
  ns: string = NAMESPACE,
): Promise<Record<string, string> | null> {
  try {
    const cm = await core().readNamespacedConfigMap({
      name: findingsConfigMapName(project),
      namespace: ns,
    });
    return (cm.data as Record<string, string> | undefined) ?? null;
  } catch (e: unknown) {
    if (((e as { statusCode?: number }).statusCode ?? (e as { code?: number }).code) === 404) {
      return null;
    }
    throw e;
  }
}

/**
 * Parse inbox findings from raw ConfigMap data.
 * Returns findings sorted by createdAt ascending (oldest first).
 */
export function parseInboxFindings(data: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('inbox/') || !key.endsWith('.json')) continue;
    try {
      findings.push(JSON.parse(value) as Finding);
    } catch {
      // Skip malformed entries.
    }
  }
  findings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return findings;
}

/**
 * Parse triaged findings from raw ConfigMap data.
 * Returns findings keyed by clusterId.
 */
export function parseTriagedFindings(data: Record<string, string>): Map<string, Finding> {
  const map = new Map<string, Finding>();
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('triaged/') || !key.endsWith('.json')) continue;
    try {
      const f = JSON.parse(value) as Finding;
      if (f.clusterId) map.set(f.clusterId, f);
    } catch {
      // Skip malformed entries.
    }
  }
  return map;
}

/**
 * Merge-patch the findings ConfigMap to process inbox findings.
 * Writes triaged entries and removes processed inbox entries in one atomic
 * operation (single merge-patch). The manager (single-replica) is the only
 * writer of triaged/* and the only deleter of inbox/*, so this is safe.
 */
export async function patchFindingsConfigMap(
  project: string,
  patch: Record<string, string | null>,
  ns: string = NAMESPACE,
): Promise<void> {
  const cmName = findingsConfigMapName(project);
  await core().patchNamespacedConfigMap(
    { name: cmName, namespace: ns, body: { data: patch } },
    MERGE_PATCH(),
  );
}

// ---------------------------------------------------------------------------
// Utility functions

// Deterministic hash of a git URL for mirror directory naming.
export function gitUrlHash(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Render utilities

export function padCols(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2)))
        .join(''),
    )
    .join('\n');
}

export function age(iso: string | undefined): string {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fatal(prefix: string, e: unknown): never {
  const anyE = e as { body?: { message?: string }; message?: string };
  const msg = anyE?.body?.message ?? anyE?.message ?? String(e);
  console.error(`beatctl: ${prefix}: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Metrics helpers (metrics.k8s.io/v1beta1 — requires metrics-server addon).

export interface NodeMetric {
  name: string;
  timestamp: string;
  window: string;
  usage: { cpu: string; memory: string };
}

export interface NodeCapacity {
  name: string;
  cpu: string;
  memory: string;
}

export interface NodeCapacityTotal {
  name: string;
  allocatableCpu: string;
  allocatableMemory: string;
  capacityCpu: string;
  capacityMemory: string;
}

export interface NodeHostStats {
  name: string;
  /** Host-level memory usage in bytes (node.memory.usageBytes from kubelet). */
  hostMemoryBytes: number;
  /** Host-level CPU usage in nanocores (node.cpu.usageNanoCores from kubelet). */
  hostCpuNanoCores: number;
  /** Host-level filesystem used bytes (node.fs.usedBytes from kubelet, nullable). */
  hostFsUsedBytes?: number | null;
  /** Host-level filesystem capacity bytes (node.fs.capacityBytes from kubelet, nullable). */
  hostFsCapacityBytes?: number | null;
  /** Host-level filesystem available bytes (node.fs.availableBytes from kubelet, nullable). */
  hostFsAvailableBytes?: number | null;
}

export interface PodMetric {
  name: string;
  namespace: string;
  timestamp: string;
  window: string;
  containers: { name: string; usage: { cpu: string; memory: string } }[];
}

const kubeletSummaryCache = new Map<string, { data: NodeHostStats; ts: number }>();
const KUBELET_CACHE_TTL = 5_000;

/** Fetch host-level memory/CPU from kubelet's /stats/summary (proxied via API server). */
export async function listNodeHostStats(nodeName: string): Promise<NodeHostStats> {
  const cached = kubeletSummaryCache.get(nodeName);
  if (cached && Date.now() - cached.ts < KUBELET_CACHE_TTL) return cached.data;

  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error('No service account token available');

  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const url = `https://${host}:${port}/api/v1/nodes/${encodeURIComponent(nodeName)}/proxy/stats/summary`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new Error(`kubelet summary ${res.status}: ${await res.text().catch(() => '')}`);

  type SummaryResponse = {
    node: {
      cpu: { usageNanoCores: number };
      memory: { usageBytes: number; availableBytes: number; workingSetBytes: number };
      fs?: { usedBytes?: number; capacityBytes?: number; availableBytes?: number };
    };
  };
  const body = (await res.json()) as SummaryResponse;
  const result: NodeHostStats = {
    name: nodeName,
    hostMemoryBytes: body.node?.memory?.usageBytes ?? 0,
    hostCpuNanoCores: body.node?.cpu?.usageNanoCores ?? 0,
    // Populate filesystem fields defensively — kubelet may omit fs data on some runtimes.
    ...(body.node?.fs
      ? {
          hostFsUsedBytes: body.node.fs.usedBytes ?? null,
          hostFsCapacityBytes: body.node.fs.capacityBytes ?? null,
          hostFsAvailableBytes: body.node.fs.availableBytes ?? null,
        }
      : {}),
  };
  kubeletSummaryCache.set(nodeName, { data: result, ts: Date.now() });
  return result;
}

/** Fetch node capacity (allocatable + total capacity CPU/memory) from the core API. */
export async function listNodeCapacities(): Promise<NodeCapacityTotal[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error('No service account token available');

  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const url = `https://${host}:${port}/api/v1/nodes`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`node API ${res.status}: ${await res.text().catch(() => '')}`);
  type NodeItem = {
    metadata: { name: string };
    status: {
      allocatable: { cpu: string; memory: string };
      capacity: { cpu: string; memory: string };
    };
  };
  const body = (await res.json()) as { items: NodeItem[] };
  return (body.items ?? []).map((item) => ({
    name: item.metadata.name,
    allocatableCpu: item.status.allocatable.cpu,
    allocatableMemory: item.status.allocatable.memory,
    capacityCpu: item.status.capacity.cpu,
    capacityMemory: item.status.capacity.memory,
  }));
}

export async function listNodeMetrics(): Promise<NodeMetric[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error('No service account token available');

  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const url = `https://${host}:${port}/apis/metrics.k8s.io/v1beta1/nodes`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`metrics API ${res.status}: ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as {
    items?: Array<{
      metadata: { name: string };
      timestamp: string;
      window: string;
      usage: { cpu: string; memory: string };
    }>;
  };
  return (body.items ?? []).map((item) => ({
    name: item.metadata.name,
    timestamp: item.timestamp,
    window: item.window,
    usage: item.usage,
  }));
}

export async function listPodMetrics(ns: string = NAMESPACE): Promise<PodMetric[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error('No service account token available');

  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const url = `https://${host}:${port}/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`metrics API ${res.status}: ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as {
    items?: Array<{
      metadata: { name: string; namespace: string };
      timestamp: string;
      window: string;
      containers: Array<{ name: string; usage: { cpu: string; memory: string } }>;
    }>;
  };
  return (body.items ?? []).map((item) => ({
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    timestamp: item.timestamp,
    window: item.window,
    containers: item.containers,
  }));
}

// ---------------------------------------------------------------------------
// Workspace exec — spawn a one-off maintenance pod to run a command against
// the project data PVC, collect its output, then delete the pod.

// Pod resource helpers (used by web metrics)
export interface ContainerResources {
  name: string;
  requests: { cpu: string; memory: string; storage?: string };
  limits: { cpu: string; memory: string; storage?: string };
}

export interface PodResourceSpec {
  name: string;
  nodeName: string;
  containers: ContainerResources[];
  podRequests: { cpu: string; memory: string; storage?: string };
  podLimits: { cpu: string; memory: string; storage?: string };
}

function parseCpuRaw(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('n')) return Math.round(n / 1_000_000);
  if (raw.endsWith('u')) return Math.round(n / 1_000);
  if (raw.endsWith('m')) return n;
  return Math.round(n * 1000);
}

function parseMemoryRaw(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('Ki')) return Math.round(n / 1024);
  if (raw.endsWith('Mi')) return n;
  if (raw.endsWith('Gi')) return n * 1024;
  if (raw.endsWith('Ti')) return n * 1024 * 1024;
  return Math.round(n / (1024 * 1024));
}

function addCpu(a: string, b: string): string {
  return `${parseCpuRaw(a) + parseCpuRaw(b)}m`;
}

function addMemory(a: string, b: string): string {
  return `${parseMemoryRaw(a) + parseMemoryRaw(b)}Mi`;
}

/** Fetch pod specs from the core API and extract container resource requests/limits. */
export async function listPodResources(ns: string = NAMESPACE): Promise<PodResourceSpec[]> {
  const token = readServiceAccountToken() ?? readKubeconfigToken();
  if (!token) throw new Error('No service account token available');

  const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const url = `https://${host}:${port}/api/v1/namespaces/${ns}/pods`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`pods API ${res.status}: ${await res.text().catch(() => '')}`);
  type PodItem = {
    metadata: { name: string };
    spec: {
      nodeName: string;
      containers: Array<{
        name: string;
        resources?: {
          requests?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
          limits?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
        };
      }>;
    };
  };
  const body = (await res.json()) as { items: PodItem[] };
  return (body.items ?? []).map((pod) => {
    const containers = (pod.spec?.containers ?? []).map((c) => {
      const req = c.resources?.requests;
      const lim = c.resources?.limits;
      return {
        name: c.name,
        requests: {
          cpu: req?.cpu ?? '0',
          memory: req?.memory ?? '0',
          storage: req?.['ephemeral-storage'],
        },
        limits: {
          cpu: lim?.cpu ?? '0',
          memory: lim?.memory ?? '0',
          storage: lim?.['ephemeral-storage'],
        },
      };
    });
    const podRequests = containers.reduce(
      (acc, c) => ({
        cpu: addCpu(acc.cpu, c.requests.cpu),
        memory: addMemory(acc.memory, c.requests.memory),
        storage: acc.storage || c.requests.storage,
      }),
      { cpu: '0', memory: '0' } as { cpu: string; memory: string; storage?: string },
    );
    const podLimits = containers.reduce(
      (acc, c) => ({
        cpu: addCpu(acc.cpu, c.limits.cpu),
        memory: addMemory(acc.memory, c.limits.memory),
        storage: acc.storage || c.limits.storage,
      }),
      { cpu: '0', memory: '0' } as { cpu: string; memory: string; storage?: string },
    );
    return {
      name: pod.metadata.name,
      nodeName: pod.spec?.nodeName ?? '',
      containers,
      podRequests,
      podLimits,
    };
  });
}

/** Compute total resource allocation per node across all pods in a namespace. */
export async function listNodeAllocated(
  ns: string = NAMESPACE,
): Promise<Map<string, { cpu: string; memory: string }>> {
  const pods = await listPodResources(ns);
  const nodeMap = new Map<string, { cpuSum: number; memSum: number }>();
  for (const pod of pods) {
    const cur = nodeMap.get(pod.nodeName) ?? { cpuSum: 0, memSum: 0 };
    cur.cpuSum += parseCpuRaw(pod.podRequests.cpu);
    cur.memSum += parseMemoryRaw(pod.podRequests.memory);
    nodeMap.set(pod.nodeName, cur);
  }
  const result = new Map<string, { cpu: string; memory: string }>();
  for (const [node, totals] of nodeMap) {
    result.set(node, { cpu: `${totals.cpuSum}m`, memory: `${totals.memSum}Mi` });
  }
  return result;
}

export interface WorkspaceExecResult {
  stdout: string;
  exitCode: number | null;
  podName: string;
}

export async function execInWorkspace(
  projectName: string,
  command: string,
  mountPath = '/data',
  timeoutMs = 120_000,
  ns: string = NAMESPACE,
): Promise<WorkspaceExecResult> {
  const podName = `ws-exec-${projectName}-${Date.now()}`.slice(0, 63).replace(/[^a-z0-9-]/g, '-');

  // Resolve project-level overrides (image + PVC name) with safe fallbacks.
  let execImage = 'alpine/git:v2.54.0';
  let pvcName = `${projectName}-data`;
  try {
    const project = await getProject(projectName, ns);
    execImage = project.spec.exec?.image ?? 'alpine/git:v2.54.0';
    pvcName = project.spec.data?.pvcName ?? `${projectName}-data`;
  } catch {
    // Project not found or inaccessible — use defaults (backward compatible).
  }

  const pod: V1Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: ns,
      labels: {
        'app.kubernetes.io/managed-by': 'percussionist',
        'percussionist.dev/component': 'ws-exec',
        'percussionist.dev/project': projectName,
      },
    },
    spec: {
      restartPolicy: 'Never',
      containers: [
        {
          name: 'exec',
          image: execImage,
          command: ['/bin/sh', '-c', command],
          volumeMounts: [{ name: 'data', mountPath }],
        },
      ],
      volumes: [
        {
          name: 'data',
          persistentVolumeClaim: { claimName: pvcName },
        },
      ],
    },
  };

  await core().createNamespacedPod({ namespace: ns, body: pod });

  // Poll until the pod reaches a terminal phase or timeout
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null = null;
  let finalPhase = 'Unknown';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    let podStatus: V1Pod;
    try {
      podStatus = await core().readNamespacedPod({ name: podName, namespace: ns });
    } catch {
      break;
    }
    finalPhase = podStatus.status?.phase ?? 'Unknown';
    if (finalPhase === 'Succeeded' || finalPhase === 'Failed') {
      exitCode = podStatus.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? null;
      break;
    }
  }

  // Collect logs before deletion (best-effort)
  let stdout = '';
  try {
    const logRes = await core().readNamespacedPodLog({
      name: podName,
      namespace: ns,
      container: 'exec',
    });
    stdout = typeof logRes === 'string' ? logRes : JSON.stringify(logRes);
  } catch {
    stdout = `(logs unavailable — pod phase: ${finalPhase})`;
  }

  // Delete the pod (best-effort)
  core()
    .deleteNamespacedPod({ name: podName, namespace: ns })
    .catch(() => {
      /* ignore */
    });

  return { stdout, exitCode, podName };
}

// ---------------------------------------------------------------------------
// Deployment image inspection

export interface DeploymentImageInfo {
  /** Full image string, e.g. ghcr.io/erkkaha/percussionist/operator:v0.1.4 */
  image: string;
  /** Tag portion only, e.g. v0.1.4 */
  tag: string;
  /** Registry + org prefix without the component name, e.g. ghcr.io/erkkaha/percussionist */
  registryPrefix: string;
}

/**
 * Read the first container image for each named deployment.
 * Returns a map of deploymentName → DeploymentImageInfo.
 * Missing or errored deployments are omitted from the result.
 */
export async function getDeploymentImages(
  namespace: string,
  deploymentNames: string[],
): Promise<Record<string, DeploymentImageInfo>> {
  const results: Record<string, DeploymentImageInfo> = {};
  await Promise.all(
    deploymentNames.map(async (name) => {
      try {
        const res = await apps().readNamespacedDeployment({ name, namespace });
        const image = res.spec?.template?.spec?.containers?.[0]?.image ?? '';
        if (!image) return;
        const colonIdx = image.lastIndexOf(':');
        const tag = colonIdx >= 0 ? image.slice(colonIdx + 1) : 'latest';
        // Strip the last path segment (component name) to get the registry prefix
        // e.g. "ghcr.io/erkkaha/percussionist/operator" → "ghcr.io/erkkaha/percussionist"
        const imageWithoutTag = colonIdx >= 0 ? image.slice(0, colonIdx) : image;
        const slashIdx = imageWithoutTag.lastIndexOf('/');
        const registryPrefix = slashIdx >= 0 ? imageWithoutTag.slice(0, slashIdx) : imageWithoutTag;
        results[name] = { image, tag, registryPrefix };
      } catch {
        // Deployment not found or inaccessible — skip
      }
    }),
  );
  return results;
}

/**
 * Read the DISPATCHER_IMAGE env var from the operator Deployment's pod template.
 * Returns the parsed image info, or null if the deployment or env var is not found.
 */
export async function getDispatcherImageFromOperatorDeployment(
  namespace: string,
): Promise<DeploymentImageInfo | null> {
  try {
    const res = await apps().readNamespacedDeployment({
      name: 'percussionist-operator',
      namespace,
    });
    const env = res.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const dispatcherEnv = env.find((e) => e.name === 'DISPATCHER_IMAGE');
    const image = dispatcherEnv?.value ?? '';
    if (!image) return null;
    const colonIdx = image.lastIndexOf(':');
    const tag = colonIdx >= 0 ? image.slice(colonIdx + 1) : 'latest';
    const imageWithoutTag = colonIdx >= 0 ? image.slice(0, colonIdx) : image;
    const slashIdx = imageWithoutTag.lastIndexOf('/');
    const registryPrefix = slashIdx >= 0 ? imageWithoutTag.slice(0, slashIdx) : imageWithoutTag;
    return { image, tag, registryPrefix };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal token helpers

function readServiceAccountToken(): string | undefined {
  try {
    return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readKubeconfigToken(): string | undefined {
  try {
    const kc = kubeConfig();
    const currentContext = kc.getCurrentContext();
    if (!currentContext) return undefined;
    const user = kc.getUser(currentContext);
    return (user as unknown as Record<string, string>)?.token;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Auth validation — detect when a model requires authentication
// but no auth is configured on the project/run.
// ---------------------------------------------------------------------------

// Known cloud providers that always require API key or OAuth authentication.
const CLOUD_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'google-genai',
  'github-copilot',
  'azure',
  'aws',
  'bedrock',
  'together',
  'groq',
  'mistral',
  'cohere',
  'deepseek',
  'xai',
  'perplexity',
  'fireworks',
]);

// Providers that typically work without authentication (local models).
const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio', 'local']);

export interface AuthValidationSuccess {
  ok: true;
}

export interface AuthValidationFailure {
  ok: false;
  error: string;
}

export type AuthValidationResult = AuthValidationSuccess | AuthValidationFailure;

/**
 * Check whether a model string references a provider that requires
 * authentication.  Returns true for known cloud providers where the
 * model name starts with a recognized cloud prefix.
 */
export function requiresCloudAuth(model: string): boolean {
  const slashIdx = model.indexOf('/');
  if (slashIdx === -1) return false;
  const provider = model.slice(0, slashIdx).toLowerCase();
  return CLOUD_PROVIDERS.has(provider);
}

/**
 * Parse the provider prefix from a `providerID/modelID` model string.
 */
export function parseModelProvider(model: string): string | undefined {
  const slashIdx = model.indexOf('/');
  if (slashIdx === -1) return undefined;
  return model.slice(0, slashIdx);
}

/**
 * Validate that a resolved model has the necessary authentication configured.
 *
 * Returns `{ ok: true }` when:
 *   - no model is set (opencode will use its own default)
 *   - the model's provider is a local provider (ollama, lm-studio, local)
 *   - the provider prefix is unrecognised (don't block unknown providers)
 *   - the model's provider is a cloud provider AND auth secrets are present
 *
 * Returns `{ ok: false, error }` when:
 *   - the model uses a known cloud provider AND neither authSecret nor
 *     llmKeysSecret is configured
 */
export function validateModelAuth(
  model: string | undefined,
  secrets?: { authSecret?: unknown; llmKeysSecret?: string } | null,
): AuthValidationResult {
  if (!model) return { ok: true };

  const provider = parseModelProvider(model);
  if (!provider) return { ok: true };

  const lowerProvider = provider.toLowerCase();
  if (LOCAL_PROVIDERS.has(lowerProvider)) return { ok: true };
  if (!CLOUD_PROVIDERS.has(lowerProvider)) return { ok: true };

  if (secrets?.authSecret || secrets?.llmKeysSecret) return { ok: true };

  return {
    ok: false,
    error:
      `Model "${model}" uses provider "${provider}" which requires authentication, ` +
      `but neither spec.secrets.authSecret nor spec.secrets.llmKeysSecret is configured. ` +
      `Run \`beatctl auth import\` to import opencode auth, or set llmKeysSecret to a Secret ` +
      `containing the provider's API key (e.g. ANTHROPIC_API_KEY).`,
  };
}
