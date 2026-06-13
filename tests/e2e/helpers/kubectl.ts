/**
 * Typed kubectl wrappers.
 * All functions shell out to `kubectl` via Bun.spawn.
 */

export class KubectlError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`kubectl ${args.join(' ')} exited ${exitCode}: ${stderr.trim()}`);
  }
}

/** Run kubectl with the given args. Returns trimmed stdout. Throws on non-zero exit. */
export async function kubectl(args: string[]): Promise<string> {
  const proc = Bun.spawn(['kubectl', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new KubectlError(args, exitCode, stderr);
  }
  return stdout.trim();
}

/**
 * Run kubectl, returning stdout or null on non-zero exit (instead of throwing).
 * Useful inside polling loops.
 */
export async function kubectlSilent(args: string[]): Promise<string | null> {
  try {
    return await kubectl(args);
  } catch {
    return null;
  }
}

/**
 * Apply a YAML string via `kubectl apply -f -`.
 * Pipes the YAML to stdin.
 */
export async function kubectlApply(yaml: string): Promise<void> {
  const proc = Bun.spawn(['kubectl', 'apply', '-f', '-'], {
    stdin: new TextEncoder().encode(yaml),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new KubectlError(['apply', '-f', '-'], exitCode, stderr);
  }
}

/** Apply one or more YAML files by path. */
export async function kubectlApplyFile(path: string, serverSide = false): Promise<void> {
  const args = ['apply', '-f', path];
  if (serverSide) args.push('--server-side');
  await kubectlSilent(args); // warnings about unchanged resources are fine
}

/** Get a jsonpath field from a resource. Returns empty string if not found. */
export async function kubectlGetField(
  kind: string,
  name: string,
  ns: string,
  jsonpath: string,
): Promise<string> {
  return (await kubectlSilent(['get', kind, name, '-n', ns, `-o`, `jsonpath=${jsonpath}`])) ?? '';
}

/** List resource names matching an optional label selector. */
export async function kubectlGetNames(
  kind: string,
  ns: string,
  labelSelector?: string,
): Promise<string[]> {
  const args = ['get', kind, '-n', ns, '--no-headers', '-o', 'custom-columns=NAME:.metadata.name'];
  if (labelSelector) args.push('-l', labelSelector);
  const out = await kubectlSilent(args);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `kubectl set env deployment/<name> -n <ns> KEY=VALUE ...` */
export async function kubectlSetEnv(
  deployment: string,
  ns: string,
  envPairs: Record<string, string>,
): Promise<void> {
  const pairs = Object.entries(envPairs).map(([k, v]) => `${k}=${v}`);
  await kubectl(['set', 'env', `deployment/${deployment}`, '-n', ns, ...pairs]);
}

/** `kubectl rollout status deployment/<name> -n <ns> --timeout=<s>s` */
export async function kubectlRolloutStatus(
  deployment: string,
  ns: string,
  timeoutSec: number,
): Promise<void> {
  await kubectl([
    'rollout',
    'status',
    `deployment/${deployment}`,
    '-n',
    ns,
    `--timeout=${timeoutSec}s`,
  ]);
}

/** `kubectl get namespace <ns>` — returns true if it exists. */
export async function namespaceExists(ns: string): Promise<boolean> {
  const out = await kubectlSilent(['get', 'namespace', ns]);
  return out !== null;
}

/** `kubectl create namespace <ns>` if it doesn't already exist. */
export async function ensureNamespace(ns: string): Promise<void> {
  if (!(await namespaceExists(ns))) {
    await kubectl(['create', 'namespace', ns]);
  }
}

/** `kubectl delete namespace <ns> --ignore-not-found --wait=false` */
export async function deleteNamespace(ns: string): Promise<void> {
  await kubectlSilent(['delete', 'namespace', ns, '--ignore-not-found', '--wait=false']);
}

/** `kubectl delete <kind> <name> --ignore-not-found` */
export async function deleteResource(kind: string, name: string, ns?: string): Promise<void> {
  const args = ['delete', kind, name, '--ignore-not-found'];
  if (ns) args.push('-n', ns);
  await kubectlSilent(args);
}

/**
 * Query the board JSON for a project via the web pod's internal HTTP API.
 * Returns parsed JSON or an empty object on failure.
 */
export async function boardJson(
  project: string,
  operatorNs: string,
): Promise<Record<string, unknown>> {
  const out = await kubectlSilent([
    'exec',
    '-n',
    operatorNs,
    'deployment/percussionist-web',
    '-c',
    'web',
    '--',
    'wget',
    '-qO-',
    `http://127.0.0.1:8080/api/board/${project}`,
  ]);
  if (!out) return {};
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Create (or replace) the LLM keys secret from environment variables.
 * Falls back to a placeholder if no API keys are set.
 */
export async function createLLMSecret(ns: string, secretName: string): Promise<void> {
  const literals: string[] = [];
  if (process.env.ANTHROPIC_API_KEY)
    literals.push(`--from-literal=ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  if (process.env.OPENAI_API_KEY)
    literals.push(`--from-literal=OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
  if (process.env.GITHUB_TOKEN)
    literals.push(`--from-literal=GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
  if (literals.length === 0) literals.push('--from-literal=PLACEHOLDER=unused');

  // dry-run + pipe to apply so it's idempotent
  const dryRun = Bun.spawn(
    [
      'kubectl',
      '-n',
      ns,
      'create',
      'secret',
      'generic',
      secretName,
      ...literals,
      '--dry-run=client',
      '-o',
      'yaml',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [yaml, drStderr, drExit] = await Promise.all([
    new Response(dryRun.stdout).text(),
    new Response(dryRun.stderr).text(),
    dryRun.exited,
  ]);
  if (drExit !== 0) throw new KubectlError(['create', 'secret', '...'], drExit, drStderr);
  await kubectlApply(yaml);
}

// ---------------------------------------------------------------------------
// Pod exec
// ---------------------------------------------------------------------------

/**
 * Execute a command inside a pod container.
 *
 * @param namespace   Kubernetes namespace.
 * @param target      Pod name or `deployment/<name>` / `pod/<name>`.
 * @param container   Optional container name (defaults to first container).
 * @param command     Command and arguments to run inside the container.
 * @returns           Trimmed stdout. Throws KubectlError on non-zero exit.
 */
export async function kubectlExec(
  namespace: string,
  target: string,
  container: string | undefined,
  command: string[],
): Promise<string> {
  const args = ['exec', '-n', namespace, target, '--'];
  if (container) args.splice(3, 0, '-c', container);
  // Insert -- before the user command so kubectl doesn't interpret flags as its own.
  const fullArgs = [...args, ...command];

  const proc = Bun.spawn(['kubectl', ...fullArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new KubectlError(fullArgs, exitCode, stderr);
  }
  return stdout.trim();
}

/**
 * Execute a command inside a pod container and return trimmed stdout, or null on failure.
 */
export async function kubectlExecSilent(
  namespace: string,
  target: string,
  container: string | undefined,
  command: string[],
): Promise<string | null> {
  try {
    return await kubectlExec(namespace, target, container, command);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------

/**
 * Run a kubectl subcommand that produces JSON (e.g. `-o json`), parse it, and return the object.
 * Throws KubectlError on non-zero exit or invalid JSON.
 */
export async function kubectlGetJSON<T = unknown>(
  kind: string,
  name: string,
  ns: string,
): Promise<T> {
  const raw = await kubectl(['get', kind, name, '-n', ns, '-o', 'json']);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new KubectlError(
      ['get', kind, name, '-n', ns, '-o', 'json'],
      -1,
      `Invalid JSON response: ${raw.slice(0, 256)}`,
    );
  }
}

/**
 * Run a kubectl subcommand that produces JSON and return it or null on failure.
 */
export async function kubectlGetJSONSilent<T = unknown>(
  kind: string,
  name: string,
  ns: string,
): Promise<T | null> {
  try {
    return await kubectlGetJSON<T>(kind, name, ns);
  } catch {
    return null;
  }
}

/**
 * Strictly parse a JSON string. Throws KubectlError with context on failure.
 */
export function parseKubectlJSON<T = unknown>(raw: string, label?: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (_cause) {
    const snippet = raw.slice(0, 256).replace(/\n/g, '\\n');
    throw new KubectlError(['parse'], -1, `${label ? `${label}: ` : ''}Invalid JSON: ${snippet}`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics helpers (for failure snapshots)
// ---------------------------------------------------------------------------

/**
 * Describe a resource by name/kind/namespace — returns the full JSON representation.
 */
export async function describeResource(kind: string, name: string, ns: string): Promise<string> {
  return await kubectl(['describe', kind, name, '-n', ns]);
}

/**
 * Describe a resource or return "(not found)" if it doesn't exist.
 */
export async function describeResourceSilent(
  kind: string,
  name: string,
  ns: string,
): Promise<string> {
  const out = await kubectlSilent(['describe', kind, name, '-n', ns]);
  return out ?? '(not found)';
}

/**
 * Collect logs for a run pod. Returns up to `tailLines` lines per container.
 */
export async function logsForRun(
  runName: string,
  ns: string,
  options?: { container?: string; tailLines?: number },
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  // Get the pod name for this run (runs are typically pods with matching names)
  const podName = await kubectlGetField('pods', runName, ns, '{.metadata.name}');
  if (!podName) {
    return result;
  }

  // List containers in the pod
  const containerNamesRaw = await kubectlSilent([
    'get',
    'pod',
    runName,
    '-n',
    ns,
    '-o',
    "jsonpath={range .spec.containers[*]}{.name}{'\\n'}{end}",
  ]);

  const containers =
    containerNamesRaw
      ?.split('\n')
      .map((c) => c.trim())
      .filter(Boolean) ?? [];

  for (const container of containers) {
    if (options?.container && options.container !== container) continue;
    try {
      const _tailFlag = options?.tailLines ? `--tail=${options.tailLines}` : '';
      const logs = await kubectlExec(ns, runName, container, [
        'sh',
        '-c',
        `cat /tmp/opencode/session.log 2>/dev/null || echo "no session log"`,
      ]);
      result[container] = logs;
    } catch {
      // Some containers may not have the expected log path — skip gracefully.
      try {
        const logs = await kubectlExec(ns, runName, container, [
          'sh',
          '-c',
          `cat /tmp/opencode/session.log 2>/dev/null || echo "no session log"`,
        ]);
        result[container] = logs;
      } catch {
        result[container] = '(unable to read logs)';
      }
    }
  }

  return result;
}

/**
 * List events in a namespace, optionally filtered by a field selector.
 */
export async function listEvents(
  ns: string,
  options?: { sinceSeconds?: number; fieldSelector?: string },
): Promise<Record<string, unknown>[]> {
  const args = ['get', 'events', '-n', ns, '-o', 'json'];
  if (options?.sinceSeconds) {
    // kubectl doesn't support --since-seconds with -o json directly; filter client-side.
  }
  if (options?.fieldSelector) {
    args.push(`--field-selector=${options.fieldSelector}`);
  }

  const raw = await kubectl(args);
  const parsed = parseKubectlJSON<{ items: Record<string, unknown>[] }>(raw, 'events');
  return parsed.items;
}

/**
 * List recent events in a namespace (last N seconds), formatted as summary strings.
 */
export async function listEventsSummary(ns: string, _sinceSeconds = 3600): Promise<string[]> {
  const args = [
    'get',
    'events',
    '-n',
    ns,
    '--sort-by=.lastTimestamp',
    `-o`,
    `custom-columns=TIMESTAMP:.lastTimestamp,REASON:.reason,NAMESPACE:.involvedObject.namespace,KIND:.involvedObject.kind,NAME:.involvedObject.name,MESSAGE:.message`,
  ];

  const out = await kubectlSilent(args);
  if (!out) return [];

  // Skip the header line
  const lines = out.split('\n').slice(1).filter(Boolean);
  return lines.map((l) => l.trim());
}

/**
 * Gather a failure snapshot: describe key resources + recent events.
 * Useful for debugging test failures in CI artifacts.
 */
export async function gatherFailureSnapshot(opts: {
  ns: string;
  project?: string;
  taskIds?: string[];
}): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  // Events
  snapshot.events = await listEventsSummary(opts.ns);

  // Project status
  if (opts.project) {
    try {
      snapshot[`project/${opts.project}`] = await describeResource(
        'projects',
        opts.project,
        opts.ns,
      );
    } catch {
      snapshot[`project/${opts.project}`] = '(not found)';
    }
  }

  // Task statuses
  if (opts.taskIds?.length) {
    for (const tid of opts.taskIds) {
      try {
        snapshot[`task/${tid}`] = await describeResource('tasks', tid, opts.ns);
      } catch {
        snapshot[`task/${tid}`] = '(not found)';
      }
    }
  }

  // Run statuses (all runs in namespace)
  try {
    const runNames = await kubectlGetNames('runs', opts.ns);
    for (const rn of runNames.slice(-10)) {
      // Last 10 runs to avoid bloating the snapshot
      try {
        snapshot[`run/${rn}`] = await describeResource('runs', rn, opts.ns);
      } catch {
        snapshot[`run/${rn}`] = '(describe failed)';
      }
    }
  } catch {
    snapshot.runs = '(unable to list runs)';
  }

  return snapshot;
}
