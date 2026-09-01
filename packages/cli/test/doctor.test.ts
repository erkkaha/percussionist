// doctor.test.ts — deterministic unit tests for `beatctl doctor` report logic.
//
// Mirrors the validate.test.ts house pattern: the check functions in
// doctor-static.ts / doctor-runtime.ts / doctor-platform.ts are pure and accept
// their API clients + probes as parameters, so every pass/warn/fail path can be
// exercised with stubbed clients and injected probes — no cluster required.
//
// The suite is split in two:
//   1. Per-check tests — each of the 10 check functions (crds, rbac,
//      network-policy, dns, storage, credentials, providers, models, dashboard,
//      health) is driven directly with stubbed API clients and injected probes
//      to pin the pass/warn/fail mapping, including the documented edge cases
//      (unknown CNI → warning, Pending PVC → warning, Lost/Failed → error,
//      missing optional secrets → warning, dev-mode providers → warning,
//      `--probe-dns` exec failure → warning).
//   2. Orchestrator tests — `runDoctor` is exercised with an injected check
//      registry (real check functions wired to stub clients/probes, plus plain
//      stub checks) to pin the summary formatting, `--json` report shape,
//      exit-code semantics (0 all pass, 1 any fail, 2 fatal) and `--check`
//      category filtering.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { DoctorCheck, DoctorCheckResult, DoctorJsonReport } from '../src/doctor.js';
import { DoctorExitCode, runDoctor } from '../src/doctor.js';
import { checkDashboard, checkHealth } from '../src/doctor-platform.js';
import {
  checkCredentials,
  checkModels,
  checkProviders,
  type ListModelsResult,
} from '../src/doctor-runtime.js';
import {
  checkCrds,
  checkDns,
  checkNetworkPolicy,
  checkRbac,
  checkStorage,
} from '../src/doctor-static.js';
import type { DoctorClients } from '../src/k8s-clients.js';
import { ManagerMcpError } from '../src/manager-mcp.js';

// ---------------------------------------------------------------------------
// Shared fixtures

const NS = 'percussionist';

type StubMethod = (...args: unknown[]) => unknown;

interface StubClient {
  [method: string]: StubMethod;
}

/** Build a DoctorClients-shaped stub; only the given methods are callable. */
function makeClients(
  overrides: {
    core?: StubClient;
    apps?: StubClient;
    custom?: StubClient;
    apiextensions?: StubClient;
    rbac?: StubClient;
    networking?: StubClient;
    storage?: StubClient;
  } = {},
): DoctorClients {
  const empty: StubClient = {};
  return {
    core: (overrides.core ?? empty) as unknown as DoctorClients['core'],
    apps: (overrides.apps ?? empty) as unknown as DoctorClients['apps'],
    custom: (overrides.custom ?? empty) as unknown as DoctorClients['custom'],
    apiextensions: (overrides.apiextensions ?? empty) as unknown as DoctorClients['apiextensions'],
    rbac: (overrides.rbac ?? empty) as unknown as DoctorClients['rbac'],
    networking: (overrides.networking ?? empty) as unknown as DoctorClients['networking'],
    storage: (overrides.storage ?? empty) as unknown as DoctorClients['storage'],
  };
}

const CRD_NAMES = [
  'runs.percussionist.dev',
  'projects.percussionist.dev',
  'tasks.percussionist.dev',
  'clusteragents.percussionist.dev',
  'clustersettings.percussionist.dev',
];

function crd(
  name: string,
  established = true,
): {
  metadata: { name: string };
  status: { conditions: Array<{ type: string; status: string }> };
} {
  return {
    metadata: { name },
    status: { conditions: established ? [{ type: 'Established', status: 'True' }] : [] },
  };
}

const SA_NAMES = [
  'percussionist-operator',
  'percussionist-dispatcher',
  'percussionist-manager',
  'percussionist-web',
];

const CLUSTER_ROLE_NAMES = [
  'percussionist-operator',
  'percussionist-dispatcher',
  'percussionist-manager',
  'percussionist-web-clusteragents',
  'percussionist-web-nodemetrics',
];

const ROLE_NAMES = ['percussionist-dispatcher', 'percussionist-web'];

function clusterRoleBinding(
  name: string,
  role: string,
  sa: string,
  subjectNamespace = NS,
): Record<string, unknown> {
  return {
    metadata: { name },
    roleRef: { kind: 'ClusterRole', name: role },
    subjects: [{ kind: 'ServiceAccount', name: sa, namespace: subjectNamespace }],
  };
}

function roleBinding(name: string, role: string, sa: string): Record<string, unknown> {
  return {
    metadata: { name },
    roleRef: { kind: 'Role', name: role },
    subjects: [{ kind: 'ServiceAccount', name: sa, namespace: NS }],
  };
}

/** A fully-wired healthy RBAC surface. */
function healthyRbac(overrides: Record<string, unknown> = {}): StubClient {
  return {
    listClusterRole: async () => ({
      items: CLUSTER_ROLE_NAMES.map((name) => ({ metadata: { name } })),
    }),
    listNamespacedRole: async () => ({ items: ROLE_NAMES.map((name) => ({ metadata: { name } })) }),
    listClusterRoleBinding: async () => ({
      items: [
        clusterRoleBinding(
          'percussionist-operator',
          'percussionist-operator',
          'percussionist-operator',
        ),
        clusterRoleBinding(
          'percussionist-dispatcher',
          'percussionist-dispatcher',
          'percussionist-dispatcher',
        ),
        clusterRoleBinding(
          'percussionist-manager',
          'percussionist-manager',
          'percussionist-manager',
        ),
        clusterRoleBinding(
          'percussionist-web-clusteragents',
          'percussionist-web-clusteragents',
          'percussionist-web',
        ),
        clusterRoleBinding(
          'percussionist-web-nodemetrics',
          'percussionist-web-nodemetrics',
          'percussionist-web',
        ),
      ],
    }),
    listNamespacedRoleBinding: async () => ({
      items: [
        roleBinding(
          'percussionist-dispatcher',
          'percussionist-dispatcher',
          'percussionist-dispatcher',
        ),
        roleBinding('percussionist-web', 'percussionist-web', 'percussionist-web'),
      ],
    }),
    ...overrides,
  };
}

const WEB_HOST = 'app.192.168.49.2.nip.io';

function secretDataFor(name: string): Record<string, string> {
  switch (name) {
    case 'operator-api-key':
    case 'manager-api-key':
    case 'manager-mcp-token':
      return { token: btoa('secret') };
    case 'web-auth':
      return {
        token: btoa('secret'),
        'session-secret': btoa('secret'),
        'github-client-id': btoa('app-id'),
        'github-client-secret': btoa('app-secret'),
        'github-allowed-logins': btoa('alice'),
      };
    case 'opencode-auth':
      return { 'auth.json': btoa('{}') };
    case 'llm-keys':
      return {};
    default:
      return {};
  }
}

/**
 * Deployment read for the healthy fixture: coredns Available, control-plane
 * deployments healthy with DEFAULT_STORAGE_CLASS=standard, ollama not deployed.
 */
function deploymentFor(name: string): Record<string, unknown> {
  if (name === 'coredns') {
    return {
      metadata: { name },
      status: {
        conditions: [{ type: 'Available', status: 'True' }],
        readyReplicas: 2,
        availableReplicas: 2,
      },
    };
  }
  if (name === 'ollama') {
    throw new Error('not deployed');
  }
  const env = [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }];
  if (name === 'percussionist-web') {
    env.push({ name: 'WEB_BASE_URL', value: `http://${WEB_HOST}` });
  }
  return {
    metadata: { name },
    status: { availableReplicas: 1, readyReplicas: 1 },
    spec: { template: { spec: { containers: [{ env }] } } },
  };
}

/** Stub clients where every doctor check passes. */
function healthyClients(): DoctorClients {
  return makeClients({
    apiextensions: {
      listCustomResourceDefinition: async () => ({ items: CRD_NAMES.map((name) => crd(name)) }),
    },
    core: {
      listNamespacedServiceAccount: async () => ({
        items: SA_NAMES.map((name) => ({ metadata: { name } })),
      }),
      readNamespacedService: async ({ name }) => ({ metadata: { name } }),
      readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      readNamespacedPersistentVolumeClaim: async ({ name }) => ({
        metadata: { name },
        status: { phase: 'Bound' },
      }),
      readNamespacedSecret: async ({ name }) => ({ metadata: { name }, data: secretDataFor(name) }),
      readNamespacedConfigMap: async () => ({ metadata: { name: 'opencode-config' }, data: {} }),
    },
    apps: {
      listNamespacedDaemonSet: async () => ({ items: [{ metadata: { name: 'calico-node' } }] }),
      readNamespacedDeployment: async ({ name }) => deploymentFor(name as string),
    },
    custom: {
      listClusterCustomObject: async () => ({ items: [] }),
    },
    networking: {
      listNamespacedNetworkPolicy: async () => ({
        items: [
          { metadata: { name: 'manager-ingress' } },
          { metadata: { name: 'memory-service-ingress' } },
        ],
      }),
      readNamespacedIngress: async () => ({ spec: { rules: [{ host: WEB_HOST }], tls: [] } }),
    },
    rbac: healthyRbac(),
    storage: {
      listStorageClass: async () => ({
        items: [
          {
            metadata: {
              name: 'standard',
              annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
            },
          },
        ],
      }),
    },
  });
}

interface DoctorProbes {
  execProbe: (opts: {
    namespace: string;
    podName: string;
    container: string;
    command: string[];
    timeoutMs: number;
  }) => Promise<{ ok: boolean; output: string }>;
  requestListModels: (namespace: string, timeoutMs: number) => Promise<ListModelsResult>;
  isAuthDisabled: () => Promise<boolean>;
  credentialsConfigured: () => Promise<boolean>;
  gatherDefaultModels: () => Promise<Array<{ source: string; model: string }>>;
  withWebApi: <T>(namespace: string | undefined, fn: (baseUrl: string) => Promise<T>) => Promise<T>;
  webRequest: <T>(baseUrl: string, path: string, init?: RequestInit) => Promise<T>;
  probeMcpTools: (namespace: string, timeoutMs: number) => Promise<Array<{ name: string }>>;
}

const healthyProbes: DoctorProbes = {
  execProbe: async () => ({ ok: true, output: 'has address 10.96.0.1' }),
  requestListModels: async () => ({
    all: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5' }] }],
    default: {},
    connected: ['anthropic'],
  }),
  isAuthDisabled: async () => false,
  credentialsConfigured: async () => true,
  gatherDefaultModels: async () => [
    { source: 'opencode-config default', model: 'anthropic/claude-sonnet-4-5' },
  ],
  withWebApi: async (_namespace, fn) => fn('http://web.test'),
  webRequest: async () => ({ ok: true, namespace: NS, authDisabled: false }),
  probeMcpTools: async () => [{ name: 'list_models' }, { name: 'get_status' }],
};

/**
 * The real 10-check registry (same names/categories as the production
 * DEFAULT_CHECKS) with every probe injected, so `runDoctor` can be driven
 * end-to-end over stub clients.
 */
function doctorRegistry(clients: DoctorClients, probes: DoctorProbes): DoctorCheck[] {
  return [
    { name: 'crds', category: 'CRDs', run: (ctx) => checkCrds(clients, ctx.timeoutMs) },
    {
      name: 'rbac',
      category: 'RBAC',
      run: (ctx) => checkRbac(clients, ctx.namespace, ctx.timeoutMs),
    },
    {
      name: 'network-policy',
      category: 'NetworkPolicy',
      run: (ctx) => checkNetworkPolicy(clients, ctx.namespace, ctx.timeoutMs),
    },
    {
      name: 'dns',
      category: 'DNS',
      run: (ctx) =>
        checkDns(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          probeDns: ctx.probeDns,
          execProbe: probes.execProbe,
        }),
    },
    {
      name: 'storage',
      category: 'Storage',
      run: (ctx) => checkStorage(clients, ctx.namespace, ctx.timeoutMs),
    },
    {
      name: 'credentials',
      category: 'Credentials',
      run: (ctx) =>
        checkCredentials(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          readSession: () => ({ token: 'test-token' }),
          queryAgentKeys: async () => 2,
        }),
    },
    {
      name: 'providers',
      category: 'Providers',
      run: (ctx) =>
        checkProviders(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          requestListModels: probes.requestListModels,
          isAuthDisabled: probes.isAuthDisabled,
          credentialsConfigured: probes.credentialsConfigured,
        }),
    },
    {
      name: 'models',
      category: 'Models',
      run: (ctx) =>
        checkModels(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          requestListModels: probes.requestListModels,
          gatherDefaultModels: probes.gatherDefaultModels,
        }),
    },
    {
      name: 'dashboard',
      category: 'Dashboard',
      run: (ctx) =>
        checkDashboard(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          withWebApi: probes.withWebApi,
          webRequest: probes.webRequest,
        }),
    },
    {
      name: 'health',
      category: 'Health',
      run: (ctx) =>
        checkHealth(clients, {
          namespace: ctx.namespace,
          timeoutMs: ctx.timeoutMs,
          probeMcpTools: probes.probeMcpTools,
          withWebApi: probes.withWebApi,
          webRequest: probes.webRequest,
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// crds

describe('checkCrds', () => {
  it('passes when all 5 percussionist.dev CRDs exist and are Established', async () => {
    const clients = makeClients({
      apiextensions: {
        listCustomResourceDefinition: async () => ({ items: CRD_NAMES.map((name) => crd(name)) }),
      },
    });

    const result = await checkCrds(clients, 100);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('all 5 percussionist.dev CRDs present and Established');
  });

  it('fails when a CRD is missing', async () => {
    const clients = makeClients({
      apiextensions: {
        listCustomResourceDefinition: async () => ({
          items: CRD_NAMES.slice(0, 4).map((name) => crd(name)),
        }),
      },
    });

    const result = await checkCrds(clients, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('1 CRD problem(s)');
    expect(result.detail).toContain('clustersettings.percussionist.dev missing');
  });

  it('fails when a CRD is present but not Established', async () => {
    const clients = makeClients({
      apiextensions: {
        listCustomResourceDefinition: async () => ({
          items: [
            ...CRD_NAMES.slice(0, 4).map((name) => crd(name)),
            crd('clustersettings.percussionist.dev', false),
          ],
        }),
      },
    });

    const result = await checkCrds(clients, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('clustersettings.percussionist.dev not Established');
  });

  it('fails when the CRD list cannot be read', async () => {
    const clients = makeClients({
      apiextensions: {
        listCustomResourceDefinition: async () => {
          throw new Error('forbidden');
        },
      },
    });

    const result = await checkCrds(clients, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('cannot list CustomResourceDefinitions');
  });
});

// ---------------------------------------------------------------------------
// rbac

describe('checkRbac', () => {
  it('passes when SAs, roles, bindings and references are complete', async () => {
    const clients = makeClients({
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.map((name) => ({ metadata: { name } })),
        }),
      },
      rbac: healthyRbac(),
    });

    const result = await checkRbac(clients, NS, 100);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('RBAC wiring complete (SAs, roles, bindings, references)');
  });

  it('fails when a ServiceAccount is missing', async () => {
    const clients = makeClients({
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.filter((name) => name !== 'percussionist-web').map((name) => ({
            metadata: { name },
          })),
        }),
      },
      rbac: healthyRbac(),
    });

    const result = await checkRbac(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ServiceAccount percussionist/percussionist-web missing');
  });

  it('fails when a ClusterRoleBinding references the wrong roleRef', async () => {
    const clients = makeClients({
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.map((name) => ({ metadata: { name } })),
        }),
      },
      rbac: healthyRbac({
        listClusterRoleBinding: async () => ({
          items: [
            clusterRoleBinding('percussionist-operator', 'wrong-role', 'percussionist-operator'),
            clusterRoleBinding(
              'percussionist-dispatcher',
              'percussionist-dispatcher',
              'percussionist-dispatcher',
            ),
            clusterRoleBinding(
              'percussionist-manager',
              'percussionist-manager',
              'percussionist-manager',
            ),
            clusterRoleBinding(
              'percussionist-web-clusteragents',
              'percussionist-web-clusteragents',
              'percussionist-web',
            ),
            clusterRoleBinding(
              'percussionist-web-nodemetrics',
              'percussionist-web-nodemetrics',
              'percussionist-web',
            ),
          ],
        }),
      }),
    });

    const result = await checkRbac(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(
      'ClusterRoleBinding percussionist-operator: roleRef should be ClusterRole/percussionist-operator',
    );
  });

  it('fails when a RoleBinding subject is in the wrong namespace', async () => {
    const clients = makeClients({
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.map((name) => ({ metadata: { name } })),
        }),
      },
      rbac: healthyRbac({
        listNamespacedRoleBinding: async () => ({
          items: [
            roleBinding(
              'percussionist-dispatcher',
              'percussionist-dispatcher',
              'percussionist-dispatcher',
            ),
            {
              ...roleBinding('percussionist-web', 'percussionist-web', 'percussionist-web'),
              subjects: [
                { kind: 'ServiceAccount', name: 'percussionist-web', namespace: 'other-ns' },
              ],
            },
          ],
        }),
      }),
    });

    const result = await checkRbac(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(
      'RoleBinding percussionist/percussionist-web: missing subject ServiceAccount percussionist/percussionist-web',
    );
  });

  it('fails when RBAC resources cannot be listed', async () => {
    const clients = makeClients({
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.map((name) => ({ metadata: { name } })),
        }),
      },
      rbac: healthyRbac({
        listClusterRole: async () => {
          throw new Error('forbidden');
        },
      }),
    });

    const result = await checkRbac(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('cannot list RBAC resources');
  });
});

// ---------------------------------------------------------------------------
// network-policy

describe('checkNetworkPolicy', () => {
  const policies = () => ({
    items: [
      { metadata: { name: 'manager-ingress' } },
      { metadata: { name: 'memory-service-ingress' } },
    ],
  });

  it('passes when both NetworkPolicies exist and an enforcing CNI is detected', async () => {
    const clients = makeClients({
      networking: { listNamespacedNetworkPolicy: async () => policies() },
      apps: {
        listNamespacedDaemonSet: async () => ({ items: [{ metadata: { name: 'calico-node' } }] }),
      },
    });

    const result = await checkNetworkPolicy(clients, NS, 100);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('enforcing CNI detected (calico-node)');
  });

  it('fails when a NetworkPolicy is missing', async () => {
    const clients = makeClients({
      networking: {
        listNamespacedNetworkPolicy: async () => ({
          items: [{ metadata: { name: 'memory-service-ingress' } }],
        }),
      },
    });

    const result = await checkNetworkPolicy(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('1 NetworkPolicy missing (manager-ingress)');
    expect(result.detail).toBe('apply k8s/deploy/networkpolicy.yaml');
  });

  it('warns when no enforcing CNI daemonset is present (default kind/minikube CNI)', async () => {
    const clients = makeClients({
      networking: { listNamespacedNetworkPolicy: async () => policies() },
      apps: {
        listNamespacedDaemonSet: async () => ({ items: [{ metadata: { name: 'kindnet' } }] }),
      },
    });

    const result = await checkNetworkPolicy(clients, NS, 100);
    expect(result.status).toBe('warn');
    expect(result.message).toBe('NetworkPolicies present but no enforcing CNI detected');
  });

  it('warns, never fails, when the CNI cannot be determined', async () => {
    const clients = makeClients({
      networking: { listNamespacedNetworkPolicy: async () => policies() },
      apps: {
        listNamespacedDaemonSet: async () => {
          throw new Error('forbidden');
        },
      },
    });

    const result = await checkNetworkPolicy(clients, NS, 100);
    expect(result.status).toBe('warn');
  });

  it('fails when NetworkPolicies cannot be listed', async () => {
    const clients = makeClients({
      networking: {
        listNamespacedNetworkPolicy: async () => {
          throw new Error('forbidden');
        },
      },
    });

    const result = await checkNetworkPolicy(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('cannot list NetworkPolicies');
  });
});

// ---------------------------------------------------------------------------
// dns

describe('checkDns', () => {
  const healthyDnsClients = () =>
    makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 2,
            availableReplicas: 2,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

  it('passes when CoreDNS is Available and control-plane Services have ready endpoints', async () => {
    const result = await checkDns(healthyDnsClients(), { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('CoreDNS Available; control-plane Services have ready endpoints');
  });

  it('passes with probe notes when --probe-dns resolves every service name', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
        listNamespacedPod: async () => ({
          items: [
            {
              metadata: { name: 'manager-abc' },
              status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              spec: { containers: [{ name: 'manager' }] },
            },
          ],
        }),
      },
    });

    const result = await checkDns(clients, {
      namespace: NS,
      timeoutMs: 100,
      probeDns: true,
      execProbe: async () => ({ ok: true, output: 'has address 10.96.0.1' }),
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain(
      '--probe-dns: percussionist-manager.percussionist.svc.cluster.local resolves in manager-abc',
    );
  });

  it('downgrades to a warning when a --probe-dns exec fails (getent failed)', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
        listNamespacedPod: async () => ({
          items: [
            {
              metadata: { name: 'manager-abc' },
              status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              spec: { containers: [{ name: 'manager' }] },
            },
          ],
        }),
      },
    });

    const result = await checkDns(clients, {
      namespace: NS,
      timeoutMs: 100,
      probeDns: true,
      execProbe: async () => ({ ok: false, output: 'getent: command not found' }),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('--probe-dns: getent hosts');
  });

  it('downgrades to a warning when the --probe-dns exec itself throws (RBAC/exec failure)', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
        listNamespacedPod: async () => ({
          items: [
            {
              metadata: { name: 'manager-abc' },
              status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              spec: { containers: [{ name: 'manager' }] },
            },
          ],
        }),
      },
    });

    const result = await checkDns(clients, {
      namespace: NS,
      timeoutMs: 100,
      probeDns: true,
      execProbe: async () => {
        throw new Error('Forbidden');
      },
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('--probe-dns: exec into manager-abc failed');
  });

  it('warns when --probe-dns finds no ready control-plane pod to exec into', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
        listNamespacedPod: async () => ({
          items: [
            {
              metadata: { name: 'manager-abc' },
              status: { phase: 'Running', conditions: [] },
              spec: { containers: [{ name: 'manager' }] },
            },
          ],
        }),
      },
    });

    const result = await checkDns(clients, {
      namespace: NS,
      timeoutMs: 100,
      probeDns: true,
      execProbe: async () => ({ ok: true, output: 'ok' }),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no ready percussionist pod to exec into');
  });

  it('fails when CoreDNS is not Available', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: { conditions: [], readyReplicas: 0, availableReplicas: 0 },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('CoreDNS deployment kube-system/coredns not Available');
  });

  it('fails when a control-plane Service is missing', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => {
          if (name === 'percussionist-manager') throw new Error('not found');
          return { metadata: { name } };
        },
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Service percussionist/percussionist-manager missing');
  });

  it('fails when a control-plane Service has no ready endpoints', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('has no ready endpoints');
  });

  // A10 — ollama must be optional unless a Project enables spec.embedding.
  it('passes when the ollama Service is absent and no Project enables embedding', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'plain-project' }, spec: { source: { local: true } } }],
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('pass');
  });

  it('fails when the ollama Service is absent while a Project enables embedding', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'embed-project' }, spec: { embedding: { enabled: true } } }],
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => {
          if (name === 'ollama') throw new Error('not found');
          return { metadata: { name } };
        },
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Service percussionist/ollama missing');
  });

  it('checks the ollama Service when a Project enables embedding', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'coredns' },
          status: {
            conditions: [{ type: 'Available', status: 'True' }],
            readyReplicas: 1,
            availableReplicas: 1,
          },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'embed-project' }, spec: { embedding: { enabled: true } } }],
        }),
      },
      core: {
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
      },
    });

    const result = await checkDns(clients, { namespace: NS, timeoutMs: 100 });
    expect(result.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// storage

describe('checkStorage', () => {
  const healthyStorageClients = () =>
    makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async ({ name }) => ({
          metadata: { name },
          status: { phase: 'Bound' },
        }),
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

  it('passes when a default StorageClass exists and PVCs are Bound', async () => {
    const result = await checkStorage(healthyStorageClients(), NS, 100);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('default StorageClass present; web and project data PVCs Bound');
  });

  it('warns when the web PVC is Pending (provisioning in progress)', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async () => ({
          metadata: { name: 'percussionist-web-db-v3' },
          status: { phase: 'Pending' },
        }),
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('PVC percussionist/percussionist-web-db-v3 is Pending');
  });

  it('errors when a project data PVC is Failed', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async ({ name }) => ({
          metadata: { name },
          status: { phase: name === 'demo-data' ? 'Failed' : 'Bound' },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'demo', namespace: NS }, spec: {} }],
        }),
      },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PVC percussionist/demo-data is Failed');
  });

  it('errors when a project data PVC is Lost', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async ({ name }) => ({
          metadata: { name },
          status: { phase: name === 'demo-data' ? 'Lost' : 'Bound' },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'demo', namespace: NS }, spec: {} }],
        }),
      },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PVC percussionist/demo-data is Lost');
  });

  it('warns when a project data PVC is Pending', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async ({ name }) => ({
          metadata: { name },
          status: { phase: name === 'demo-data' ? 'Pending' : 'Bound' },
        }),
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'demo', namespace: NS }, spec: {} }],
        }),
      },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('PVC percussionist/demo-data is Pending');
  });

  it('fails when a PVC is missing', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async () => {
          throw new Error('not found');
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PVC percussionist/percussionist-web-db-v3 missing');
  });

  it('warns when no StorageClass is marked default', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [{ metadata: { name: 'standard' } }],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async () => ({
          metadata: { name: 'percussionist-web-db-v3' },
          status: { phase: 'Bound' },
        }),
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no StorageClass marked default');
  });

  it('fails when the operator DEFAULT_STORAGE_CLASS env resolves to a missing StorageClass', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [{ metadata: { name: 'fast' } }],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async () => ({
          metadata: { name: 'percussionist-web-db-v3' },
          status: { phase: 'Bound' },
        }),
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(
      'operator DEFAULT_STORAGE_CLASS resolves to "standard" but no such StorageClass exists',
    );
  });

  it('fails when StorageClasses cannot be listed', async () => {
    const clients = makeClients({
      storage: {
        listStorageClass: async () => {
          throw new Error('forbidden');
        },
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('fail');
    expect(result.message).toBe('cannot list StorageClasses');
  });

  // A10 — the documented spec.data.pvcName override must be honored.
  it('checks spec.data.pvcName instead of {project}-data when the override is set', async () => {
    const readPvcNames: string[] = [];
    const clients = makeClients({
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
      core: {
        readNamespacedPersistentVolumeClaim: async ({ name }) => {
          readPvcNames.push(name as string);
          return { metadata: { name }, status: { phase: 'Bound' } };
        },
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [
            {
              metadata: { name: 'demo', namespace: NS },
              spec: { data: { pvcName: 'custom-data' } },
            },
          ],
        }),
      },
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-operator' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'DEFAULT_STORAGE_CLASS', value: 'standard' }] }],
              },
            },
          },
        }),
      },
    });

    const result = await checkStorage(clients, NS, 100);
    expect(result.status).toBe('pass');
    expect(readPvcNames).toContain('custom-data');
    expect(readPvcNames).not.toContain('demo-data');
  });
});

// ---------------------------------------------------------------------------
// credentials

describe('checkCredentials', () => {
  const secretClients = (overrides: Record<string, unknown> = {}) =>
    makeClients({
      core: {
        readNamespacedSecret: async ({ name }) => ({
          metadata: { name },
          data: secretDataFor(name as string),
        }),
        ...overrides,
      },
    });

  it('passes when required secrets have their keys and a scoped-key inventory is verified', async () => {
    const result = await checkCredentials(secretClients(), {
      namespace: NS,
      timeoutMs: 100,
      readSession: () => ({ token: 'abc' }),
      queryAgentKeys: async () => 3,
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('required Secrets present with expected keys');
    expect(result.detail).toContain('3 scoped agent key(s) verified');
  });

  it('warns when optional secrets (opencode-auth, llm-keys) are missing', async () => {
    const clients = makeClients({
      core: {
        readNamespacedSecret: async ({ name }) => {
          const required = ['operator-api-key', 'manager-api-key', 'manager-mcp-token', 'web-auth'];
          if (!required.includes(name as string)) throw new Error('not found');
          return { metadata: { name }, data: secretDataFor(name as string) };
        },
      },
    });

    const result = await checkCredentials(clients, {
      namespace: NS,
      timeoutMs: 100,
      readSession: () => ({ token: 'abc' }),
      queryAgentKeys: async () => 3,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no opencode-auth Secret');
    expect(result.detail).toContain('no llm-keys Secret');
  });

  it('warns when no CLI session exists (scoped-key inventory skipped)', async () => {
    const result = await checkCredentials(secretClients(), {
      namespace: NS,
      timeoutMs: 100,
      readSession: () => null,
      queryAgentKeys: async () => 0,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('run `beatctl auth login` to verify agent keys');
  });

  it('fails when a required secret is missing', async () => {
    const clients = makeClients({
      core: {
        readNamespacedSecret: async ({ name }) => {
          if (name === 'manager-api-key') throw new Error('not found');
          return { metadata: { name }, data: secretDataFor(name as string) };
        },
      },
    });

    const result = await checkCredentials(clients, {
      namespace: NS,
      timeoutMs: 100,
      readSession: () => null,
      queryAgentKeys: async () => 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Secret percussionist/manager-api-key missing');
  });

  it('fails when a required secret is missing an expected key', async () => {
    const clients = makeClients({
      core: {
        readNamespacedSecret: async ({ name }) => {
          const data = secretDataFor(name as string);
          if (name === 'web-auth') {
            const { 'github-client-secret': _drop, ...rest } = data;
            return { metadata: { name }, data: rest };
          }
          return { metadata: { name }, data };
        },
      },
    });

    const result = await checkCredentials(clients, {
      namespace: NS,
      timeoutMs: 100,
      readSession: () => null,
      queryAgentKeys: async () => 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(
      'Secret percussionist/web-auth missing key(s): github-client-secret',
    );
  });
});

// ---------------------------------------------------------------------------
// providers

describe('checkProviders', () => {
  const zeroConnected = (): ListModelsResult => ({ all: [], default: {}, connected: [] });

  it('passes when at least one provider is connected', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => ({
        all: [{ id: 'anthropic', name: 'Anthropic', models: [] }],
        default: {},
        connected: ['anthropic'],
      }),
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('1 connected provider(s): Anthropic');
  });

  it('fails when zero providers are connected despite credentials being configured', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => zeroConnected(),
      isAuthDisabled: async () => false,
      credentialsConfigured: async () => true,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toBe('no connected providers despite credentials configured');
  });

  it('warns (not fails) in dev mode when AUTH_DISABLED=1', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => zeroConnected(),
      isAuthDisabled: async () => true,
      credentialsConfigured: async () => true,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toBe('no connected providers (dev mode: AUTH_DISABLED=1)');
  });

  it('warns when zero providers are connected and no credentials are configured', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => zeroConnected(),
      isAuthDisabled: async () => false,
      credentialsConfigured: async () => false,
    });
    expect(result.status).toBe('warn');
    expect(result.message).toBe('no connected providers');
    expect(result.detail).toContain('run `beatctl auth import`');
  });

  it('detects dev mode through the web-auth Secret when using the default detector', async () => {
    const clients = makeClients({
      core: {
        readNamespacedSecret: async ({ name }) => {
          if (name === 'web-auth') return { metadata: { name }, data: { disabled: btoa('1') } };
          throw new Error('not found');
        },
      },
    });

    const result = await checkProviders(clients, {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => zeroConnected(),
    });
    expect(result.status).toBe('warn');
    expect(result.message).toBe('no connected providers (dev mode: AUTH_DISABLED=1)');
  });

  it('fails with a specific cause when the manager MCP is unreachable', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => {
        throw new ManagerMcpError('unreachable', 'cannot port-forward svc/percussionist-manager');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('manager MCP unreachable');
  });

  it('fails with a specific cause when list_models fails on the opencode sidecar', async () => {
    const result = await checkProviders(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => {
        throw new ManagerMcpError('tool-error', 'opencode /provider returned 502');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('opencode sidecar not ready');
  });
});

// ---------------------------------------------------------------------------
// models

describe('checkModels', () => {
  const connectedAnthropic = (): ListModelsResult => ({
    all: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5' }] }],
    default: {},
    connected: ['anthropic'],
  });

  it('passes when a connected provider exposes models and the default model resolves', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
      gatherDefaultModels: async () => [
        { source: 'opencode-config default', model: 'anthropic/claude-sonnet-4-5' },
      ],
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('1 connected provider(s), 1 model(s) available');
    expect(result.detail).toContain('resolves to connected provider "anthropic"');
    expect(result.detail).toContain('provider → models');
  });

  it('fails when no connected provider exposes any model', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => ({
        all: [{ id: 'anthropic', models: [] }],
        default: {},
        connected: ['anthropic'],
      }),
      gatherDefaultModels: async () => [],
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no connected provider exposes any model');
  });

  it('fails when the default model references a provider that is not connected', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
      gatherDefaultModels: async () => [
        { source: 'ClusterSettings default', model: 'openai/gpt-5' },
      ],
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(
      'default model openai/gpt-5 (ClusterSettings default) references provider "openai" which is not connected',
    );
  });

  it('warns when the default model provider is connected but the model is not listed', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
      gatherDefaultModels: async () => [{ source: 'project demo', model: 'anthropic/gpt-5' }],
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(
      'default model anthropic/gpt-5 (project demo) provider "anthropic" is connected but model "gpt-5" is not in its list',
    );
  });

  it('warns when no default model is configured anywhere', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
      gatherDefaultModels: async () => [],
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no default model configured');
  });

  it('passes when the default model selects the claude-code engine (informational, not cross-checkable)', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
      gatherDefaultModels: async () => [
        { source: 'ClusterSettings default', model: 'claude-code/claude-opus-4' },
      ],
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('selects the claude-code engine');
  });

  it('fails with a specific cause when list_models fails', async () => {
    const result = await checkModels(makeClients(), {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => {
        throw new ManagerMcpError('unreachable', 'timed out');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('manager MCP unreachable');
  });

  it('gathers the default model from the opencode-config ConfigMap when using the default gatherer', async () => {
    const clients = makeClients({
      core: {
        readNamespacedConfigMap: async ({ name, namespace }) => {
          if (name === 'opencode-config' && namespace === NS) {
            return {
              metadata: { name },
              data: { 'opencode.json': JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }) },
            };
          }
          throw new Error('not found');
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
    });

    const result = await checkModels(clients, {
      namespace: NS,
      timeoutMs: 100,
      requestListModels: async () => connectedAnthropic(),
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('opencode-config percussionist');
  });
});

// ---------------------------------------------------------------------------
// dashboard

describe('checkDashboard', () => {
  const dashboardClients = (webBaseUrl: string) =>
    makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-web' },
          spec: {
            template: {
              spec: { containers: [{ env: [{ name: 'WEB_BASE_URL', value: webBaseUrl }] }] },
            },
          },
        }),
      },
      networking: {
        readNamespacedIngress: async () => ({
          spec: { rules: [{ host: WEB_HOST }], tls: [] },
        }),
      },
      core: {
        readNamespacedSecret: async () => ({
          metadata: { name: 'web-auth' },
          data: { 'github-client-id': btoa('app-id') },
        }),
      },
    });

  const dashboardProbes = {
    withWebApi: async (_namespace: string | undefined, fn: (baseUrl: string) => Promise<unknown>) =>
      fn('http://web.test'),
    webRequest: async () => ({ ok: true, namespace: NS, authDisabled: false }),
  };

  it('passes when WEB_BASE_URL matches the Ingress host and the auth surface is healthy', async () => {
    const result = await checkDashboard(dashboardClients(`http://${WEB_HOST}`), {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('WEB_BASE_URL matches the Ingress; auth surface healthy');
  });

  it('fails when WEB_BASE_URL is unset (localhost fallback default)', async () => {
    const result = await checkDashboard(
      makeClients({
        apps: {
          readNamespacedDeployment: async () => ({
            metadata: { name: 'percussionist-web' },
            spec: { template: { spec: { containers: [{ env: [] }] } } },
          }),
        },
        networking: {
          readNamespacedIngress: async () => ({ spec: { rules: [{ host: WEB_HOST }], tls: [] } }),
        },
        core: {
          readNamespacedSecret: async () => ({
            metadata: { name: 'web-auth' },
            data: { 'github-client-id': btoa('app-id') },
          }),
        },
      }),
      { namespace: NS, timeoutMs: 100, ...dashboardProbes },
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('has no WEB_BASE_URL env');
  });

  it('fails when WEB_BASE_URL is the localhost port-forward fallback', async () => {
    const result = await checkDashboard(dashboardClients('http://localhost:8080'), {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('localhost port-forward fallback');
  });

  it('fails when WEB_BASE_URL host does not match the Ingress host', async () => {
    const result = await checkDashboard(dashboardClients('http://other.example.com'), {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`does not match Ingress host "${WEB_HOST}"`);
  });

  it('warns when the Ingress is unreadable (dashboard reachable only via port-forward)', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-web' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'WEB_BASE_URL', value: 'http://app.example.com' }] }],
              },
            },
          },
        }),
      },
      networking: {
        readNamespacedIngress: async () => {
          throw new Error('forbidden');
        },
      },
      core: {
        readNamespacedSecret: async () => ({
          metadata: { name: 'web-auth' },
          data: { 'github-client-id': btoa('app-id') },
        }),
      },
    });

    const result = await checkDashboard(clients, {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('Ingress percussionist/percussionist-web unreadable');
  });

  it('warns when the WEB_BASE_URL scheme differs from the Ingress TLS scheme', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-web' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'WEB_BASE_URL', value: 'http://app.example.com' }] }],
              },
            },
          },
        }),
      },
      networking: {
        readNamespacedIngress: async () => ({
          spec: { rules: [{ host: 'app.example.com' }], tls: [{ hosts: ['app.example.com'] }] },
        }),
      },
      core: {
        readNamespacedSecret: async () => ({
          metadata: { name: 'web-auth' },
          data: { 'github-client-id': btoa('app-id') },
        }),
      },
    });

    const result = await checkDashboard(clients, {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('scheme "http" differs from the Ingress "https"');
  });

  it('warns when no GitHub App client id is configured (no sign-in possible)', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-web' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'WEB_BASE_URL', value: `http://${WEB_HOST}` }] }],
              },
            },
          },
        }),
      },
      networking: {
        readNamespacedIngress: async () => ({ spec: { rules: [{ host: WEB_HOST }], tls: [] } }),
      },
      core: {
        readNamespacedSecret: async () => ({ metadata: { name: 'web-auth' }, data: {} }),
      },
    });

    const result = await checkDashboard(clients, {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no GitHub App client id');
  });

  it('warns when AUTH_DISABLED state differs between the Secret and /api/health', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async () => ({
          metadata: { name: 'percussionist-web' },
          spec: {
            template: {
              spec: {
                containers: [{ env: [{ name: 'WEB_BASE_URL', value: `http://${WEB_HOST}` }] }],
              },
            },
          },
        }),
      },
      networking: {
        readNamespacedIngress: async () => ({ spec: { rules: [{ host: WEB_HOST }], tls: [] } }),
      },
      core: {
        readNamespacedSecret: async () => ({
          metadata: { name: 'web-auth' },
          data: { 'github-client-id': btoa('app-id'), disabled: btoa('1') },
        }),
      },
    });

    const result = await checkDashboard(clients, {
      namespace: NS,
      timeoutMs: 100,
      ...dashboardProbes,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('AUTH_DISABLED state mismatch');
  });

  it('fails when web /api/health is unreachable', async () => {
    const result = await checkDashboard(dashboardClients(`http://${WEB_HOST}`), {
      namespace: NS,
      timeoutMs: 100,
      withWebApi: async (_namespace, fn) => fn('http://web.test'),
      webRequest: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('web /api/health unreachable');
  });

  it('fails when web /api/health does not return ok:true', async () => {
    const result = await checkDashboard(dashboardClients(`http://${WEB_HOST}`), {
      namespace: NS,
      timeoutMs: 100,
      withWebApi: async (_namespace, fn) => fn('http://web.test'),
      webRequest: async () => ({ ok: false, namespace: NS, authDisabled: false }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('did not return ok:true');
  });

  it('fails when web /api/health serves a different namespace than inspected', async () => {
    const result = await checkDashboard(dashboardClients(`http://${WEB_HOST}`), {
      namespace: NS,
      timeoutMs: 100,
      withWebApi: async (_namespace, fn) => fn('http://web.test'),
      webRequest: async () => ({ ok: true, namespace: 'other-ns', authDisabled: false }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('serving a different namespace');
  });
});

// ---------------------------------------------------------------------------
// health

describe('checkHealth', () => {
  const healthyHealthClients = () =>
    makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => deploymentFor(name as string),
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
    });

  const healthProbes = {
    probeMcpTools: async () => [{ name: 'list_models' }, { name: 'get_status' }],
    withWebApi: async (_namespace: string | undefined, fn: (baseUrl: string) => Promise<unknown>) =>
      fn('http://web.test'),
    webRequest: async () => ({ ok: true, namespace: NS }),
  };

  it('passes when control-plane Deployments are ready, MCP answers, and web health is ok', async () => {
    const result = await checkHealth(healthyHealthClients(), {
      namespace: NS,
      timeoutMs: 100,
      ...healthProbes,
    });
    expect(result.status).toBe('pass');
    expect(result.message).toBe('control-plane Deployments ready; MCP and web health probes pass');
  });

  it('fails when a control-plane Deployment is missing', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'percussionist-operator') throw new Error('not found');
          return deploymentFor(name as string);
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
    });

    const result = await checkHealth(clients, { namespace: NS, timeoutMs: 100, ...healthProbes });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Deployment percussionist/percussionist-operator missing');
  });

  it('fails when a control-plane Deployment has no ready replicas', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'percussionist-manager') {
            return { metadata: { name }, status: { availableReplicas: 0, readyReplicas: 0 } };
          }
          return deploymentFor(name as string);
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
    });

    const result = await checkHealth(clients, { namespace: NS, timeoutMs: 100, ...healthProbes });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Deployment percussionist/percussionist-manager not healthy');
  });

  it('fails when ollama is not deployed while a Project enables spec.embedding', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'ollama') throw new Error('not found');
          return deploymentFor(name as string);
        },
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'demo' }, spec: { embedding: { enabled: true } } }],
        }),
      },
    });

    const result = await checkHealth(clients, { namespace: NS, timeoutMs: 100, ...healthProbes });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ollama is not deployed');
  });

  it('fails when ollama is unhealthy while a Project enables spec.embedding', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'ollama') {
            return { metadata: { name }, status: { availableReplicas: 0, readyReplicas: 0 } };
          }
          return deploymentFor(name as string);
        },
      },
      custom: {
        listClusterCustomObject: async () => ({
          items: [{ metadata: { name: 'demo' }, spec: { embedding: { enabled: true } } }],
        }),
      },
    });

    const result = await checkHealth(clients, { namespace: NS, timeoutMs: 100, ...healthProbes });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ollama not healthy while Projects enable spec.embedding');
  });

  it('passes when ollama is deployed but unused (no embedding project)', async () => {
    const clients = makeClients({
      apps: {
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'ollama') {
            return { metadata: { name }, status: { availableReplicas: 1, readyReplicas: 1 } };
          }
          return deploymentFor(name as string);
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
    });

    const result = await checkHealth(clients, { namespace: NS, timeoutMs: 100, ...healthProbes });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('ollama deployed but no Project enables spec.embedding');
  });

  it('fails when the manager MCP tools/list probe fails', async () => {
    const result = await checkHealth(healthyHealthClients(), {
      namespace: NS,
      timeoutMs: 100,
      ...healthProbes,
      probeMcpTools: async () => {
        throw new ManagerMcpError('unreachable', 'cannot port-forward');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('manager MCP tools/list probe failed');
  });

  it('warns when the manager MCP exposes no tools', async () => {
    const result = await checkHealth(healthyHealthClients(), {
      namespace: NS,
      timeoutMs: 100,
      ...healthProbes,
      probeMcpTools: async () => [],
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('exposed no tools');
  });

  it('fails when web /api/health is unreachable', async () => {
    const result = await checkHealth(healthyHealthClients(), {
      namespace: NS,
      timeoutMs: 100,
      ...healthProbes,
      webRequest: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('web /api/health unreachable');
  });
});

// ---------------------------------------------------------------------------
// runDoctor orchestrator

describe('runDoctor', () => {
  let previousExitCode: number | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  function stubCheck(name: string, category: string, result: DoctorCheckResult): DoctorCheck {
    return { name, category, run: () => result };
  }

  function recordingCheck(
    name: string,
    category: string,
    result: DoctorCheckResult,
    ran: string[],
  ): DoctorCheck {
    return {
      name,
      category,
      run: () => {
        ran.push(name);
        return result;
      },
    };
  }

  const pass = (message: string): DoctorCheckResult => ({ status: 'pass', message });
  const warn = (message: string): DoctorCheckResult => ({ status: 'warn', message });

  it('reports a clean cluster across all 10 check categories with exit 0', async () => {
    const clients = healthyClients();
    const lines: string[] = [];

    await runDoctor(
      { timeout: 2 },
      {
        loadClients: () => clients,
        probeConnection: async () => {},
        checks: doctorRegistry(clients, healthyProbes),
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(0);
    expect(lines).toContain('  Checks run: 10');
    expect(lines).toContain('  Pass: 10');
    expect(lines).toContain('  Warnings: 0');
    expect(lines).toContain('  Failures: 0');
    for (const heading of [
      'CRDs (1)',
      'RBAC (1)',
      'NetworkPolicy (1)',
      'DNS (1)',
      'Storage (1)',
      'Credentials (1)',
      'Providers (1)',
      'Models (1)',
      'Dashboard (1)',
      'Health (1)',
    ]) {
      expect(lines).toContain(heading);
    }
    expect(lines).toContain('No problems found.');
    expect(lines).toContain('Result: PASS (exit 0)');
  });

  it('reports a degraded cluster with mixed statuses and exit 1', async () => {
    // Every check except network-policy (warning) fails: missing CRD, missing
    // SA, non-Available CoreDNS, Failed web PVC, missing manager-api-key,
    // zero connected providers, no models, no WEB_BASE_URL, unhealthy operator.
    const degradedClients = makeClients({
      apiextensions: {
        listCustomResourceDefinition: async () => ({
          items: CRD_NAMES.slice(0, 4).map((name) => crd(name)),
        }),
      },
      core: {
        listNamespacedServiceAccount: async () => ({
          items: SA_NAMES.filter((name) => name !== 'percussionist-web').map((name) => ({
            metadata: { name },
          })),
        }),
        readNamespacedService: async ({ name }) => ({ metadata: { name } }),
        readNamespacedEndpoints: async () => ({ subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] }),
        readNamespacedPersistentVolumeClaim: async () => ({
          metadata: { name: 'percussionist-web-db-v3' },
          status: { phase: 'Failed' },
        }),
        readNamespacedSecret: async ({ name }) => {
          if (name === 'manager-api-key') throw new Error('not found');
          return { metadata: { name }, data: secretDataFor(name as string) };
        },
        readNamespacedConfigMap: async () => ({ metadata: { name: 'opencode-config' }, data: {} }),
      },
      apps: {
        listNamespacedDaemonSet: async () => ({ items: [{ metadata: { name: 'kindnet' } }] }),
        readNamespacedDeployment: async ({ name }) => {
          if (name === 'coredns') {
            return {
              metadata: { name },
              status: { conditions: [], readyReplicas: 0, availableReplicas: 0 },
            };
          }
          if (name === 'ollama') throw new Error('not deployed');
          if (name === 'percussionist-operator') {
            return { metadata: { name }, status: { availableReplicas: 0, readyReplicas: 0 } };
          }
          return { metadata: { name }, status: { availableReplicas: 1, readyReplicas: 1 } };
        },
      },
      custom: { listClusterCustomObject: async () => ({ items: [] }) },
      networking: {
        listNamespacedNetworkPolicy: async () => ({
          items: [
            { metadata: { name: 'manager-ingress' } },
            { metadata: { name: 'memory-service-ingress' } },
          ],
        }),
        readNamespacedIngress: async () => ({ spec: { rules: [{ host: WEB_HOST }], tls: [] } }),
      },
      rbac: healthyRbac(),
      storage: {
        listStorageClass: async () => ({
          items: [
            {
              metadata: {
                name: 'standard',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      },
    });

    const degradedProbes: DoctorProbes = {
      ...healthyProbes,
      requestListModels: async () => ({ all: [], default: {}, connected: [] }),
      gatherDefaultModels: async () => [],
      webRequest: async () => ({ ok: true, namespace: NS, authDisabled: false }),
    };

    const lines: string[] = [];
    await runDoctor(
      { timeout: 2 },
      {
        loadClients: () => degradedClients,
        probeConnection: async () => {},
        checks: doctorRegistry(degradedClients, degradedProbes),
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(lines).toContain('  Checks run: 10');
    expect(lines).toContain('  Pass: 0');
    expect(lines).toContain('  Warnings: 1');
    expect(lines).toContain('  Failures: 9');
    expect(lines).toContain('Result: FAIL — 9 failing check(s) (exit 1)');
    // Per-category statuses land in the details section (message + appended detail).
    const startsWith = (prefix: string) => lines.some((line) => line.startsWith(prefix));
    expect(startsWith('  - [fail] 1 CRD problem(s)')).toBeTrue();
    expect(startsWith('  - [fail] 1 RBAC problem(s)')).toBeTrue();
    expect(
      startsWith('  - [warn] NetworkPolicies present but no enforcing CNI detected'),
    ).toBeTrue();
    expect(startsWith('  - [fail] 1 DNS problem(s)')).toBeTrue();
    expect(startsWith('  - [fail] 1 storage problem(s)')).toBeTrue();
    expect(startsWith('  - [fail] 1 credential problem(s)')).toBeTrue();
    expect(
      startsWith('  - [fail] no connected providers despite credentials configured'),
    ).toBeTrue();
    expect(startsWith('  - [fail] 1 model problem(s)')).toBeTrue();
    expect(startsWith('  - [fail] 1 dashboard problem(s)')).toBeTrue();
    expect(startsWith('  - [fail] 1 component health problem(s)')).toBeTrue();
  });

  it('sets exitCode=0 on all-pass stub checks and prints the summary', async () => {
    const lines: string[] = [];
    await runDoctor(
      {},
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [
          stubCheck('crds', 'CRDs', pass('all 5 CRDs present and Established')),
          stubCheck('storage', 'Storage', pass('PVCs Bound')),
        ],
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(0);
    expect(lines).toContain('Percussionist cluster doctor');
    expect(lines).toContain('  Namespace: percussionist');
    expect(lines).toContain('Summary');
    expect(lines).toContain('  Checks run: 2');
    expect(lines).toContain('  Pass: 2');
    expect(lines).toContain('  Warnings: 0');
    expect(lines).toContain('  Failures: 0');
    expect(lines).toContain('CRDs (1)');
    expect(lines).toContain('  - [pass] all 5 CRDs present and Established');
    expect(lines).toContain('No problems found.');
    expect(lines).toContain('Result: PASS (exit 0)');
  });

  it('sets exitCode=1 when any check fails and renders the failure detail', async () => {
    const lines: string[] = [];
    await runDoctor(
      {},
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [
          stubCheck('crds', 'CRDs', pass('all 5 CRDs present and Established')),
          stubCheck('storage', 'Storage', {
            status: 'fail',
            message: '1 storage problem(s)',
            detail: 'PVC percussionist/demo-data is Failed',
          }),
        ],
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(lines).toContain('  Pass: 1');
    expect(lines).toContain('  Failures: 1');
    expect(lines).toContain(
      '  - [fail] 1 storage problem(s) — PVC percussionist/demo-data is Failed',
    );
    expect(lines).toContain('Result: FAIL — 1 failing check(s) (exit 1)');
  });

  it('keeps exitCode=0 when the worst status is a warning', async () => {
    const lines: string[] = [];
    await runDoctor(
      {},
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [stubCheck('network-policy', 'NetworkPolicy', warn('no enforcing CNI detected'))],
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(0);
    expect(lines).toContain('  Pass: 0');
    expect(lines).toContain('  Warnings: 1');
    expect(lines).toContain('  - [warn] no enforcing CNI detected');
  });

  it('records a check that throws as a failure', async () => {
    const lines: string[] = [];
    await runDoctor(
      {},
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [
          {
            name: 'boom',
            category: 'Boom',
            run: () => {
              throw new Error('kaboom');
            },
          },
        ],
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(1);
    expect(lines).toContain('  - [fail] check threw: kaboom');
  });

  it('emits a structured machine-readable report with --json', async () => {
    const lines: string[] = [];
    await runDoctor(
      { json: true, timeout: 2, probeDns: true },
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [
          stubCheck('crds', 'CRDs', pass('all 5 CRDs present and Established')),
          stubCheck('network-policy', 'NetworkPolicy', warn('no enforcing CNI detected')),
        ],
        log: (line) => lines.push(line),
      },
    );

    expect(process.exitCode).toBe(0);
    const report = JSON.parse(lines[0] as string) as DoctorJsonReport;
    expect(report.command).toBe('doctor');
    expect(report.version).toBe(1);
    expect(report.namespace).toBe(NS);
    expect(report.timeoutSec).toBe(2);
    expect(report.probeDns).toBe(true);
    expect(report.unknownChecks).toEqual([]);
    expect(report.checks).toEqual([
      {
        name: 'crds',
        category: 'CRDs',
        status: 'pass',
        message: 'all 5 CRDs present and Established',
      },
      {
        name: 'network-policy',
        category: 'NetworkPolicy',
        status: 'warn',
        message: 'no enforcing CNI detected',
      },
    ]);
    expect(report.summary).toEqual({ total: 2, pass: 1, warn: 1, fail: 0 });
    expect(report.exitCode).toBe(0);
  });

  it('runs only the named checks with --check and reports unknown names', async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    await runDoctor(
      { check: ['storage', 'no-such-check'] },
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [
          recordingCheck('crds', 'CRDs', pass('ok'), ran),
          recordingCheck('storage', 'Storage', pass('ok'), ran),
          recordingCheck('health', 'Health', pass('ok'), ran),
        ],
        log: (line) => lines.push(line),
      },
    );

    expect(ran).toEqual(['storage']);
    expect(process.exitCode).toBe(0);
    expect(lines).toContain('  Unknown --check names: no-such-check');
  });

  it('reports unknown --check names in the JSON report', async () => {
    const lines: string[] = [];
    await runDoctor(
      { json: true, check: ['no-such-check'] },
      {
        loadClients: () => makeClients(),
        probeConnection: async () => {},
        checks: [stubCheck('crds', 'CRDs', pass('ok'))],
        log: (line) => lines.push(line),
      },
    );

    const report = JSON.parse(lines[0] as string) as DoctorJsonReport;
    expect(report.unknownChecks).toEqual(['no-such-check']);
    expect(report.checks).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('sets exitCode=2 when the Kubernetes clients cannot be built', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDoctor(
        {},
        {
          loadClients: () => {
            throw new Error('no kubeconfig found');
          },
        },
      );
      expect(process.exitCode).toBe(DoctorExitCode.Fatal);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('sets exitCode=2 when the connectivity probe fails (cluster unreachable)', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDoctor(
        {},
        {
          loadClients: () => makeClients(),
          probeConnection: async () => {
            throw new Error('connection refused');
          },
        },
      );
      expect(process.exitCode).toBe(DoctorExitCode.Fatal);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('throws on an invalid --timeout value', async () => {
    await expect(runDoctor({ timeout: 0 }, {})).rejects.toThrow('invalid --timeout value: 0');
    await expect(runDoctor({ timeout: -5 }, {})).rejects.toThrow('invalid --timeout value: -5');
  });
});
