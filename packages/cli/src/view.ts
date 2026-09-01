// `beatctl ls` / `beatctl get` — read-only views of Run resources.

import {
  API_GROUP,
  API_VERSION,
  DEFAULT_RUNNER_ENGINE,
  deriveEngine,
  PLURAL_RUN,
  type Run,
  runnerDefaultsFor,
} from '@percussionist/api';
import { age, DEFAULT_NAMESPACE, fatal, getRun, listRuns, loadKube, padCols } from './kube.js';

/**
 * `spec.image` carries a CRD-level default pointing at the opencode runner, so
 * it is populated on every Run and reading it as "the image this ran on" is
 * wrong whenever the engine is not opencode: pod-builder lets the engine's
 * image win precisely so `engine: claude` cannot silently run the opencode
 * runner. Printing the raw field made a claude-engine run look like an opencode
 * one, which is a difference worth several hours to anyone debugging it.
 *
 * The exact image can still come from ClusterSettings.spec.runnerAdapter.image,
 * which this read does not fetch — so name the engine default and say that it
 * is the engine's, rather than claiming to know the final value.
 */
function describeImage(spec: Run['spec']): string {
  const engine = deriveEngine(spec);
  if (engine === DEFAULT_RUNNER_ENGINE) return spec.image ?? '-';
  return `${runnerDefaultsFor(engine).image}  (${engine} engine default; spec.image ${spec.image ?? '-'} is overridden)`;
}

export interface LsOpts {
  namespace?: string;
  allNamespaces?: boolean;
}

export async function runLs(opts: LsOpts): Promise<void> {
  const { custom } = loadKube();
  const allNamespaces = opts.allNamespaces === true;
  let runs: Run[];
  try {
    if (allNamespaces) {
      // Cluster-wide listing via listClusterCustomObject (an empty namespace
      // argument to listNamespacedCustomObject is not valid). Previously the
      // -A flag was accepted but silently fell back to the default namespace.
      const res = (await custom.listClusterCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        plural: PLURAL_RUN,
      })) as { items?: Run[] };
      runs = res.items ?? [];
    } else {
      runs = await listRuns(custom, opts.namespace ?? DEFAULT_NAMESPACE);
    }
  } catch (e) {
    fatal('list failed', e);
  }

  if (runs.length === 0) {
    console.log(
      allNamespaces
        ? 'No Runs in any namespace.'
        : `No Runs in namespace ${opts.namespace ?? DEFAULT_NAMESPACE}.`,
    );
    return;
  }

  const rows: string[][] = allNamespaces
    ? [
        ['NAMESPACE', 'NAME', 'PHASE', 'SESSION', 'TOK-IN', 'TOK-OUT', 'AGE'],
        ...runs.map((r) => [
          r.metadata.namespace ?? '-',
          r.metadata.name,
          r.status?.phase ?? '-',
          r.status?.sessionID ?? '-',
          String(r.status?.tokensIn ?? 0),
          String(r.status?.tokensOut ?? 0),
          age(r.metadata.creationTimestamp),
        ]),
      ]
    : [
        ['NAME', 'PHASE', 'SESSION', 'TOK-IN', 'TOK-OUT', 'AGE'],
        ...runs.map((r) => [
          r.metadata.name,
          r.status?.phase ?? '-',
          r.status?.sessionID ?? '-',
          String(r.status?.tokensIn ?? 0),
          String(r.status?.tokensOut ?? 0),
          age(r.metadata.creationTimestamp),
        ]),
      ];
  console.log(padCols(rows));
}

export interface GetOpts {
  namespace?: string;
  output?: 'yaml' | 'json' | 'wide';
}

export async function runGet(name: string, opts: GetOpts): Promise<void> {
  const { custom } = loadKube();
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  let run: Run | undefined;
  try {
    run = await getRun(custom, ns, name);
  } catch (e) {
    fatal(`get ${name}`, e);
  }

  if (opts.output === 'json') {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (opts.output === 'yaml') {
    // Lazy-load yaml to avoid pulling it into hot paths unnecessarily.
    const YAML = (await import('yaml')).default;
    console.log(YAML.stringify(run));
    return;
  }

  // Default human-friendly view.
  const s = run.status ?? {};
  const lines = [
    `Name:        ${run.metadata.name}`,
    `Namespace:   ${run.metadata.namespace}`,
    `Phase:       ${s.phase ?? '-'}`,
    `Message:     ${s.message ?? '-'}`,
    `Pod:         ${s.podName ?? '-'}`,
    `Service:     ${s.serviceName ?? '-'}`,
    `Session:     ${s.sessionID ?? '-'}`,
    `Started:     ${s.startedAt ?? '-'}`,
    `Completed:   ${s.completedAt ?? '-'}`,
    `Tokens:      ${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out`,
    ``,
    `Spec:`,
    `  Task:      ${run.spec.task}`,
    `  Image:     ${describeImage(run.spec)}`,
    `  Engine:    ${deriveEngine(run.spec)}`,
    `  Agent:     ${run.spec.agent ?? '-'}`,
    `  Model:     ${run.spec.model ?? '-'}`,
    `  Timeout:   ${run.spec.timeoutSeconds ?? '-'}s`,
  ];
  console.log(lines.join('\n'));
}
