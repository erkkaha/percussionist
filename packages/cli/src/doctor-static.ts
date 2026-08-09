// doctor-static.ts — `beatctl doctor` static cluster checks.
//
// These five checks audit the control plane's static configuration surface:
// CRDs, RBAC wiring, NetworkPolicy + CNI enforcement, DNS reachability and
// storage provisioning. Each check is a pure function that accepts its API
// clients (plus the options it needs) as parameters — nothing is imported or
// constructed inside — so unit tests can stub the clients exactly as
// `auditAgentCapabilities` is tested in validate.test.ts.
//
// Read-only guarantee: every check uses get/list API verbs plus bounded
// probes (via `withProbeTimeout`). The only in-pod action is the opt-in
// `--probe-dns` exec of a read-only `getent hosts`, which is best-effort and
// downgraded to a warning on RBAC/exec failures.

import { spawn } from 'node:child_process';
import type {
  V1ClusterRoleBindingList,
  V1ClusterRoleList,
  V1CustomResourceDefinitionList,
  V1Deployment,
  V1Endpoints,
  V1NetworkPolicyList,
  V1PersistentVolumeClaim,
  V1PodList,
  V1RoleBindingList,
  V1RoleList,
  V1Service,
  V1ServiceAccountList,
  V1StorageClassList,
} from '@kubernetes/client-node';
import {
  API_GROUP,
  PLURAL_CLUSTER_AGENT,
  PLURAL_CLUSTER_SETTINGS,
  PLURAL_PROJECT,
  PLURAL_RUN,
  PLURAL_TASK,
  type Project,
} from '@percussionist/api';
import type { DoctorCheck, DoctorCheckResult } from './doctor.js';
import { withProbeTimeout } from './doctor.js';
import type { DoctorClients } from './k8s-clients.js';
import { listAllProjects } from './kube.js';

// ---------------------------------------------------------------------------
// crds — the 5 percussionist.dev CRDs exist and are Established.

const EXPECTED_CRDS = [
  `${PLURAL_RUN}.${API_GROUP}`,
  `${PLURAL_PROJECT}.${API_GROUP}`,
  `${PLURAL_TASK}.${API_GROUP}`,
  `${PLURAL_CLUSTER_AGENT}.${API_GROUP}`,
  `${PLURAL_CLUSTER_SETTINGS}.${API_GROUP}`,
];

export async function checkCrds(
  clients: DoctorClients,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  let list: V1CustomResourceDefinitionList;
  try {
    list = await withProbeTimeout(
      clients.apiextensions.listCustomResourceDefinition({}),
      timeoutMs,
      'list CRDs',
    );
  } catch (e) {
    return {
      status: 'fail',
      message: 'cannot list CustomResourceDefinitions',
      detail: errorMessage(e),
    };
  }

  const byName = new Map<string, (typeof list.items)[number]>();
  for (const crd of list.items ?? []) {
    const name = crd.metadata?.name;
    if (name) byName.set(name, crd);
  }

  const problems: string[] = [];
  for (const fullName of EXPECTED_CRDS) {
    const crd = byName.get(fullName);
    if (!crd) {
      problems.push(`${fullName} missing`);
      continue;
    }
    const established = (crd.status?.conditions ?? []).some(
      (c) => c.type === 'Established' && c.status === 'True',
    );
    if (!established) {
      problems.push(`${fullName} not Established`);
    }
  }

  if (problems.length === 0) {
    return {
      status: 'pass',
      message: `all ${EXPECTED_CRDS.length} percussionist.dev CRDs present and Established`,
    };
  }
  return {
    status: 'fail',
    message: `${problems.length} CRD problem(s)`,
    detail: problems.join('; '),
  };
}

// ---------------------------------------------------------------------------
// rbac — SAs, (Cluster)Roles and (Cluster)RoleBindings exist and reference the
// right subject/roleRef names. Names sourced from k8s/deploy/operator.yaml,
// manager-controller.yaml and web.yaml.

const EXPECTED_SERVICE_ACCOUNTS = [
  'percussionist-operator',
  'percussionist-dispatcher',
  'percussionist-manager',
  'percussionist-web',
];

const EXPECTED_CLUSTER_ROLES = [
  'percussionist-operator',
  'percussionist-dispatcher',
  'percussionist-manager',
  'percussionist-web-clusteragents',
  'percussionist-web-nodemetrics',
];

const EXPECTED_ROLES = ['percussionist-dispatcher', 'percussionist-web'];

const EXPECTED_CLUSTER_ROLE_BINDINGS: ReadonlyArray<{
  name: string;
  sa: string;
  role: string;
}> = [
  { name: 'percussionist-operator', sa: 'percussionist-operator', role: 'percussionist-operator' },
  {
    name: 'percussionist-dispatcher',
    sa: 'percussionist-dispatcher',
    role: 'percussionist-dispatcher',
  },
  { name: 'percussionist-manager', sa: 'percussionist-manager', role: 'percussionist-manager' },
  {
    name: 'percussionist-web-clusteragents',
    sa: 'percussionist-web',
    role: 'percussionist-web-clusteragents',
  },
  {
    name: 'percussionist-web-nodemetrics',
    sa: 'percussionist-web',
    role: 'percussionist-web-nodemetrics',
  },
];

const EXPECTED_ROLE_BINDINGS: ReadonlyArray<{ name: string; sa: string; role: string }> = [
  {
    name: 'percussionist-dispatcher',
    sa: 'percussionist-dispatcher',
    role: 'percussionist-dispatcher',
  },
  { name: 'percussionist-web', sa: 'percussionist-web', role: 'percussionist-web' },
];

export async function checkRbac(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  let saList: V1ServiceAccountList;
  let clusterRoleList: V1ClusterRoleList;
  let roleList: V1RoleList;
  let clusterRoleBindingList: V1ClusterRoleBindingList;
  let roleBindingList: V1RoleBindingList;
  try {
    [saList, clusterRoleList, roleList, clusterRoleBindingList, roleBindingList] =
      await Promise.all([
        withProbeTimeout(
          clients.core.listNamespacedServiceAccount({ namespace }),
          timeoutMs,
          'list service accounts',
        ),
        withProbeTimeout(clients.rbac.listClusterRole({}), timeoutMs, 'list cluster roles'),
        withProbeTimeout(clients.rbac.listNamespacedRole({ namespace }), timeoutMs, 'list roles'),
        withProbeTimeout(
          clients.rbac.listClusterRoleBinding({}),
          timeoutMs,
          'list cluster role bindings',
        ),
        withProbeTimeout(
          clients.rbac.listNamespacedRoleBinding({ namespace }),
          timeoutMs,
          'list role bindings',
        ),
      ]);
  } catch (e) {
    return {
      status: 'fail',
      message: 'cannot list RBAC resources',
      detail: errorMessage(e),
    };
  }

  const saNames = new Set((saList.items ?? []).map((sa) => sa.metadata?.name ?? ''));
  const clusterRoleNames = new Set(
    (clusterRoleList.items ?? []).map((role) => role.metadata?.name ?? ''),
  );
  const roleNames = new Set((roleList.items ?? []).map((role) => role.metadata?.name ?? ''));
  const clusterRoleBindings = new Map(
    (clusterRoleBindingList.items ?? []).map((b) => [b.metadata?.name ?? '', b]),
  );
  const roleBindings = new Map(
    (roleBindingList.items ?? []).map((b) => [b.metadata?.name ?? '', b]),
  );

  const problems: string[] = [];

  for (const name of EXPECTED_SERVICE_ACCOUNTS) {
    if (!saNames.has(name)) problems.push(`ServiceAccount ${namespace}/${name} missing`);
  }
  for (const name of EXPECTED_CLUSTER_ROLES) {
    if (!clusterRoleNames.has(name)) problems.push(`ClusterRole ${name} missing`);
  }
  for (const name of EXPECTED_ROLES) {
    if (!roleNames.has(name)) problems.push(`Role ${namespace}/${name} missing`);
  }

  for (const expected of EXPECTED_CLUSTER_ROLE_BINDINGS) {
    const binding = clusterRoleBindings.get(expected.name);
    if (!binding) {
      problems.push(`ClusterRoleBinding ${expected.name} missing`);
      continue;
    }
    if (binding.roleRef?.kind !== 'ClusterRole' || binding.roleRef?.name !== expected.role) {
      problems.push(
        `ClusterRoleBinding ${expected.name}: roleRef should be ClusterRole/${expected.role}`,
      );
    }
    if (
      !(binding.subjects ?? []).some(
        (s) => s.kind === 'ServiceAccount' && s.name === expected.sa && s.namespace === namespace,
      )
    ) {
      problems.push(
        `ClusterRoleBinding ${expected.name}: missing subject ServiceAccount ${namespace}/${expected.sa}`,
      );
    }
  }

  for (const expected of EXPECTED_ROLE_BINDINGS) {
    const binding = roleBindings.get(expected.name);
    if (!binding) {
      problems.push(`RoleBinding ${namespace}/${expected.name} missing`);
      continue;
    }
    if (binding.roleRef?.kind !== 'Role' || binding.roleRef?.name !== expected.role) {
      problems.push(
        `RoleBinding ${namespace}/${expected.name}: roleRef should be Role/${expected.role}`,
      );
    }
    if (
      !(binding.subjects ?? []).some(
        (s) => s.kind === 'ServiceAccount' && s.name === expected.sa && s.namespace === namespace,
      )
    ) {
      problems.push(
        `RoleBinding ${namespace}/${expected.name}: missing subject ServiceAccount ${namespace}/${expected.sa}`,
      );
    }
  }

  if (problems.length === 0) {
    return { status: 'pass', message: 'RBAC wiring complete (SAs, roles, bindings, references)' };
  }
  return {
    status: 'fail',
    message: `${problems.length} RBAC problem(s)`,
    detail: problems.join('; '),
  };
}

// ---------------------------------------------------------------------------
// network-policy — the two NetworkPolicies exist; warn when the CNI cannot
// enforce them (default kind/minikube CNI — bearer token is the effective
// control). Name-based CNI heuristic: an unknown CNI always downgrades to a
// warning, never an error.

const EXPECTED_NETWORK_POLICIES = ['manager-ingress', 'memory-service-ingress'];

/** DaemonSet-name keywords for CNIs that enforce NetworkPolicy. */
const ENFORCING_CNI_KEYWORDS = ['calico', 'cilium', 'antrea', 'weave'];

export async function checkNetworkPolicy(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  let policyList: V1NetworkPolicyList;
  try {
    policyList = await withProbeTimeout(
      clients.networking.listNamespacedNetworkPolicy({ namespace }),
      timeoutMs,
      'list network policies',
    );
  } catch (e) {
    return {
      status: 'fail',
      message: 'cannot list NetworkPolicies',
      detail: errorMessage(e),
    };
  }

  const present = new Set((policyList.items ?? []).map((policy) => policy.metadata?.name ?? ''));
  const missing = EXPECTED_NETWORK_POLICIES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    return {
      status: 'fail',
      message: `${missing.length} NetworkPolicy missing (${missing.join(', ')})`,
      detail: 'apply k8s/deploy/networkpolicy.yaml',
    };
  }

  // CNI enforcement heuristic: look for an enforcing CNI's DaemonSet in
  // kube-system. Unknown CNIs (GKE Dataplane V2, Azure NPM, …) are treated as
  // non-enforcing and downgrade to a warning — never an error.
  let enforcingCni: string | undefined;
  try {
    const dsList = await withProbeTimeout(
      clients.apps.listNamespacedDaemonSet({ namespace: 'kube-system' }),
      timeoutMs,
      'list kube-system daemonsets',
    );
    const names = (dsList.items ?? []).map((ds) => ds.metadata?.name ?? '').filter(Boolean);
    enforcingCni = names.find((name) =>
      ENFORCING_CNI_KEYWORDS.some((keyword) => name.toLowerCase().includes(keyword)),
    );
  } catch {
    // Cannot determine the CNI — degrade to the non-enforcing warning path.
    enforcingCni = undefined;
  }

  if (enforcingCni) {
    return {
      status: 'pass',
      message: `${EXPECTED_NETWORK_POLICIES.join(', ')} present; enforcing CNI detected (${enforcingCni})`,
    };
  }
  return {
    status: 'warn',
    message: 'NetworkPolicies present but no enforcing CNI detected',
    detail:
      'default kind/minikube CNI does not enforce NetworkPolicy; the bearer token is the effective control (documented acceptable in k8s/deploy/networkpolicy.yaml)',
  };
}

// ---------------------------------------------------------------------------
// dns — CoreDNS is Available, control-plane Services have ready Endpoints, and
// (opt-in) `getent hosts` resolves the in-cluster DNS names from a live pod.

const DNS_SERVICES = ['percussionist-manager', 'percussionist-web', 'ollama'];

export interface ExecProbeOptions {
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  timeoutMs: number;
}

/** Exec a read-only command in a pod; resolves `{ ok, output }` (never throws). */
export type ExecProbe = (opts: ExecProbeOptions) => Promise<{ ok: boolean; output: string }>;

export interface DnsCheckOptions {
  namespace: string;
  timeoutMs: number;
  probeDns: boolean;
  /** Injectable exec probe (default: kubectl exec, like attach.ts). */
  execProbe?: ExecProbe;
}

export async function checkDns(
  clients: DoctorClients,
  opts: DnsCheckOptions,
): Promise<DoctorCheckResult> {
  const { namespace, timeoutMs, probeDns } = opts;
  const execProbe = opts.execProbe ?? kubectlExecProbe;
  const problems: string[] = [];
  const warnings: string[] = [];

  // 1. CoreDNS deployment is Available.
  let coredns: V1Deployment | undefined;
  try {
    coredns = await withProbeTimeout(
      clients.apps.readNamespacedDeployment({ name: 'coredns', namespace: 'kube-system' }),
      timeoutMs,
      'read coredns deployment',
    );
  } catch (e) {
    problems.push(`CoreDNS deployment kube-system/coredns unavailable: ${errorMessage(e)}`);
  }
  if (coredns) {
    const available = (coredns.status?.conditions ?? []).some(
      (c) => c.type === 'Available' && c.status === 'True',
    );
    const ready = (coredns.status?.readyReplicas ?? 0) >= 1;
    if (!available || !ready) {
      problems.push(
        `CoreDNS deployment kube-system/coredns not Available (availableReplicas=${coredns.status?.availableReplicas ?? 0})`,
      );
    }
  }

  // 2. Control-plane Services exist with ready Endpoints.
  for (const name of DNS_SERVICES) {
    let service: V1Service;
    try {
      service = await withProbeTimeout(
        clients.core.readNamespacedService({ name, namespace }),
        timeoutMs,
        `read service ${name}`,
      );
    } catch (e) {
      problems.push(`Service ${namespace}/${name} missing: ${errorMessage(e)}`);
      continue;
    }
    if (!service.metadata?.name) continue; // not found

    let endpoints: V1Endpoints;
    try {
      endpoints = await withProbeTimeout(
        clients.core.readNamespacedEndpoints({ name, namespace }),
        timeoutMs,
        `read endpoints ${name}`,
      );
    } catch (e) {
      problems.push(`Endpoints for ${namespace}/${name} missing: ${errorMessage(e)}`);
      continue;
    }
    const ready = (endpoints.subsets ?? []).some((subset) => (subset.addresses ?? []).length > 0);
    if (!ready) {
      problems.push(`Service ${namespace}/${name} has no ready endpoints`);
    }
  }

  // 3. Opt-in --probe-dns: exec getent hosts into a ready control-plane pod.
  const probeNotes: string[] = [];
  if (probeDns) {
    const pod = await findReadyControlPlanePod(clients, namespace, timeoutMs);
    if (!pod) {
      warnings.push('--probe-dns: no ready percussionist pod to exec into; skipped');
    } else {
      for (const name of DNS_SERVICES) {
        const fqdn = `${name}.${namespace}.svc.cluster.local`;
        try {
          const result = await execProbe({
            namespace,
            podName: pod.name,
            container: pod.container,
            command: ['getent', 'hosts', fqdn],
            timeoutMs,
          });
          if (result.ok) {
            probeNotes.push(`--probe-dns: ${fqdn} resolves in ${pod.name}`);
          } else {
            warnings.push(
              `--probe-dns: getent hosts ${fqdn} failed in ${pod.name}: ${result.output}`,
            );
          }
        } catch (e) {
          // RBAC/exec failures are best-effort — downgrade to a warning.
          warnings.push(`--probe-dns: exec into ${pod.name} failed: ${errorMessage(e)}`);
        }
      }
    }
  }

  if (problems.length === 0 && warnings.length === 0) {
    return {
      status: 'pass',
      message: 'CoreDNS Available; control-plane Services have ready endpoints',
      ...(probeNotes.length > 0 ? { detail: probeNotes.join('; ') } : {}),
    };
  }
  if (problems.length === 0) {
    return {
      status: 'warn',
      message: 'CoreDNS and Services healthy',
      detail: warnings.join('; '),
    };
  }
  return {
    status: 'fail',
    message: `${problems.length} DNS problem(s)`,
    detail: [...problems, ...warnings].join('; '),
  };
}

async function findReadyControlPlanePod(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<{ name: string; container: string } | undefined> {
  let podList: V1PodList;
  try {
    podList = await withProbeTimeout(
      clients.core.listNamespacedPod({
        namespace,
        labelSelector: 'app.kubernetes.io/name=percussionist',
      }),
      timeoutMs,
      'list control-plane pods',
    );
  } catch {
    return undefined;
  }
  for (const pod of podList.items ?? []) {
    if (pod.status?.phase !== 'Running') continue;
    const ready = (pod.status?.conditions ?? []).some(
      (c) => c.type === 'Ready' && c.status === 'True',
    );
    if (!ready) continue;
    const container = pod.spec?.containers?.[0]?.name;
    const name = pod.metadata?.name;
    if (name && container) return { name, container };
  }
  return undefined;
}

/** Default exec probe — spawns `kubectl exec`, mirroring the attach.ts pattern. */
export function kubectlExecProbe(opts: ExecProbeOptions): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [
      'exec',
      opts.podName,
      '-n',
      opts.namespace,
      '-c',
      opts.container,
      '--',
      ...opts.command,
    ];
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const settle = (ok: boolean, text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: text.trim() });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(false, `kubectl exec timed out after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (e) => settle(false, errorMessage(e)));
    child.on('exit', (code) => settle(code === 0, output));
  });
}

// ---------------------------------------------------------------------------
// storage — default StorageClass exists, web + per-project data PVCs are Bound,
// and the operator's DEFAULT_STORAGE_CLASS env resolves to a real StorageClass.

const WEB_DB_PVC = 'percussionist-web-db-v3';
const OPERATOR_DEPLOYMENT = 'percussionist-operator';
const DEFAULT_STORAGE_CLASS_ENV = 'DEFAULT_STORAGE_CLASS';
const DEFAULT_STORAGE_CLASS_FALLBACK = 'standard';

export async function checkStorage(
  clients: DoctorClients,
  namespace: string,
  timeoutMs: number,
): Promise<DoctorCheckResult> {
  let scList: V1StorageClassList;
  try {
    scList = await withProbeTimeout(
      clients.storage.listStorageClass({}),
      timeoutMs,
      'list storage classes',
    );
  } catch (e) {
    return {
      status: 'fail',
      message: 'cannot list StorageClasses',
      detail: errorMessage(e),
    };
  }
  const scNames = new Set(
    (scList.items ?? []).map((sc) => sc.metadata?.name ?? '').filter(Boolean),
  );
  const defaultSc = (scList.items ?? []).find(
    (sc) => sc.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
  );

  const problems: string[] = [];
  const warnings: string[] = [];

  if (!defaultSc) {
    warnings.push(
      'no StorageClass marked default (storageclass.kubernetes.io/is-default-class) — PVCs without an explicit storageClassName will not provision',
    );
  }

  // Web PVC.
  try {
    const pvc: V1PersistentVolumeClaim = await withProbeTimeout(
      clients.core.readNamespacedPersistentVolumeClaim({ name: WEB_DB_PVC, namespace }),
      timeoutMs,
      `read PVC ${WEB_DB_PVC}`,
    );
    const phase = pvc.status?.phase ?? 'Unknown';
    if (phase === 'Bound') {
      // ok
    } else if (phase === 'Pending') {
      warnings.push(`PVC ${namespace}/${WEB_DB_PVC} is Pending (storage provisioning in progress)`);
    } else if (phase === 'Lost' || phase === 'Failed') {
      problems.push(`PVC ${namespace}/${WEB_DB_PVC} is ${phase}`);
    } else {
      problems.push(`PVC ${namespace}/${WEB_DB_PVC} is ${phase}`);
    }
  } catch (e) {
    problems.push(`PVC ${namespace}/${WEB_DB_PVC} missing: ${errorMessage(e)}`);
  }

  // Per-project data PVCs.
  let projects: Project[];
  try {
    projects = await withProbeTimeout(listAllProjects(clients.custom), timeoutMs, 'list projects');
  } catch (e) {
    problems.push(`cannot list Projects: ${errorMessage(e)}`);
    projects = [];
  }
  for (const project of projects) {
    const projectName = project.metadata?.name;
    const projectNs = project.metadata?.namespace ?? namespace;
    if (!projectName) continue;
    const pvcName = `${projectName}-data`;
    try {
      const pvc: V1PersistentVolumeClaim = await withProbeTimeout(
        clients.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: projectNs }),
        timeoutMs,
        `read PVC ${pvcName}`,
      );
      const phase = pvc.status?.phase ?? 'Unknown';
      if (phase === 'Bound') {
        // ok
      } else if (phase === 'Pending') {
        warnings.push(`PVC ${projectNs}/${pvcName} is Pending (storage provisioning in progress)`);
      } else if (phase === 'Lost' || phase === 'Failed') {
        problems.push(`PVC ${projectNs}/${pvcName} is ${phase}`);
      } else {
        problems.push(`PVC ${projectNs}/${pvcName} is ${phase}`);
      }
    } catch (e) {
      problems.push(
        `PVC ${projectNs}/${pvcName} missing for project ${projectName}: ${errorMessage(e)}`,
      );
    }
  }

  // Operator DEFAULT_STORAGE_CLASS env resolves.
  let operatorStorageClass = DEFAULT_STORAGE_CLASS_FALLBACK;
  try {
    const deployment: V1Deployment = await withProbeTimeout(
      clients.apps.readNamespacedDeployment({ name: OPERATOR_DEPLOYMENT, namespace }),
      timeoutMs,
      `read deployment ${OPERATOR_DEPLOYMENT}`,
    );
    const env = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const found = env.find((entry) => entry.name === DEFAULT_STORAGE_CLASS_ENV)?.value;
    if (found && found.length > 0) operatorStorageClass = found;
  } catch (e) {
    problems.push(
      `cannot read operator deployment ${namespace}/${OPERATOR_DEPLOYMENT}: ${errorMessage(e)}`,
    );
  }
  if (!scNames.has(operatorStorageClass)) {
    problems.push(
      `operator ${DEFAULT_STORAGE_CLASS_ENV} resolves to "${operatorStorageClass}" but no such StorageClass exists`,
    );
  }

  if (problems.length === 0 && warnings.length === 0) {
    return {
      status: 'pass',
      message: 'default StorageClass present; web and project data PVCs Bound',
    };
  }
  if (problems.length === 0) {
    return {
      status: 'warn',
      message: 'storage provisioned with warnings',
      detail: warnings.join('; '),
    };
  }
  return {
    status: 'fail',
    message: `${problems.length} storage problem(s)`,
    detail: [...problems, ...warnings].join('; '),
  };
}

// ---------------------------------------------------------------------------
// Registry wiring — the five static checks, filterable via `--check`.

export const STATIC_CHECKS: DoctorCheck[] = [
  {
    name: 'crds',
    category: 'CRDs',
    run: (ctx) => checkCrds(ctx.clients, ctx.timeoutMs),
  },
  {
    name: 'rbac',
    category: 'RBAC',
    run: (ctx) => checkRbac(ctx.clients, ctx.namespace, ctx.timeoutMs),
  },
  {
    name: 'network-policy',
    category: 'NetworkPolicy',
    run: (ctx) => checkNetworkPolicy(ctx.clients, ctx.namespace, ctx.timeoutMs),
  },
  {
    name: 'dns',
    category: 'DNS',
    run: (ctx) =>
      checkDns(ctx.clients, {
        namespace: ctx.namespace,
        timeoutMs: ctx.timeoutMs,
        probeDns: ctx.probeDns,
      }),
  },
  {
    name: 'storage',
    category: 'Storage',
    run: (ctx) => checkStorage(ctx.clients, ctx.namespace, ctx.timeoutMs),
  },
];

function errorMessage(e: unknown): string {
  return ((e as { message?: string }).message ?? String(e)).trim();
}
