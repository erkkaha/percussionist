// doctor-platform.ts — `beatctl doctor` platform checks: dashboard + health.
//
// These two audit the live control plane's dashboard surface and component
// health:
//   - dashboard — the web Deployment's WEB_BASE_URL env must match the Ingress
//     `percussionist-web` host (scheme + host) rather than the
//     http://localhost:8080 port-forward fallback; the GitHub App client id
//     must be configured (else no sign-in is possible); the AUTH_DISABLED
//     state is surfaced; and web /api/health must answer ok:true with the
//     expected namespace.
//   - health — the control-plane Deployments (percussionist-operator,
//     percussionist-manager, percussionist-web) must have
//     availableReplicas >= 1 with ready pods; `ollama` is healthy iff any
//     Project enables spec.embedding (per the vector memory service docs);
//     the manager MCP answers a JSON-RPC `tools/list` probe (via the shared
//     port-forward helper in manager-mcp.ts); and web /api/health is
//     reachable.
//
// Pure functions with injectable clients/probes (same shape as the other
// check modules) so unit tests can stub the API surface. Every network call
// is bounded (withProbeTimeout / AbortSignal.timeout).

import type { V1Deployment, V1Ingress, V1Secret } from '@kubernetes/client-node';
import type { Project } from '@percussionist/api';
import type { DoctorCheck, DoctorCheckResult } from './doctor.js';
import { withProbeTimeout } from './doctor-util.js';
import type { DoctorClients } from './k8s-clients.js';
import { listAllProjects } from './kube.js';
import { ManagerMcpError, type McpToolDescriptor, managerMcpListTools } from './manager-mcp.js';
import { webRequest, withWebApi } from './web-client.js';

// ---------------------------------------------------------------------------
// Shared types

/** Shape of the public web `/api/health` endpoint (see packages/web/src/server/app.ts). */
export interface WebHealthResponse {
  ok?: boolean;
  namespace?: string;
  authDisabled?: boolean;
}

/** Injectable web API accessor (default: `withWebApi` from web-client.ts). */
export type WebApiAccessor = <T>(
  namespace: string | undefined,
  fn: (baseUrl: string) => Promise<T>,
) => Promise<T>;

/** Injectable web request helper (default: `webRequest` from web-client.ts). */
export type WebRequestFn = <T>(baseUrl: string, path_: string, init?: RequestInit) => Promise<T>;

const WEB_DEPLOYMENT = 'percussionist-web';
const WEB_INGRESS = 'percussionist-web';
const WEB_BASE_URL_ENV = 'WEB_BASE_URL';
const WEB_AUTH_SECRET = 'web-auth';

// ---------------------------------------------------------------------------
// dashboard — WEB_BASE_URL matches the Ingress host; GitHub App client id
// configured; AUTH_DISABLED surfaced; web /api/health answers ok:true with
// the expected namespace.

export interface DashboardCheckOptions {
  namespace: string;
  timeoutMs: number;
  /** Injectable web API accessor (default: withWebApi). */
  withWebApi?: WebApiAccessor;
  /** Injectable web request helper (default: webRequest). */
  webRequest?: WebRequestFn;
}

export async function checkDashboard(
  clients: DoctorClients,
  opts: DashboardCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs } = opts;
  const withWebApiFn = opts.withWebApi ?? withWebApi;
  const webRequestFn = opts.webRequest ?? webRequest;

  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // 1. Web Deployment + WEB_BASE_URL env.
  let deployment: V1Deployment;
  try {
    deployment = await withProbeTimeout(
      clients.apps.readNamespacedDeployment({ name: WEB_DEPLOYMENT, namespace }),
      timeoutMs,
      `read deployment ${WEB_DEPLOYMENT}`,
    );
  } catch (e) {
    return {
      status: 'fail',
      message: `web Deployment ${namespace}/${WEB_DEPLOYMENT} unreadable`,
      detail: errorMessage(e),
    };
  }
  const webBaseUrl =
    deployment.spec?.template?.spec?.containers?.[0]?.env?.find(
      (entry) => entry.name === WEB_BASE_URL_ENV,
    )?.value ?? '';

  // 2. Ingress host (best-effort — the public origin WEB_BASE_URL must match).
  let ingressHost: string | undefined;
  let ingressHttps = false;
  try {
    const ingress: V1Ingress = await withProbeTimeout(
      clients.networking.readNamespacedIngress({ name: WEB_INGRESS, namespace }),
      timeoutMs,
      `read ingress ${WEB_INGRESS}`,
    );
    ingressHost = ingress.spec?.rules?.[0]?.host;
    const tlsHosts = new Set((ingress.spec?.tls ?? []).flatMap((t) => t.hosts ?? []));
    ingressHttps = ingressHost !== undefined && tlsHosts.has(ingressHost);
  } catch (e) {
    warnings.push(
      `Ingress ${namespace}/${WEB_INGRESS} unreadable: ${errorMessage(e)} — cannot verify WEB_BASE_URL against a public host (dashboard reachable only via port-forward)`,
    );
  }

  if (webBaseUrl.length === 0) {
    problems.push(
      `web Deployment has no ${WEB_BASE_URL_ENV} env — defaults to http://localhost:8080 (GitHub OAuth callback and session cookies break outside port-forward)`,
    );
  } else {
    const origin = parseOrigin(webBaseUrl);
    if (!origin) {
      problems.push(`${WEB_BASE_URL_ENV} "${webBaseUrl}" is not a valid absolute URL`);
    } else if (isLoopbackHost(origin.hostname)) {
      problems.push(
        `${WEB_BASE_URL_ENV} "${webBaseUrl}" is the localhost port-forward fallback — set it to the public dashboard URL matching the Ingress host`,
      );
    } else if (ingressHost) {
      if (origin.hostname !== ingressHost) {
        problems.push(
          `${WEB_BASE_URL_ENV} host "${origin.hostname}" does not match Ingress host "${ingressHost}" — GitHub OAuth callback and session cookies will break`,
        );
      } else {
        const ingressScheme = ingressHttps ? 'https' : 'http';
        if (origin.scheme !== ingressScheme) {
          warnings.push(
            `${WEB_BASE_URL_ENV} scheme "${origin.scheme}" differs from the Ingress "${ingressScheme}" — browsers may reject cookies / the OAuth redirect`,
          );
        } else {
          notes.push(
            `${WEB_BASE_URL_ENV} ${webBaseUrl} matches Ingress host ${ingressHost} (${ingressScheme})`,
          );
        }
        if (origin.port && !webBaseUrlHasDefaultPort(webBaseUrl, ingressScheme)) {
          warnings.push(
            `${WEB_BASE_URL_ENV} includes an explicit port (${origin.port}) not present in the Ingress host — check the GitHub App callback URL matches host AND port`,
          );
        }
      }
    }
  }

  // 3. web-auth Secret: GitHub App client id + desired AUTH_DISABLED state.
  let githubClientId: string | undefined;
  let authDisabledDesired = false;
  try {
    const secret: V1Secret = await withProbeTimeout(
      clients.core.readNamespacedSecret({ name: WEB_AUTH_SECRET, namespace }),
      timeoutMs,
      `read secret ${WEB_AUTH_SECRET}`,
    );
    githubClientId = secretValue(secret, 'github-client-id');
    authDisabledDesired = secretValue(secret, 'disabled') === '1';
  } catch (e) {
    warnings.push(`cannot read Secret ${namespace}/${WEB_AUTH_SECRET}: ${errorMessage(e)}`);
  }

  // 4. web /api/health — reachable, ok:true, expected namespace, authDisabled.
  let health: WebHealthResponse | undefined;
  try {
    health = await withProbeTimeout(
      withWebApiFn(namespace, (baseUrl) =>
        webRequestFn<WebHealthResponse>(baseUrl, '/api/health', {
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ),
      timeoutMs,
      'web /api/health probe',
    );
  } catch (e) {
    problems.push(`web /api/health unreachable: ${errorMessage(e)}`);
  }
  const healthAuthDisabled = health?.authDisabled === true;
  if (health) {
    if (health.ok !== true) {
      problems.push('web /api/health did not return ok:true');
    }
    if (typeof health.namespace === 'string' && health.namespace !== namespace) {
      problems.push(
        `web /api/health reports namespace "${health.namespace}" but the inspected namespace is "${namespace}" — the dashboard is serving a different namespace than this doctor run`,
      );
    }
    if (healthAuthDisabled) {
      notes.push('AUTH_DISABLED=1 (dev mode) — sign-in bypassed');
    } else {
      notes.push('auth enabled (AUTH_DISABLED unset) — GitHub sign-in enforced');
    }
    if (authDisabledDesired !== healthAuthDisabled) {
      warnings.push(
        `AUTH_DISABLED state mismatch: web-auth Secret disabled=${authDisabledDesired ? '1' : 'unset'} but /api/health reports authDisabled=${String(healthAuthDisabled)} — the web pod may run a stale config`,
      );
    }
  }

  // 5. GitHub App client id — required for sign-in unless auth is disabled.
  const authDisabled = healthAuthDisabled || authDisabledDesired;
  if (!githubClientId || githubClientId.length === 0) {
    if (authDisabled) {
      notes.push('GitHub App client id not configured (acceptable in dev mode: AUTH_DISABLED=1)');
    } else {
      warnings.push(
        `no GitHub App client id (Secret ${namespace}/${WEB_AUTH_SECRET} key github-client-id) — no sign-in possible`,
      );
    }
  } else {
    notes.push('GitHub App client id configured');
  }

  const detail = [...problems, ...warnings, ...notes].join('; ');
  if (problems.length > 0) {
    return {
      status: 'fail',
      message: `${problems.length} dashboard problem(s)`,
      detail,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: 'dashboard configured with warnings',
      detail,
    };
  }
  return {
    status: 'pass',
    message: 'WEB_BASE_URL matches the Ingress; auth surface healthy',
    detail,
  };
}

// ---------------------------------------------------------------------------
// health — control-plane Deployments ready; ollama healthy iff any Project
// enables spec.embedding; manager MCP answers tools/list; web /api/health
// reachable.

export interface HealthCheckOptions {
  namespace: string;
  timeoutMs: number;
  /** Injectable manager MCP tools/list probe (default: managerMcpListTools). */
  probeMcpTools?: (namespace: string, timeoutMs: number) => Promise<McpToolDescriptor[]>;
  /** Injectable web API accessor (default: withWebApi). */
  withWebApi?: WebApiAccessor;
  /** Injectable web request helper (default: webRequest). */
  webRequest?: WebRequestFn;
}

const CONTROL_PLANE_DEPLOYMENTS = [
  'percussionist-operator',
  'percussionist-manager',
  'percussionist-web',
] as const;

const OLLAMA_DEPLOYMENT = 'ollama';

export async function checkHealth(
  clients: DoctorClients,
  opts: HealthCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs } = opts;
  const probeMcpTools = opts.probeMcpTools ?? defaultProbeMcpTools;
  const withWebApiFn = opts.withWebApi ?? withWebApi;
  const webRequestFn = opts.webRequest ?? webRequest;

  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // 1. Control-plane Deployments: availableReplicas >= 1 with ready pods.
  for (const name of CONTROL_PLANE_DEPLOYMENTS) {
    let deployment: V1Deployment;
    try {
      deployment = await withProbeTimeout(
        clients.apps.readNamespacedDeployment({ name, namespace }),
        timeoutMs,
        `read deployment ${name}`,
      );
    } catch (e) {
      problems.push(`Deployment ${namespace}/${name} missing or unreadable: ${errorMessage(e)}`);
      continue;
    }
    const available = (deployment.status?.availableReplicas ?? 0) >= 1;
    const ready = (deployment.status?.readyReplicas ?? 0) >= 1;
    if (!available || !ready) {
      problems.push(
        `Deployment ${namespace}/${name} not healthy (availableReplicas=${deployment.status?.availableReplicas ?? 0}, readyReplicas=${deployment.status?.readyReplicas ?? 0})`,
      );
    } else {
      notes.push(`${name}: ${deployment.status?.readyReplicas ?? 0} ready replica(s)`);
    }
  }

  // 2. ollama — required and healthy iff any Project enables spec.embedding.
  let projectsListed = true;
  let projects: Project[] = [];
  try {
    projects = await withProbeTimeout(listAllProjects(clients.custom), timeoutMs, 'list projects');
  } catch (e) {
    projectsListed = false;
    problems.push(
      `cannot list Projects (needed to determine the ollama requirement): ${errorMessage(e)}`,
    );
  }
  if (projectsListed) {
    const embeddingEnabled = projects.some((p) => p.spec?.embedding?.enabled === true);
    let ollamaDeployment: V1Deployment | undefined;
    try {
      ollamaDeployment = await withProbeTimeout(
        clients.apps.readNamespacedDeployment({ name: OLLAMA_DEPLOYMENT, namespace }),
        timeoutMs,
        `read deployment ${OLLAMA_DEPLOYMENT}`,
      );
    } catch {
      ollamaDeployment = undefined; // not deployed
    }
    if (embeddingEnabled) {
      if (!ollamaDeployment) {
        problems.push(
          `Project(s) enable spec.embedding but ${namespace}/${OLLAMA_DEPLOYMENT} is not deployed — the memory service cannot generate embeddings`,
        );
      } else if ((ollamaDeployment.status?.availableReplicas ?? 0) < 1) {
        problems.push(
          `Deployment ${namespace}/${OLLAMA_DEPLOYMENT} not healthy while Projects enable spec.embedding (availableReplicas=${ollamaDeployment.status?.availableReplicas ?? 0})`,
        );
      } else {
        notes.push('ollama healthy (required by Projects with spec.embedding enabled)');
      }
    } else if (ollamaDeployment) {
      notes.push('ollama deployed but no Project enables spec.embedding — optional, unused');
    } else {
      notes.push('no Project enables spec.embedding; ollama not required');
    }
  }

  // 3. Manager MCP answers a JSON-RPC tools/list probe.
  try {
    const tools = await probeMcpTools(namespace, timeoutMs);
    if (tools.length === 0) {
      warnings.push('manager MCP answered tools/list but exposed no tools');
    } else {
      notes.push(`manager MCP answered tools/list (${tools.length} tool(s))`);
    }
  } catch (e) {
    problems.push(
      `manager MCP tools/list probe failed: ${
        e instanceof ManagerMcpError ? e.message : errorMessage(e)
      }`,
    );
  }

  // 4. web /api/health reachable.
  try {
    const health = await withProbeTimeout(
      withWebApiFn(namespace, (baseUrl) =>
        webRequestFn<WebHealthResponse>(baseUrl, '/api/health', {
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ),
      timeoutMs,
      'web /api/health probe',
    );
    if (health.ok !== true) {
      problems.push('web /api/health reachable but did not return ok:true');
    } else {
      notes.push('web /api/health reachable');
    }
  } catch (e) {
    problems.push(`web /api/health unreachable: ${errorMessage(e)}`);
  }

  const detail = [...problems, ...warnings, ...notes].join('; ');
  if (problems.length > 0) {
    return {
      status: 'fail',
      message: `${problems.length} component health problem(s)`,
      detail,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: 'control plane healthy with warnings',
      detail,
    };
  }
  return {
    status: 'pass',
    message: 'control-plane Deployments ready; MCP and web health probes pass',
    detail,
  };
}

async function defaultProbeMcpTools(
  namespace: string,
  timeoutMs: number,
): Promise<McpToolDescriptor[]> {
  return managerMcpListTools(namespace, { timeoutMs });
}

// ---------------------------------------------------------------------------
// Registry wiring — the two platform checks, filterable via `--check`.

export const PLATFORM_CHECKS: DoctorCheck[] = [
  {
    name: 'dashboard',
    category: 'Dashboard',
    run: (ctx) =>
      checkDashboard(ctx.clients, {
        namespace: ctx.namespace,
        timeoutMs: ctx.timeoutMs,
      }),
  },
  {
    name: 'health',
    category: 'Health',
    run: (ctx) =>
      checkHealth(ctx.clients, {
        namespace: ctx.namespace,
        timeoutMs: ctx.timeoutMs,
      }),
  },
];

// ---------------------------------------------------------------------------
// Helpers

/** Extract `scheme://host[:port]` from an absolute URL, or undefined. */
function parseOrigin(url: string): { scheme: string; hostname: string; port: string } | undefined {
  try {
    const u = new URL(url);
    return { scheme: u.protocol.replace(/:$/, ''), hostname: u.hostname, port: u.port };
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** True when the URL's port is the well-known default for its scheme. */
function webBaseUrlHasDefaultPort(url: string, scheme: string): boolean {
  try {
    const u = new URL(url);
    if (u.port.length === 0) return true;
    return scheme === 'https' ? u.port === '443' : u.port === '80';
  } catch {
    return true;
  }
}

/** Read a Secret key, base64-decoding `data` and passing `stringData` through. */
function secretValue(secret: V1Secret, key: string): string | undefined {
  const raw = secret.data?.[key] ?? secret.stringData?.[key];
  if (raw === undefined) return undefined;
  try {
    return atob(raw);
  } catch {
    return raw;
  }
}

function errorMessage(e: unknown): string {
  return ((e as { message?: string }).message ?? String(e)).trim();
}
