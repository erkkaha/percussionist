/**
 * e2e-interactive-run: start an auxiliary interactive run from a board Task.
 *
 * Deterministic extended E2E for the interactive-run feature (plan
 * percussionist-dev-plan-6b7ffa). The manager MCP tool
 * `start_interactive_run` is the sole control point: it writes the
 * `percussionist.dev/action-interactive` annotation, the reconciler's
 * interactive pass builds the Run via `buildWorkerRun({ interactive: true })`,
 * and the operator creates the pod. Interactive runs never auto-prompt an LLM
 * (the dispatcher idles until a terminal attaches), so every assertion is on
 * CR fields / Kubernetes objects — never model prose.
 *
 * Scenario:
 *   1. Shared cluster setup + deterministic ClusterAgent.
 *   2. Apply a git-source Project with featureBranchingEnabled so the task has
 *      a resolvable branch, then a BUILD Task held in `pending` by a
 *      never-satisfied predecessorRef (so the reconciler never schedules a
 *      normal worker run).
 *   3. Invoke the manager MCP `start_interactive_run` with an explicit timeout
 *      override.
 *   4. Assert the created Run CR carries:
 *        - spec.interactive === true
 *        - spec.boardTask === task name
 *        - label percussionist.dev/task-id === task name
 *        - spec.source.git.ref === the task branch (feature/<task>)
 *        - spec.agent === the task agent
 *        - spec.timeoutSeconds === the requested override
 *        - no spec.task (interactive runs skip the auto-prompt)
 *      and that the action annotation was consumed by the reconciler.
 *   5. Assert Task.status.phase and Task.status.worker.runName are unchanged.
 *   6. Delete the Run and assert the operator spawned the
 *      `cleanup-ttl-<runName>` worktree cleanup Job.
 *   7. afterAll teardown(NS).
 *
 * Depends on the interactive contract being merged (shared api contract +
 * builder options, reconciler interactive pass, manager MCP tool). Registered
 * automatically in `e2e:extended` (the suite runs `tests/e2e/`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  deleteResource,
  kubectl,
  kubectlApply,
  kubectlExec,
  kubectlGetField,
  kubectlGetJSONSilent,
  kubectlGetNames,
} from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  OPERATOR_NS,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-interactive-run';
const PROJECT = 'e2e-interactive-run-test';
const TASK_NAME = 'interactive-t1';
const AGENT = 'e2e-complete-worker';
const BRANCH = `feature/${TASK_NAME}`;
const TIMEOUT_SECONDS = 120;
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';
const INTERACTIVE_ANNOTATION = 'percussionist.dev/action-interactive';
const TASK_ID_LABEL = 'percussionist.dev/task-id';

/** Minimal Run shape needed for the assertions. */
interface RunLike {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    interactive?: boolean;
    boardTask?: string;
    task?: string;
    agent?: string;
    timeoutSeconds?: number;
    source?: { git?: { ref?: string; parentRef?: string } };
  };
}

/** Minimal Task shape needed for the assertions. */
interface TaskLike {
  metadata: { annotations?: Record<string, string> };
  status?: { phase?: string; worker?: { runName?: string } };
}

async function getRun(runName: string): Promise<RunLike | null> {
  return await kubectlGetJSONSilent<RunLike>('runs', runName, NS);
}

async function getTask(): Promise<TaskLike | null> {
  return await kubectlGetJSONSilent<TaskLike>('tasks', TASK_NAME, NS);
}

/**
 * Mirrors the job-name derivation in `packages/operator/src/ttl.ts`
 * (`buildCleanupJob`): `cleanup-ttl-<runName>`, lowercased, non-alphanumerics
 * replaced with `-`, then truncated to the 63-char DNS label limit. A long
 * project + task name can hit the truncation, so replicate it exactly rather
 * than assuming the untruncated form exists.
 */
function cleanupJobName(runName: string): string {
  return `cleanup-ttl-${runName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Manager MCP helper
// ---------------------------------------------------------------------------

/**
 * Call a manager MCP tool (e.g. `start_interactive_run`) via the manager pod's
 * in-process MCP server on 127.0.0.1:4097. Loopback callers are authorized
 * without a bearer token, so `kubectl exec` into the manager pod is enough.
 * Returns the tool's JSON text result; throws when the tool reports an error.
 */
async function callManagerTool(name: string, args: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const b64 = Buffer.from(payload).toString('base64');
  const script = [
    'const b = process.argv[1];',
    "const body = Buffer.from(b, 'base64').toString('utf8');",
    "fetch('http://127.0.0.1:4097/mcp', {",
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json' },",
    '  body,',
    '})',
    '  .then((r) => r.text())',
    '  .then((t) => { console.log(t); process.exit(0); })',
    '  .catch((e) => { console.error(String(e)); process.exit(1); });',
  ].join('\n');

  const out = await kubectlExec(OPERATOR_NS, 'deployment/percussionist-manager', 'manager', [
    'node',
    '-e',
    script,
    b64,
  ]);

  const response = JSON.parse(out) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  const result = response.result;
  if (!result) {
    throw new Error(`manager MCP ${name}: no result in response: ${out.slice(0, 500)}`);
  }
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) {
    throw new Error(`manager MCP ${name}: ${text}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('interactive-run', () => {
  let runName = '';
  let phaseBefore = '';
  let workerRunBefore = '';

  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents(['clusteragent-complete-worker.yaml']);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Interactive Run Test',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: AGENT }],
      // Distinguishable from the per-run override below.
      timeoutSeconds: 300,
      sourceYaml: `\
  source:
    git:
      # Intentionally invalid URL — the interactive Run CR is still created;
      # the init container only fails later, which the assertions ignore.
      url: https://git.invalid/e2e-interactive-run.git`,
    });

    // Feature branching gives the standalone BUILD task a resolvable branch
    // (`feature/<task>`), which the interactive builder must check out.
    await kubectl([
      'patch',
      'project',
      PROJECT,
      '-n',
      NS,
      '--type=merge',
      '-p',
      JSON.stringify({ spec: { featureBranchingEnabled: true } }),
    ]);

    console.log(`==> Step 9: Apply Task ${TASK_NAME} (held by missing predecessor)`);
    // predecessorRef points at a Task that never exists, so decidePending keeps
    // the task in `pending` and the manager never schedules a real worker run.
    await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: Task
metadata:
  name: ${TASK_NAME}
  namespace: ${NS}
  labels:
    percussionist.dev/project: ${PROJECT}
spec:
  projectRef: ${PROJECT}
  type: BUILD
  title: "Interactive-run E2E task"
  agent: ${AGENT}
  predecessorRef: pred-hold
`);

    // The reconciler assigns the default `pending` phase; wait for it so the
    // before/after comparison starts from a settled state.
    await waitFor(`task ${TASK_NAME} reported a phase`, 60, 2, async () => {
      const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
      return phase || null;
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  it('start_interactive_run creates an interactive Run without moving the task', async () => {
    phaseBefore = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    workerRunBefore = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.worker.runName}');
    expect(phaseBefore).toBe('pending');
    expect(workerRunBefore).toBe('');

    const text = await callManagerTool('start_interactive_run', {
      project: PROJECT,
      task: TASK_NAME,
      timeoutSeconds: TIMEOUT_SECONDS,
      namespace: NS,
    });
    console.log(`    start_interactive_run result: ${text}`);

    const parsed = JSON.parse(text) as { runName?: string };
    expect(parsed.runName).toBeTruthy();
    runName = parsed.runName ?? '';

    // The reconciler creates the Run from the annotation on its next pass.
    await waitFor(`interactive run ${runName} created`, 120, 3, async () => {
      const run = await getRun(runName);
      return run ? runName : null;
    });

    // Starting an auxiliary run must not disturb the task's pipeline state.
    const phaseAfter = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    const workerRunAfter = await kubectlGetField(
      'tasks',
      TASK_NAME,
      NS,
      '{.status.worker.runName}',
    );
    expect(phaseAfter).toBe(phaseBefore);
    expect(workerRunAfter).toBe(workerRunBefore);
    console.log(`    Task ${TASK_NAME} unchanged (phase=${phaseAfter})`);
  }, 150_000);

  it('the interactive Run carries the task contract', async () => {
    const run = await getRun(runName);
    expect(run).not.toBeNull();
    if (!run) throw new Error(`interactive run ${runName} disappeared`);

    expect(run.spec.interactive).toBe(true);
    expect(run.spec.boardTask).toBe(TASK_NAME);
    // Interactive runs skip the auto-prompt entirely.
    expect(run.spec.task ?? '').toBe('');
    expect(run.metadata.labels?.[TASK_ID_LABEL]).toBe(TASK_NAME);
    expect(run.spec.agent).toBe(AGENT);
    // Per-run override wins over the project default (300).
    expect(run.spec.timeoutSeconds).toBe(TIMEOUT_SECONDS);
    // The run works on the task's feature branch.
    expect(run.spec.source?.git?.ref).toBe(BRANCH);

    // The Run is discoverable through the same label the task Runs list uses.
    const names = await kubectlGetNames('runs', NS, `${TASK_ID_LABEL}=${TASK_NAME}`);
    expect(names).toContain(runName);

    // The reconciler consumed the request annotation (so it won't recreate the
    // run on the next pass).
    const task = await getTask();
    expect(task?.metadata.annotations?.[INTERACTIVE_ANNOTATION]).toBeUndefined();

    console.log(`    Run ${runName}: interactive, boardTask=${TASK_NAME}, ref=${BRANCH}`);
  }, 30_000);

  it('deleting the interactive Run triggers worktree cleanup', async () => {
    await deleteResource('runs', runName, NS);

    // The operator's Run-delete hook spawns a deterministically named
    // `cleanup-ttl-<runName>` Job for any git-source run. Its creation is the
    // deterministic cleanup signal (the Job itself may sit Pending if the data
    // PVC has no provisioner).
    const cleanupJob = cleanupJobName(runName);
    await waitFor(`worktree cleanup job ${cleanupJob} created`, 120, 3, async () => {
      const job = await kubectlGetJSONSilent<{ metadata: { name: string } }>(
        'jobs',
        cleanupJob,
        NS,
      );
      return job ? cleanupJob : null;
    });

    const job = await kubectlGetJSONSilent<{ metadata: { name: string } }>('jobs', cleanupJob, NS);
    expect(job?.metadata.name).toBe(cleanupJob);
    console.log(`    Cleanup job ${cleanupJob} spawned`);
  }, 150_000);
});
