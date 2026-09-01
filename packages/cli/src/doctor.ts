// doctor.ts — `beatctl doctor` — read-only cluster diagnostics.
//
// The command audits the whole control plane (CRDs, RBAC, NetworkPolicy, DNS,
// storage, credentials, providers, models, dashboard, component health) using
// only get/list API verbs plus bounded network probes. It is modeled on
// validate.ts: per-category check functions return typed results, and
// `runDoctor(opts, deps)` collects them into a report with injectable deps
// (API-client builder, connectivity probe, check registry, log) so the report
// logic is unit-testable without a cluster.
//
// Exit codes:
//   0 — all checks pass
//   1 — at least one check failed
//   2 — cluster unreachable / fatal connection error (no report produced)
//
// Read-only guarantee: the orchestrator itself only performs a discovery
// `getAPIResources` connectivity probe; every check function is responsible
// for staying read-only (get/list verbs + bounded probes), and `--probe-dns`
// is the only opt-in in-pod exec (a read-only `getent hosts`).

import { errorMessage } from '@percussionist/kube';
import { PLATFORM_CHECKS } from './doctor-platform.js';
import { RUNTIME_CHECKS } from './doctor-runtime.js';
import { STATIC_CHECKS } from './doctor-static.js';
import { withProbeTimeout } from './doctor-util.js';
import type { DoctorClients } from './k8s-clients.js';
import { doctorClients } from './k8s-clients.js';
import { DEFAULT_NAMESPACE } from './kube.js';

// Re-export for check modules that historically imported it from here; new
// code should import from doctor-util.js directly to avoid a cycle.
export { withProbeTimeout };

export const DoctorExitCode = {
  Ok: 0,
  Fail: 1,
  Fatal: 2,
} as const;

export type DoctorExitCode = (typeof DoctorExitCode)[keyof typeof DoctorExitCode];

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckResult {
  status: DoctorCheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorCheckContext {
  /** Namespace to inspect (default: percussionist). */
  namespace: string;
  /** Lazy-built K8s API clients (core/apps/custom + the discovery clients). */
  clients: DoctorClients;
  /** Per-probe timeout in ms (`--timeout` × 1000). */
  timeoutMs: number;
  /** True when `--probe-dns` was passed (opt-in exec-based DNS probes). */
  probeDns: boolean;
  /** Line logger (console.log by default; injected in tests). */
  log: (line: string) => void;
}

/** A single diagnostic check. `name` is the `--check` filter key. */
export interface DoctorCheck {
  name: string;
  /** Category heading in the text report (e.g. 'CRDs'). */
  category: string;
  run: (ctx: DoctorCheckContext) => Promise<DoctorCheckResult> | DoctorCheckResult;
}

/**
 * Default check registry. The five static checks (crds, rbac, network-policy,
 * dns, storage) come from doctor-static.ts, the three runtime checks
 * (credentials, providers, models) from doctor-runtime.ts, and the two
 * platform checks (dashboard, health) from doctor-platform.ts. The
 * orchestrator only iterates whatever is registered here (or injected via
 * `runDoctor` deps).
 */
export const DEFAULT_CHECKS: DoctorCheck[] = [
  ...STATIC_CHECKS,
  ...RUNTIME_CHECKS,
  ...PLATFORM_CHECKS,
];

export const DEFAULT_PROBE_TIMEOUT_SEC = 30;

export interface DoctorOpts {
  namespace?: string;
  /** `--check` — run only these named checks (repeatable). */
  check?: string[];
  /** `--json` — emit a machine-readable report instead of the text report. */
  json?: boolean;
  /** `--probe-dns` — opt-in exec of `getent hosts` into a ready pod. */
  probeDns?: boolean;
  /** `--timeout <seconds>` — per-probe timeout (default 30). */
  timeout?: number;
}

export interface DoctorDeps {
  log?: (line: string) => void;
  /**
   * Build the K8s API clients. A throw here means no cluster is configured
   * (kubeconfig load failure / no active cluster) — fatal, exit 2.
   * Default: `doctorClients()`.
   */
  loadClients?: () => DoctorClients;
  /**
   * Cheap connectivity probe run before any check. A throw here means the
   * cluster is unreachable — fatal, exit 2. Default: a discovery
   * `getAPIResources` call (open to any authenticated user).
   */
  probeConnection?: (ctx: DoctorCheckContext) => Promise<void>;
  /** Check registry override (default: DEFAULT_CHECKS). */
  checks?: DoctorCheck[];
}

export interface DoctorJsonReport {
  command: 'doctor';
  version: 1;
  namespace: string;
  timeoutSec: number;
  probeDns: boolean;
  /** `--check` names that matched no registered check. */
  unknownChecks: string[];
  checks: Array<{
    name: string;
    category: string;
    status: DoctorCheckStatus;
    message: string;
    detail?: string;
  }>;
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
  };
  exitCode: DoctorExitCode;
}

export async function runDoctor(opts: DoctorOpts = {}, deps: DoctorDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const timeoutSec = opts.timeout ?? DEFAULT_PROBE_TIMEOUT_SEC;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(`invalid --timeout value: ${String(opts.timeout)}`);
  }
  const timeoutMs = timeoutSec * 1000;

  const { selected, unknown } = selectChecks(deps.checks ?? DEFAULT_CHECKS, opts.check);

  let clients: DoctorClients;
  try {
    clients = deps.loadClients ? deps.loadClients() : doctorClients();
  } catch (e) {
    console.error(`beatctl: doctor: cannot build Kubernetes clients: ${errorMessage(e)}`);
    process.exitCode = DoctorExitCode.Fatal;
    return;
  }

  const ctx: DoctorCheckContext = {
    namespace,
    clients,
    timeoutMs,
    probeDns: Boolean(opts.probeDns),
    log,
  };

  try {
    await (deps.probeConnection ?? defaultProbeConnection)(ctx);
  } catch (e) {
    console.error(`beatctl: doctor: cluster unreachable: ${errorMessage(e)}`);
    process.exitCode = DoctorExitCode.Fatal;
    return;
  }

  const entries: Array<{ check: DoctorCheck; result: DoctorCheckResult }> = [];
  for (const check of selected) {
    try {
      const result = await check.run(ctx);
      entries.push({ check, result });
    } catch (e) {
      entries.push({
        check,
        result: { status: 'fail', message: `check threw: ${errorMessage(e)}` },
      });
    }
  }

  const exitCode: DoctorExitCode = entries.some((entry) => entry.result.status === 'fail')
    ? DoctorExitCode.Fail
    : DoctorExitCode.Ok;

  if (opts.json) {
    log(
      JSON.stringify(
        buildJsonReport(namespace, timeoutSec, Boolean(opts.probeDns), unknown, entries, exitCode),
        null,
        2,
      ),
    );
  } else {
    printTextReport(log, namespace, timeoutSec, unknown, entries, exitCode);
  }

  process.exitCode = exitCode;
}

async function defaultProbeConnection(ctx: DoctorCheckContext): Promise<void> {
  // Discovery endpoint — granted to every authenticated user via the default
  // system:discovery ClusterRole, so a scoped kubeconfig still proves
  // reachability without tripping an RBAC 403.
  await withProbeTimeout(ctx.clients.core.getAPIResources({}), ctx.timeoutMs, 'connectivity probe');
}

function selectChecks(
  registry: DoctorCheck[],
  filter?: string[],
): { selected: DoctorCheck[]; unknown: string[] } {
  if (!filter || filter.length === 0) return { selected: [...registry], unknown: [] };
  const wanted = new Set(filter);
  const available = new Set(registry.map((check) => check.name));
  const unknown = filter.filter((name) => !available.has(name));
  return { selected: registry.filter((check) => wanted.has(check.name)), unknown };
}

function tally(entries: Array<{ result: DoctorCheckResult }>): {
  pass: number;
  warn: number;
  fail: number;
} {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const { result } of entries) {
    if (result.status === 'pass') pass += 1;
    else if (result.status === 'warn') warn += 1;
    else fail += 1;
  }
  return { pass, warn, fail };
}

function buildJsonReport(
  namespace: string,
  timeoutSec: number,
  probeDns: boolean,
  unknown: string[],
  entries: Array<{ check: DoctorCheck; result: DoctorCheckResult }>,
  exitCode: DoctorExitCode,
): DoctorJsonReport {
  const { pass, warn, fail } = tally(entries);
  return {
    command: 'doctor',
    version: 1,
    namespace,
    timeoutSec,
    probeDns,
    unknownChecks: unknown,
    checks: entries.map(({ check, result }) => ({
      name: check.name,
      category: check.category,
      status: result.status,
      message: result.message,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    })),
    summary: { total: entries.length, pass, warn, fail },
    exitCode,
  };
}

function printTextReport(
  log: (line: string) => void,
  namespace: string,
  timeoutSec: number,
  unknown: string[],
  entries: Array<{ check: DoctorCheck; result: DoctorCheckResult }>,
  exitCode: DoctorExitCode,
): void {
  const { pass, warn, fail } = tally(entries);

  log('Percussionist cluster doctor');
  log(`  Namespace: ${namespace}`);
  log(`  Probe timeout: ${timeoutSec}s`);
  log('');
  log('Summary');
  log(`  Checks run: ${entries.length}`);
  log(`  Pass: ${pass}`);
  log(`  Warnings: ${warn}`);
  log(`  Failures: ${fail}`);
  if (unknown.length > 0) {
    log(`  Unknown --check names: ${unknown.join(', ')}`);
  }
  log('');
  log('Category details');

  const byCategory = new Map<string, Array<{ check: DoctorCheck; result: DoctorCheckResult }>>();
  for (const entry of entries) {
    const group = byCategory.get(entry.check.category) ?? [];
    group.push(entry);
    byCategory.set(entry.check.category, group);
  }
  for (const [category, group] of byCategory) {
    log('');
    log(`${category} (${group.length})`);
    for (const { result } of group) {
      const prefix = result.status === 'pass' ? 'pass' : result.status === 'warn' ? 'warn' : 'fail';
      const detail = result.detail !== undefined ? ` — ${result.detail}` : '';
      log(`  - [${prefix}] ${result.message}${detail}`);
    }
  }

  log('');
  if (exitCode === DoctorExitCode.Ok) {
    log('No problems found.');
    log('Result: PASS (exit 0)');
  } else {
    log(`Result: FAIL — ${fail} failing check(s) (exit 1)`);
  }
}
