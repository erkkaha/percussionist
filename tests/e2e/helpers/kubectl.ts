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
    super(`kubectl ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
  }
}

/** Run kubectl with the given args. Returns trimmed stdout. Throws on non-zero exit. */
export async function kubectl(args: string[]): Promise<string> {
  const proc = Bun.spawn(["kubectl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
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
  const proc = Bun.spawn(["kubectl", "apply", "-f", "-"], {
    stdin: new TextEncoder().encode(yaml),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new KubectlError(["apply", "-f", "-"], exitCode, stderr);
  }
}

/** Apply one or more YAML files by path. */
export async function kubectlApplyFile(path: string, serverSide = false): Promise<void> {
  const args = ["apply", "-f", path];
  if (serverSide) args.push("--server-side");
  await kubectlSilent(args); // warnings about unchanged resources are fine
}

/** Get a jsonpath field from a resource. Returns empty string if not found. */
export async function kubectlGetField(
  kind: string,
  name: string,
  ns: string,
  jsonpath: string,
): Promise<string> {
  return (
    (await kubectlSilent([
      "get",
      kind,
      name,
      "-n",
      ns,
      `-o`,
      `jsonpath=${jsonpath}`,
    ])) ?? ""
  );
}

/** List resource names matching an optional label selector. */
export async function kubectlGetNames(
  kind: string,
  ns: string,
  labelSelector?: string,
): Promise<string[]> {
  const args = [
    "get",
    kind,
    "-n",
    ns,
    "--no-headers",
    "-o",
    "custom-columns=NAME:.metadata.name",
  ];
  if (labelSelector) args.push("-l", labelSelector);
  const out = await kubectlSilent(args);
  if (!out) return [];
  return out
    .split("\n")
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
  await kubectl(["set", "env", `deployment/${deployment}`, "-n", ns, ...pairs]);
}

/** `kubectl rollout status deployment/<name> -n <ns> --timeout=<s>s` */
export async function kubectlRolloutStatus(
  deployment: string,
  ns: string,
  timeoutSec: number,
): Promise<void> {
  await kubectl([
    "rollout",
    "status",
    `deployment/${deployment}`,
    "-n",
    ns,
    `--timeout=${timeoutSec}s`,
  ]);
}

/** `kubectl get namespace <ns>` — returns true if it exists. */
export async function namespaceExists(ns: string): Promise<boolean> {
  const out = await kubectlSilent(["get", "namespace", ns]);
  return out !== null;
}

/** `kubectl create namespace <ns>` if it doesn't already exist. */
export async function ensureNamespace(ns: string): Promise<void> {
  if (!(await namespaceExists(ns))) {
    await kubectl(["create", "namespace", ns]);
  }
}

/** `kubectl delete namespace <ns> --ignore-not-found --wait=false` */
export async function deleteNamespace(ns: string): Promise<void> {
  await kubectlSilent(["delete", "namespace", ns, "--ignore-not-found", "--wait=false"]);
}

/** `kubectl delete <kind> <name> --ignore-not-found` */
export async function deleteResource(
  kind: string,
  name: string,
  ns?: string,
): Promise<void> {
  const args = ["delete", kind, name, "--ignore-not-found"];
  if (ns) args.push("-n", ns);
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
    "exec",
    "-n",
    operatorNs,
    "deployment/percussionist-web",
    "-c",
    "web",
    "--",
    "wget",
    "-qO-",
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
  if (process.env["ANTHROPIC_API_KEY"])
    literals.push(`--from-literal=ANTHROPIC_API_KEY=${process.env["ANTHROPIC_API_KEY"]}`);
  if (process.env["OPENAI_API_KEY"])
    literals.push(`--from-literal=OPENAI_API_KEY=${process.env["OPENAI_API_KEY"]}`);
  if (process.env["GITHUB_TOKEN"])
    literals.push(`--from-literal=GITHUB_TOKEN=${process.env["GITHUB_TOKEN"]}`);
  if (literals.length === 0) literals.push("--from-literal=PLACEHOLDER=unused");

  // dry-run + pipe to apply so it's idempotent
  const dryRun = Bun.spawn(
    [
      "kubectl",
      "-n",
      ns,
      "create",
      "secret",
      "generic",
      secretName,
      ...literals,
      "--dry-run=client",
      "-o",
      "yaml",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [yaml, drStderr, drExit] = await Promise.all([
    new Response(dryRun.stdout).text(),
    new Response(dryRun.stderr).text(),
    dryRun.exited,
  ]);
  if (drExit !== 0) throw new KubectlError(["create", "secret", "..."], drExit, drStderr);
  await kubectlApply(yaml);
}
