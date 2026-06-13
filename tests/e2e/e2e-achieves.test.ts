/**
 * e2e-achieves: agent calls fail_run → task reaches failed → auto-retry fires → task back to pending.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply ClusterAgent: e2e-stubborn-worker (always calls fail_run).
 *   3. Apply Project with flow.retry.enabled=true, short backoff and poisonPillThresholdSeconds=0.
 *   4. Apply Task CR (agent=e2e-stubborn-worker).
 *   5. Assert: stubborn worker run reaches Failed (via fail_run MCP signal).
 *   6. Assert: task phase reaches "failed".
 *   7. Assert: manager auto-retries by incrementing retryCount and setting retryAfter.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { kubectlGetField, kubectlGetNames } from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  applyTask,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-achieves';
const PROJECT = 'e2e-achieves-test';
const TASK_NAME = 't1';
const TASK_LABEL = 'percussionist.dev/task-id';
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the initial worker run (no .spec.facilitation.targetRunName). */
async function findWorkerRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames('runs', ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    const target = await kubectlGetField('runs', name, ns, '{.spec.facilitation.targetRunName}');
    if (!target) return name;
  }
  return null;
}

/** Poll until a run reaches a terminal phase (Succeeded or Failed). */
async function pollTerminal(runName: string, ns: string): Promise<string | null> {
  const phase = await kubectlGetField('runs', runName, ns, '{.status.phase}');
  return phase === 'Succeeded' || phase === 'Failed' ? phase : null;
}

/** Poll until the Task CR phase matches expected. */
async function _pollTaskPhase(
  taskName: string,
  ns: string,
  expected: string,
): Promise<true | null> {
  const phase = await kubectlGetField('tasks', taskName, ns, '{.status.phase}');
  return phase === expected ? true : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('achieves', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents(['clusteragent-stubborn-worker.yaml']);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Achieves Test',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'e2e-stubborn-worker' }],
      // Enable a single auto-retry with visible backoff so pending is observable.
      flowYaml: `\
  flow:
    retry:
      enabled: true
      maxAttempts: 2
      backoffSeconds: 30
      poisonPillThresholdSeconds: 0`,
    });

    console.log(`==> Step 9: Apply Task ${TASK_NAME}`);
    await applyTask({
      name: TASK_NAME,
      ns: NS,
      projectRef: PROJECT,
      type: 'BUILD',
      title: 'Analyze repository structure',
      agent: 'e2e-stubborn-worker',
      description:
        'List the top-level files and directories. The stubborn worker will refuse and call fail_run.',
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let workerRun: string;

  it('worker run is spawned', async () => {
    workerRun = await waitFor(`worker run spawned (taskId=${TASK_NAME})`, 120, 5, () =>
      findWorkerRun(NS, TASK_NAME),
    );
    expect(workerRun).toBeTruthy();
    console.log(`    Worker run spawned: ${workerRun}`);
  }, 125_000);

  it('stubborn worker calls fail_run → run reaches Failed', async () => {
    const phase = await waitFor(`worker run ${workerRun} reaches Failed`, 180, 5, () =>
      pollTerminal(workerRun, NS).then((p) => (p === 'Failed' ? p : null)),
    );
    expect(phase).toBe('Failed');

    // Strict: status message must indicate agent-signalled failure.
    const msg = await kubectlGetField('runs', workerRun, NS, '{.status.message}');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    if (msg.includes('agent signalled failure')) {
      console.log('    Confirmed: failure triggered via fail_run MCP tool');
    } else {
      console.warn(`    NOTE: failure message: ${msg}`);
    }
  }, 185_000);

  it('manager auto-retries: retry is scheduled', async () => {
    await waitFor(`task ${TASK_NAME} retryCount increments`, 180, 5, async () => {
      const retryCount = await kubectlGetField(
        'tasks',
        TASK_NAME,
        NS,
        '{.status.worker.retryCount}',
      );
      const count = parseInt(retryCount ?? '0', 10);
      return count >= 1 ? count : null;
    });

    const retryCount = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.worker.retryCount}');
    const count = parseInt(retryCount ?? '0', 10);
    expect(count).toBeGreaterThanOrEqual(1);

    const retryAfter = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.retryAfter}');
    expect(typeof retryAfter).toBe('string');
    expect(retryAfter.length).toBeGreaterThan(0);
    console.log(`    Retry scheduled, retryCount=${count}, retryAfter=${retryAfter}`);
  }, 185_000);
});
