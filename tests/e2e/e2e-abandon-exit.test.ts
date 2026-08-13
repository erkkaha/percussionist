/**
 * e2e-abandon-exit: a task parked on `waiting-for-input` is abandoned by a
 * human via the `percussionist.dev/action-abandon` annotation and reaches `done`.
 *
 * This exercises the abandon exit added for `waiting-for-input` in the board
 * deadlock fix: TRANSITION_TABLE now allows `waiting-for-input → done` and
 * decideWaitingForInput consumes the abandon annotation (mirroring
 * decideAwaitingHuman). The test is deterministic — the task never runs an LLM
 * agent, and asserts only CR status fields (Task.status.phase and
 * Task.status.worker.abandoned), never model output.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply ClusterAgent (project roster) + Project.
 *   3. Apply Task CR with a never-satisfied predecessorRef so the manager
 *      never schedules a real worker run while the test drives it manually.
 *   4. Create a parked interactive Run CR (non-terminal — the dispatcher idles
 *      in interactive mode, no prompt, no LLM calls) and point
 *      task.status.worker.runName at it.
 *   5. Drive the task to `waiting-for-input` via the manager's `set_task_state`
 *      MCP tool (admin) — the deterministic control point.
 *   6. Patch `percussionist.dev/action-abandon: "true"` — the human exit.
 *   7. Assert Task.status.phase reaches `done` with worker.abandoned === true.
 *   8. afterAll teardown(NS).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { kubectl, kubectlApply, kubectlExec, kubectlGetField } from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  OPERATOR_NS,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-abandon-exit';
const PROJECT = 'e2e-abandon-exit-test';
const TASK_NAME = 't1';
const RUN_NAME = 't1-parked-run';
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';

// ---------------------------------------------------------------------------
// Manager MCP helper
// ---------------------------------------------------------------------------

/**
 * Call a manager MCP tool (e.g. `set_task_state`) via the manager pod's
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
// Setup helpers
// ---------------------------------------------------------------------------

/**
 * Create the parked interactive Run CR and wait for it to reach a non-terminal
 * phase. `interactive: true` makes the dispatcher idle instead of prompting an
 * LLM agent, so the run stays parked (never Succeeded/Failed) for the whole
 * test. The status.phase is then nudged to WaitingForInput to represent a run
 * parked on a question — the scenario the abandon exit targets.
 */
async function createParkedRun(ns: string): Promise<void> {
  await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: ${RUN_NAME}
  namespace: ${ns}
  labels:
    percussionist.dev/project: ${PROJECT}
    percussionist.dev/task-id: ${TASK_NAME}
spec:
  project: ${PROJECT}
  interactive: true
  agent: e2e-complete-worker
  secrets:
    llmKeysSecret: ${LLM_SECRET}
  timeoutSeconds: 300
`);

  await waitFor(`run ${RUN_NAME} reaches a non-terminal phase`, 120, 3, async () => {
    const phase = await kubectlGetField('runs', RUN_NAME, ns, '{.status.phase}');
    if (phase === 'Succeeded' || phase === 'Failed' || phase === 'Cancelled') {
      throw new Error(`parked run ${RUN_NAME} reached unexpected terminal phase ${phase}`);
    }
    return phase ? phase : null;
  });

  // Cosmetic: mark the run as parked on a question (non-terminal either way).
  await kubectl([
    'patch',
    'run',
    RUN_NAME,
    '-n',
    ns,
    '--type=merge',
    '--subresource=status',
    '-p',
    JSON.stringify({ status: { phase: 'WaitingForInput' } }),
  ]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('abandon-exit', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents(['clusteragent-complete-worker.yaml']);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Abandon Exit Test',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'e2e-complete-worker' }],
    });

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
  title: "Abandon-exit E2E task"
  agent: e2e-complete-worker
  predecessorRef: pred-hold
`);

    console.log(`==> Step 10: Create parked run ${RUN_NAME}`);
    await createParkedRun(NS);

    console.log(`==> Step 11: Point task ${TASK_NAME} at the parked run`);
    await kubectl([
      'patch',
      'task',
      TASK_NAME,
      '-n',
      NS,
      '--type=merge',
      '--subresource=status',
      '-p',
      JSON.stringify({ status: { worker: { runName: RUN_NAME } } }),
    ]);
  });

  afterAll(async () => {
    await teardown(NS);
  });

  it('task is driven to waiting-for-input via set_task_state', async () => {
    const result = await callManagerTool('set_task_state', {
      project: PROJECT,
      task: TASK_NAME,
      targetPhase: 'waiting-for-input',
      admin: true,
      namespace: NS,
    });
    console.log(`    set_task_state result: ${result}`);

    await waitFor(`task ${TASK_NAME} phase=waiting-for-input`, 60, 3, async () => {
      const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
      return phase === 'waiting-for-input' ? phase : null;
    });
    const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    expect(phase).toBe('waiting-for-input');
    console.log(`    Task ${TASK_NAME} is parked on waiting-for-input`);
  }, 90_000);

  it('abandon annotation drives the task to done', async () => {
    // The human exit: write the abandon annotation on the Task CR.
    await kubectl([
      'annotate',
      'task',
      TASK_NAME,
      '-n',
      NS,
      'percussionist.dev/action-abandon=true',
    ]);

    await waitFor(`task ${TASK_NAME} phase=done`, 240, 3, async () => {
      const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
      if (phase === 'failed') {
        throw new Error(`task ${TASK_NAME} failed instead of reaching done`);
      }
      return phase === 'done' ? phase : null;
    });

    const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    expect(phase).toBe('done');

    // The abandon exit marks the worker as intentionally abandoned (distinct
    // from normal completion, which leaves worker.abandoned unset).
    const abandoned = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.worker.abandoned}');
    expect(abandoned).toBe('true');
    console.log(`    Task ${TASK_NAME} abandoned and reached done`);
  }, 250_000);
});
