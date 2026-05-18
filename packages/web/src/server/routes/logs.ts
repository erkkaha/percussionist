import { Hono } from "hono";
import { core, getRun, readPodLog } from "../kube.js";
import { RUNNER_CONTAINER, DISPATCHER_CONTAINER, GIT_CLONE_CONTAINER } from "@percussionist/api";

const BOOTSTRAP_CONTAINER = "bootstrap";
const BOOTSTRAP_EXCLUDE = new Set([RUNNER_CONTAINER, DISPATCHER_CONTAINER]);

const VALID_CONTAINERS = new Set([
  RUNNER_CONTAINER,
  DISPATCHER_CONTAINER,
  GIT_CLONE_CONTAINER,
  BOOTSTRAP_CONTAINER,
]);
// Extract a human-readable message from a @kubernetes/client-node error.
// The library throws errors whose `.message` contains a raw HTTP dump like:
//   "HTTP-Code: 400\nMessage: ...\nBody: "{\"message\":\"container ... waiting\"}"
// This helper parses the JSON body out of that string when present.
function kubeErrMsg(e: unknown): string {
  const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
  if (anyE.body?.message) return anyE.body.message;
  const raw = anyE.message ?? String(e);
  // Try to extract the JSON body embedded in the multi-line error string.
  // The k8s client serialises the body as a JSON-stringified string, so we
  // need two levels of JSON.parse to get back to the original object.
  const bodyMatch = raw.match(/\nBody: (".*")\nHeaders:/s);
  if (bodyMatch?.[1]) {
    try {
      const bodyStr = JSON.parse(bodyMatch[1]) as string;
      const parsed = JSON.parse(bodyStr) as { message?: string };
      if (parsed?.message) return parsed.message;
    } catch { /* ignore */ }
  }
  return raw;
}

const DEFAULT_TAIL = 500;
const logs = new Hono();

async function readLogBlock(
  podName: string,
  container: string,
  tailLines?: number,
  ns?: string,
): Promise<string> {
  try {
    const text = await readPodLog(podName, container, tailLines || undefined, ns);
    if (!text.trim()) return `===== ${container} =====\n(no output)`;
    return `===== ${container} =====\n${text}`;
  } catch (e: unknown) {
    return `===== ${container} =====\n(unavailable: ${kubeErrMsg(e)})`;
  }
}

async function listBootstrapContainers(
  podName: string,
  ns: string,
): Promise<string[]> {
  try {
    const pod = await core().readNamespacedPod({ name: podName, namespace: ns });
    const initNames = (pod.spec?.initContainers ?? []).map((c) => c.name).filter(Boolean);
    const appNames = (pod.spec?.containers ?? [])
      .map((c) => c.name)
      .filter((name): name is string => !!name && !BOOTSTRAP_EXCLUDE.has(name));
    const seen = new Set<string>();
    return [...initNames, ...appNames].filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  } catch {
    return [GIT_CLONE_CONTAINER];
  }
}

// GET /api/runs/:name/logs?container=opencode&tailLines=500
//
// container defaults to "opencode" but can be "dispatcher", "workspace-init",
// or "bootstrap" (combined startup logs from workspace-init/opencode/dispatcher).
// When the requested container is still waiting (init failed, pod never
// started) and no explicit container was requested, we auto-fall-back to
// the workspace-init init container so the caller always gets useful output.
logs.get("/:name/logs", async (c) => {
  const name = c.req.param("name");
  const explicitContainer = c.req.query("container");
  const container = explicitContainer ?? RUNNER_CONTAINER;
  const tailParam = c.req.query("tailLines");
  const tailLines = tailParam ? parseInt(tailParam, 10) : DEFAULT_TAIL;

  if (!VALID_CONTAINERS.has(container)) {
    return c.json(
      { error: `Invalid container: ${container}. Must be one of: ${[...VALID_CONTAINERS].join(", ")}` },
      400,
    );
  }

  // Resolve podName from the run's status (or fall back to the run name).
  let podName: string;
  let ns: string;
  try {
    const run = await getRun(name);
    podName = run.status?.podName ?? name;
    ns = run.metadata.namespace ?? "percussionist";
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number };
    const status = anyE.statusCode === 404 ? 404 : 500;
    return c.json({ error: kubeErrMsg(e) }, status);
  }

  if (container === BOOTSTRAP_CONTAINER) {
    const bootstrapContainers = await listBootstrapContainers(podName, ns);
    if (bootstrapContainers.length === 0) {
      return c.json({
        podName,
        container,
        lines: "No bootstrap containers found for this pod.",
        bootstrapContainers,
      });
    }
    const blocks = await Promise.all(
      bootstrapContainers.map((name) =>
        readLogBlock(podName, name, tailLines || undefined, ns),
      ),
    );
    return c.json({
      podName,
      container,
      lines: blocks.join("\n\n"),
      bootstrapContainers,
    });
  }

  try {
    const text = await readPodLog(podName, container, tailLines || undefined, ns);
    return c.json({ podName, container, lines: text });
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };

    // If the main container was never started (init container failure) and
    // the caller didn't explicitly request a specific container, automatically
    // retry with the workspace-init init container — that's where the failure is.
    const errStr = kubeErrMsg(e);
    const isWaiting =
      !explicitContainer &&
      (anyE.statusCode === 400 || String(e).includes("400")) &&
      errStr.includes("waiting to start");

    if (isWaiting) {
      try {
        const initText = await readPodLog(
          podName,
          GIT_CLONE_CONTAINER,
          tailLines || undefined,
          ns,
        );
        return c.json({ podName, container: GIT_CLONE_CONTAINER, lines: initText });
      } catch {
        // Fall through to the original error below.
      }
    }

    const status = anyE.statusCode === 404 ? 404 : anyE.statusCode === 400 ? 400 : 500;
    return c.json({ error: errStr }, status);
  }
});

export default logs;
