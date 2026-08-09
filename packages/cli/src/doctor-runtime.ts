// doctor-runtime.ts — `beatctl doctor` runtime checks: credentials, providers,
// models.
//
// Unlike the static checks in doctor-static.ts (CRDs, RBAC, NetworkPolicy,
// DNS, storage), these three audit the control plane's *live* auth surface:
//   - credentials — required/optional Secrets present with the keys components
//     expect, plus a best-effort scoped-key inventory from the web API when a
//     CLI session exists (never minting keys).
//   - providers   — provider connectivity, probed through the manager's MCP
//     `list_models` tool (which proxies the opencode sidecar `GET /provider`).
//   - models      — at least one connected provider with ≥1 model, and the
//     effective default model (opencode-config ConfigMap / ClusterSettings /
//     Project specs) resolving to a connected provider.
//
// Each check is a pure function accepting its clients + injectable probes so
// unit tests can stub them (same shape as `checkDns` in doctor-static.ts and
// `auditAgentCapabilities` in validate.ts). Every network call is bounded by
// `withProbeTimeout` or the MCP client's own AbortSignal.timeout.

import type { V1ConfigMap, V1Secret } from '@kubernetes/client-node';
import {
  API_GROUP,
  API_VERSION,
  CLAUDE_ENGINE_PROVIDER_ID,
  type ClusterSettings,
  PLURAL_CLUSTER_SETTINGS,
  parseModelRef,
} from '@percussionist/api';
import type { DoctorCheck, DoctorCheckResult } from './doctor.js';
import { withProbeTimeout } from './doctor-util.js';
import type { DoctorClients } from './k8s-clients.js';
import { DEFAULT_NAMESPACE, listAllProjects } from './kube.js';
import { ManagerMcpError, managerMcpRequest } from './manager-mcp.js';
import { readSession, webRequest, withWebApi } from './web-client.js';

// ---------------------------------------------------------------------------
// Shared types for the MCP list_models payload. The manager normalizes the
// opencode `/provider` response to connected providers only (see
// packages/manager-controller/src/agent/tools.ts), so `all` below is already
// the connected subset.
//
//   all:       connected providers with their models
//   default:   provider → default model map echoed from the sidecar
//   connected: connected provider IDs

export interface ListModelsProvider {
  id: string;
  name?: string;
  models?: Array<{ id: string; name?: string }>;
}

export interface ListModelsResult {
  all: ListModelsProvider[];
  default: Record<string, string>;
  connected: string[];
}

const MCP_LIST_MODELS = 'list_models';

async function defaultListModels(namespace: string, timeoutMs: number): Promise<ListModelsResult> {
  return managerMcpRequest<ListModelsResult>(namespace, MCP_LIST_MODELS, {}, { timeoutMs });
}

/** Classify a list_models failure for the report (sidecar vs MCP unreachable). */
function describeListModelsFailure(e: unknown): string {
  if (e instanceof ManagerMcpError) {
    if (e.kind === 'tool-error') {
      return `manager MCP reachable but list_models failed — opencode sidecar not ready: ${e.message}`;
    }
    return `manager MCP unreachable: ${e.message}`;
  }
  return `cannot list providers: ${errorMessage(e)}`;
}

// ---------------------------------------------------------------------------
// credentials — required Secrets present with expected keys; optional Secrets
// warn with a remediation hint; best-effort scoped-key inventory from the web
// API when a CLI session exists.

interface SecretExpectation {
  name: string;
  keys: string[];
}

const REQUIRED_SECRETS: SecretExpectation[] = [
  { name: 'operator-api-key', keys: ['token'] },
  { name: 'manager-api-key', keys: ['token'] },
  { name: 'manager-mcp-token', keys: ['token'] },
  {
    name: 'web-auth',
    keys: [
      'token',
      'session-secret',
      'github-client-id',
      'github-client-secret',
      'github-allowed-logins',
    ],
  },
];

const OPTIONAL_SECRETS: SecretExpectation[] = [
  { name: 'opencode-auth', keys: ['auth.json'] },
  { name: 'llm-keys', keys: [] },
];

export interface CredentialsCheckOptions {
  namespace: string;
  timeoutMs: number;
  /** Injectable session reader (default: CLI session file). */
  readSession?: () => { token: string } | null;
  /**
   * Injectable agent-keys inventory query. Default: `GET /api/internal/agent-keys`
   * through withWebApi when a session exists. Returns the key count.
   */
  queryAgentKeys?: (namespace: string, timeoutMs: number) => Promise<number>;
}

export async function checkCredentials(
  clients: DoctorClients,
  opts: CredentialsCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs } = opts;
  const readSessionFn = opts.readSession ?? readSession;
  const queryAgentKeys = opts.queryAgentKeys ?? defaultQueryAgentKeys;

  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // 1. Required secrets: present + expected keys.
  for (const expectation of REQUIRED_SECRETS) {
    let secret: V1Secret;
    try {
      secret = await withProbeTimeout(
        clients.core.readNamespacedSecret({ name: expectation.name, namespace }),
        timeoutMs,
        `read secret ${expectation.name}`,
      );
    } catch (e) {
      problems.push(`Secret ${namespace}/${expectation.name} missing: ${errorMessage(e)}`);
      continue;
    }
    const missingKeys = secretHasKeys(secret, expectation.keys);
    if (missingKeys.length > 0) {
      problems.push(
        `Secret ${namespace}/${expectation.name} missing key(s): ${missingKeys.join(', ')}`,
      );
    }
  }

  // 2. Optional secrets: absent → warning with remediation.
  for (const expectation of OPTIONAL_SECRETS) {
    try {
      const secret: V1Secret = await withProbeTimeout(
        clients.core.readNamespacedSecret({ name: expectation.name, namespace }),
        timeoutMs,
        `read secret ${expectation.name}`,
      );
      const missingKeys = secretHasKeys(secret, expectation.keys);
      if (missingKeys.length > 0) {
        warnings.push(
          `Secret ${namespace}/${expectation.name} missing key(s): ${missingKeys.join(', ')}`,
        );
      }
    } catch {
      if (expectation.name === 'opencode-auth') {
        warnings.push(
          'no opencode-auth Secret — provider credentials not imported; run `beatctl auth import` after `opencode auth login`',
        );
      } else {
        warnings.push(
          'no llm-keys Secret — provider API keys not configured (fine when using subscription auth via opencode-auth)',
        );
      }
    }
  }

  // 3. Best-effort scoped-key inventory from the web API. Never mints keys.
  if (!readSessionFn()) {
    warnings.push('run `beatctl auth login` to verify agent keys (scoped-key inventory skipped)');
  } else {
    try {
      const count = await queryAgentKeys(namespace, timeoutMs);
      notes.push(`${count} scoped agent key(s) verified via web /api/internal/agent-keys`);
    } catch (e) {
      warnings.push(
        `agent-keys inventory failed (${errorMessage(e)}); run \`beatctl auth login\` to verify agent keys`,
      );
    }
  }

  const detail = [...problems, ...warnings, ...notes].join('; ');
  if (problems.length > 0) {
    return {
      status: 'fail',
      message: `${problems.length} credential problem(s)`,
      detail,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: 'required Secrets present; warnings',
      detail,
    };
  }
  return {
    status: 'pass',
    message: 'required Secrets present with expected keys',
    ...(detail.length > 0 ? { detail } : {}),
  };
}

function secretHasKeys(secret: V1Secret, keys: string[]): string[] {
  const present = new Set<string>([
    ...Object.keys(secret.data ?? {}),
    ...Object.keys(secret.stringData ?? {}),
  ]);
  return keys.filter((key) => !present.has(key));
}

async function defaultQueryAgentKeys(namespace: string, timeoutMs: number): Promise<number> {
  return withWebApi(namespace, async (baseUrl) => {
    const body = await webRequest<{ items: unknown[] }>(baseUrl, '/api/internal/agent-keys', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (body.items ?? []).length;
  });
}

// ---------------------------------------------------------------------------
// providers — provider authentication via manager MCP list_models. Zero
// connected providers with credentials configured is an error; in dev mode
// (AUTH_DISABLED=1, web-auth Secret `disabled: "1"`) that downgrades to a
// warning.

export interface ProvidersCheckOptions {
  namespace: string;
  timeoutMs: number;
  /** Injectable list_models client (default: managerMcpRequest). */
  requestListModels?: (namespace: string, timeoutMs: number) => Promise<ListModelsResult>;
  /** Injectable dev-mode detector (default: web-auth `disabled` key === "1"). */
  isAuthDisabled?: () => Promise<boolean>;
  /**
   * Injectable provider-credential detector (default: opencode-auth / llm-keys
   * Secrets present).
   */
  credentialsConfigured?: () => Promise<boolean>;
}

export async function checkProviders(
  clients: DoctorClients,
  opts: ProvidersCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs } = opts;
  const requestListModels = opts.requestListModels ?? defaultListModels;
  const isAuthDisabled =
    opts.isAuthDisabled ?? (() => detectAuthDisabled(clients, namespace, timeoutMs));
  const credentialsConfigured =
    opts.credentialsConfigured ?? (() => detectProviderCredentials(clients, namespace, timeoutMs));

  let result: ListModelsResult;
  try {
    result = await requestListModels(namespace, timeoutMs);
  } catch (e) {
    return { status: 'fail', message: describeListModelsFailure(e) };
  }

  const connected = result.connected ?? [];
  const connectedNames = (result.all ?? [])
    .filter((p) => connected.includes(p.id))
    .map((p) => p.name ?? p.id);

  if (connected.length === 0) {
    const devMode = await isAuthDisabled();
    const hasCredentials = await credentialsConfigured();
    if (devMode) {
      return {
        status: 'warn',
        message: 'no connected providers (dev mode: AUTH_DISABLED=1)',
        detail:
          'provider auth is not enforced in dev mode; list_models reported zero connected providers',
      };
    }
    if (hasCredentials) {
      return {
        status: 'fail',
        message: 'no connected providers despite credentials configured',
        detail:
          'check provider credentials (opencode-auth / llm-keys) and the opencode sidecar; list_models reported zero connected providers',
      };
    }
    return {
      status: 'warn',
      message: 'no connected providers',
      detail:
        'no provider credentials configured (no opencode-auth / llm-keys Secret) — run `beatctl auth import` to connect providers',
    };
  }

  return {
    status: 'pass',
    message: `${connected.length} connected provider(s): ${connectedNames.join(', ')}`,
  };
}

async function detectAuthDisabled(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const secret: V1Secret = await withProbeTimeout(
      clients.core.readNamespacedSecret({ name: 'web-auth', namespace }),
      timeoutMs,
      'read web-auth secret',
    );
    const raw = secret.data?.disabled ?? secret.stringData?.disabled;
    if (!raw) return false;
    try {
      return atob(raw) === '1';
    } catch {
      return raw === '1';
    }
  } catch {
    return false;
  }
}

async function detectProviderCredentials(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<boolean> {
  for (const name of ['opencode-auth', 'llm-keys']) {
    try {
      await withProbeTimeout(
        clients.core.readNamespacedSecret({ name, namespace }),
        timeoutMs,
        `read secret ${name}`,
      );
      return true;
    } catch {
      // missing (or unreadable) — keep looking / give up
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// models — at least one connected provider exposes ≥1 model, and every
// effective default model reference resolves to a connected provider. The
// provider → model table is printed in `detail` (which also flows into
// `--json`).

export interface DefaultModelRef {
  source: string;
  model: string;
}

export interface ModelsCheckOptions {
  namespace: string;
  timeoutMs: number;
  /** Injectable list_models client (default: managerMcpRequest). */
  requestListModels?: (namespace: string, timeoutMs: number) => Promise<ListModelsResult>;
  /** Injectable default-model gatherer (default: ConfigMap / ClusterSettings / Projects). */
  gatherDefaultModels?: (
    clients: DoctorClients,
    namespace: string,
    timeoutMs: number,
  ) => Promise<DefaultModelRef[]>;
}

export async function checkModels(
  clients: DoctorClients,
  opts: ModelsCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs } = opts;
  const requestListModels = opts.requestListModels ?? defaultListModels;
  const gatherDefaultModels = opts.gatherDefaultModels ?? gatherEffectiveDefaultModels;

  let result: ListModelsResult;
  try {
    result = await requestListModels(namespace, timeoutMs);
  } catch (e) {
    return { status: 'fail', message: describeListModelsFailure(e) };
  }

  const providers = result.all ?? [];
  const modelCount = providers.reduce((n, p) => n + (p.models?.length ?? 0), 0);

  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (providers.length === 0 || modelCount === 0) {
    problems.push('no connected provider exposes any model');
  }

  // Cross-check the effective default model(s) against the connected set.
  let defaultRefs: DefaultModelRef[] = [];
  try {
    defaultRefs = await gatherDefaultModels(clients, namespace, timeoutMs);
  } catch (e) {
    warnings.push(`cannot gather default model references: ${errorMessage(e)}`);
  }

  const connectedSet = new Set(result.connected ?? []);
  for (const ref of defaultRefs) {
    const verdict = resolveDefaultModel(ref, providers, connectedSet);
    if (verdict.status === 'fail') problems.push(verdict.text);
    else if (verdict.status === 'warn') warnings.push(verdict.text);
    else notes.push(verdict.text);
  }
  if (defaultRefs.length === 0) {
    warnings.push(
      'no default model configured (opencode-config / ClusterSettings / Project specs) — cannot cross-check a default',
    );
  }

  const table = formatModelsTable(providers);
  const detailParts: string[] = [];
  if (problems.length > 0) detailParts.push(...problems);
  if (warnings.length > 0) detailParts.push(...warnings);
  if (notes.length > 0) detailParts.push(...notes);
  if (table.length > 0) detailParts.push(`provider → models:\n${table}`);
  const detail = detailParts.join('; ');

  if (problems.length > 0) {
    return {
      status: 'fail',
      message: `${problems.length} model problem(s)`,
      detail,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: `${providers.length} connected provider(s), ${modelCount} model(s); warnings`,
      detail,
    };
  }
  return {
    status: 'pass',
    message: `${providers.length} connected provider(s), ${modelCount} model(s) available`,
    detail,
  };
}

function resolveDefaultModel(
  ref: DefaultModelRef,
  providers: ListModelsProvider[],
  connectedSet: Set<string>,
): { status: 'pass' | 'warn' | 'fail'; text: string } {
  const { providerID, modelID } = parseModelRef(ref.model);

  // The claude-code engine is not an opencode provider, so list_models can
  // never see it — report as informational, not a failure.
  if (providerID === CLAUDE_ENGINE_PROVIDER_ID) {
    return {
      status: 'pass',
      text: `default model ${ref.model} (${ref.source}) selects the claude-code engine — not listed by opencode, cannot cross-check`,
    };
  }

  if (providerID) {
    if (!connectedSet.has(providerID)) {
      return {
        status: 'fail',
        text: `default model ${ref.model} (${ref.source}) references provider "${providerID}" which is not connected`,
      };
    }
    const provider = providers.find((p) => p.id === providerID);
    const listed = (provider?.models ?? []).some((m) => m.id === modelID);
    if (!listed) {
      return {
        status: 'warn',
        text: `default model ${ref.model} (${ref.source}) provider "${providerID}" is connected but model "${modelID}" is not in its list`,
      };
    }
    return {
      status: 'pass',
      text: `default model ${ref.model} (${ref.source}) resolves to connected provider "${providerID}"`,
    };
  }

  // Bare model ID — attribute it to connected providers whose model list
  // contains it.
  const matches = providers.filter((p) => (p.models ?? []).some((m) => m.id === modelID));
  if (matches.length === 0) {
    return {
      status: 'warn',
      text: `default model ${ref.model} (${ref.source}) cannot be attributed to any connected provider`,
    };
  }
  return {
    status: 'pass',
    text: `default model ${ref.model} (${ref.source}) resolves to connected provider(s): ${matches.map((p) => p.id).join(', ')}`,
  };
}

async function gatherEffectiveDefaultModels(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<DefaultModelRef[]> {
  const refs: DefaultModelRef[] = [];

  // 1. opencode-config ConfigMap `opencode.json` → top-level `model`.
  for (const ns of [namespace, DEFAULT_NAMESPACE]) {
    try {
      const cm: V1ConfigMap = await withProbeTimeout(
        clients.core.readNamespacedConfigMap({ name: 'opencode-config', namespace: ns }),
        timeoutMs,
        `read opencode-config ${ns}`,
      );
      const raw = cm.data?.['opencode.json'];
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.length > 0) {
        refs.push({ source: `opencode-config ${ns}`, model: parsed.model });
        break; // first config found wins
      }
    } catch {
      // missing / unreadable — try the next namespace
    }
  }

  // 2. ClusterSettings singleton (cluster-scoped "default") → manager.model.
  try {
    const list = (await withProbeTimeout(
      clients.custom.listClusterCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        plural: PLURAL_CLUSTER_SETTINGS,
      }),
      timeoutMs,
      'list ClusterSettings',
    )) as { items?: ClusterSettings[] };
    const items = list.items ?? [];
    const cs = items.find((c) => c.metadata?.name === 'default') ?? items[0];
    const managerModel = cs?.spec?.manager?.model;
    if (typeof managerModel === 'string' && managerModel.length > 0) {
      refs.push({ source: 'ClusterSettings default', model: managerModel });
    }
  } catch {
    // cluster-scoped read may be denied to a scoped kubeconfig — best-effort
  }

  // 3. Per-project defaults.
  try {
    const projects = await withProbeTimeout(
      listAllProjects(clients.custom),
      timeoutMs,
      'list projects',
    );
    for (const project of projects) {
      const model = project.spec?.model;
      if (typeof model === 'string' && model.length > 0) {
        refs.push({
          source: `project ${project.metadata?.name ?? '(unnamed)'}`,
          model,
        });
      }
    }
  } catch {
    // best-effort
  }

  return refs;
}

function formatModelsTable(providers: ListModelsProvider[]): string {
  const lines: string[] = [];
  for (const provider of providers) {
    lines.push(`${provider.name ?? provider.id} (connected)`);
    for (const model of provider.models ?? []) {
      const label = model.name && model.name !== model.id ? ` (${model.name})` : '';
      lines.push(`  - ${model.id}${label}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registry wiring — the three runtime checks, filterable via `--check`.

export const RUNTIME_CHECKS: DoctorCheck[] = [
  {
    name: 'credentials',
    category: 'Credentials',
    run: (ctx) =>
      checkCredentials(ctx.clients, { namespace: ctx.namespace, timeoutMs: ctx.timeoutMs }),
  },
  {
    name: 'providers',
    category: 'Providers',
    run: (ctx) =>
      checkProviders(ctx.clients, {
        namespace: ctx.namespace,
        timeoutMs: ctx.timeoutMs,
      }),
  },
  {
    name: 'models',
    category: 'Models',
    run: (ctx) =>
      checkModels(ctx.clients, {
        namespace: ctx.namespace,
        timeoutMs: ctx.timeoutMs,
      }),
  },
];

function errorMessage(e: unknown): string {
  return ((e as { message?: string }).message ?? String(e)).trim();
}
