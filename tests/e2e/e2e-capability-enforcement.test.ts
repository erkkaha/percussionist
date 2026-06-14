/**
 * e2e-capability-enforcement: strict assignment/tool gating prevents wrong-tool retry loops.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply deterministic agents: one incompatible reviewer-only, one wrong-tool worker.
 *   3. Apply Project that includes both in roster.
 *   4. Assert BUILD task with reviewer-only agent is rejected at creation time.
 *   5. Create BUILD task with wrong-tool worker and assert run fails (tool call rejected).
 *   6. Assert no retry scheduling occurs from wrong-tool failure (loop cannot recur).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  kubectlApply,
  kubectlExecSilent,
  kubectlGetField,
  kubectlGetNames,
  kubectlRolloutStatus,
} from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  applyWebDeployment,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-capability-enforcement';
const PROJECT = 'e2e-capability-enforcement-test';
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';
const TASK_LABEL = 'percussionist.dev/task-id';
const WRONG_TOOL_TASK = 'wrong-tool-build';

async function findWorkerRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames('runs', ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField('runs', name, ns, '{.spec.facilitation.targetRunName}');
    if (!target) return name;
  }
  return null;
}

async function createBoardTaskViaWeb(payload: Record<string, unknown>): Promise<string | null> {
  const escaped = JSON.stringify(payload).replaceAll("'", `'"'"'`);
  return await kubectlExecSilent(NS, 'deployment/percussionist-web', undefined, [
    'sh',
    '-lc',
    `wget -qS -O- --header='Content-Type: application/json' --post-data='${escaped}' http://127.0.0.1:8080/api/projects/${PROJECT}/board/tasks 2>&1`,
  ]);
}

describe('capability-enforcement', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      'clusteragent-reviewer-approve.yaml',
      'clusteragent-wrong-tool-worker.yaml',
    ]);

    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Capability Enforcement',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'reviewer-approve' }, { name: 'e2e-wrong-tool-worker' }],
      flowYaml: `\
  flow:
    retry:
      enabled: false`,
    });

    await applyWebDeployment(NS);
    await kubectlRolloutStatus('percussionist-web', NS, 120);
  });

  afterAll(async () => {
    await teardown(NS);
  });

  it('rejects incompatible BUILD agent assignment at task creation API boundary', async () => {
    const output = await createBoardTaskViaWeb({
      type: 'BUILD',
      title: 'Incompatible agent should be rejected',
      agent: 'reviewer-approve',
    });

    expect(output).not.toBeNull();
    expect(output ?? '').toContain('HTTP/1.1 400');
    expect(output ?? '').toContain('missing required capability "task.build.execute"');
  });

  it('wrong completion tool is rejected and retry loop does not recur', async () => {
    await kubectlApply(`\
apiVersion: percussionist.dev/v1alpha1
kind: Task
metadata:
  name: ${WRONG_TOOL_TASK}
  namespace: ${NS}
  labels:
    percussionist.dev/project: ${PROJECT}
spec:
  projectRef: ${PROJECT}
  type: BUILD
  title: "Wrong tool call should fail closed"
  agent: e2e-wrong-tool-worker
`);

    const workerRun = await waitFor(`worker run spawned (${WRONG_TOOL_TASK})`, 120, 5, () =>
      findWorkerRun(NS, WRONG_TOOL_TASK),
    );
    expect(workerRun).toBeTruthy();

    await waitFor(`wrong-tool worker run reaches Failed`, 180, 5, async () => {
      const phase = await kubectlGetField('runs', workerRun, NS, '{.status.phase}');
      return phase === 'Failed' ? phase : null;
    });

    const runMsg = await kubectlGetField('runs', workerRun, NS, '{.status.message}');
    expect(runMsg).toContain('complete_review');
    expect(runMsg).toContain('not allowed in context');

    await waitFor(`task ${WRONG_TOOL_TASK} reaches failed`, 180, 5, async () => {
      const phase = await kubectlGetField('tasks', WRONG_TOOL_TASK, NS, '{.status.phase}');
      return phase === 'failed' ? phase : null;
    });

    const retryAfter = await kubectlGetField('tasks', WRONG_TOOL_TASK, NS, '{.status.retryAfter}');
    expect(retryAfter).toBe('');
    const retryCount = await kubectlGetField(
      'tasks',
      WRONG_TOOL_TASK,
      NS,
      '{.status.worker.retryCount}',
    );
    expect(retryCount === '' || retryCount === '0').toBe(true);

    const runNames = await kubectlGetNames('runs', NS, `${TASK_LABEL}=${WRONG_TOOL_TASK}`);
    expect(runNames.length).toBe(1);
  }, 190_000);
});
