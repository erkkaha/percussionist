/**
 * e2e-advances: agent calls complete_run → review run is spawned → task advances to awaiting-human.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply ClusterAgents: e2e-complete-worker, reviewer-approve.
 *   3. Apply Project with flow.build.onSuccess=ai-review and flow.review.agent=reviewer-approve.
 *   4. Apply Task CR (type=BUILD, agent=e2e-complete-worker).
 *   5. Assert: worker run reaches Succeeded via complete_run MCP tool.
 *   6. Assert: review run is spawned with correct metadata (validates manager triggers AI-review flow).
 *   7. Assert: task phase reaches awaiting-human (manager transitions out of reviewing).
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

const NS = 'percussionist-e2e-advances';
const PROJECT = 'e2e-advances-test';
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

/** Find the review run targeting a specific worker run. */
async function findReviewRun(
  ns: string,
  taskId: string,
  workerRun: string,
): Promise<string | null> {
  const names = await kubectlGetNames('runs', ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    if (name === workerRun) continue;
    const target = await kubectlGetField('runs', name, ns, '{.spec.facilitation.targetRunName}');
    if (target === workerRun) return name;
  }
  return null;
}

/** Poll until the Task CR phase = "awaiting-human". */
async function pollTaskAwaitingHuman(taskName: string, ns: string): Promise<true | null> {
  const phase = await kubectlGetField('tasks', taskName, ns, '{.status.phase}');
  return phase === 'awaiting-human' ? true : null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('advances', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      'clusteragent-complete-worker.yaml',
      'clusteragent-reviewer-approve.yaml',
    ]);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Advances Test',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'e2e-complete-worker' }, { name: 'reviewer-approve' }],
      flowYaml: `\
  flow:
    build:
      onSuccess: ai-review
    review:
      aiReviewerEnabled: true
      agent: reviewer-approve`,
    });

    console.log(`==> Step 9: Apply Task ${TASK_NAME}`);
    await applyTask({
      name: TASK_NAME,
      ns: NS,
      projectRef: PROJECT,
      type: 'BUILD',
      title: 'Write a greeting',
      agent: 'e2e-complete-worker',
      description: 'Write a short greeting message to the user.',
    });
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let workerRun: string;
  it('worker run is spawned', async () => {
    workerRun = await waitFor(`worker run spawned (taskId=${TASK_NAME})`, 120, 3, () =>
      findWorkerRun(NS, TASK_NAME),
    );
    expect(workerRun).toBeTruthy();
    console.log(`    Worker run spawned: ${workerRun}`);
  }, 125_000);

  it('worker run reaches Succeeded via complete_run', async () => {
    await waitFor(`worker run ${workerRun} reaches Succeeded`, 180, 3, async () => {
      const phase = await kubectlGetField('runs', workerRun, NS, '{.status.phase}');
      if (phase === 'Failed') throw new Error(`Worker run reached Failed unexpectedly`);
      return phase === 'Succeeded' ? phase : null;
    });
    // Strict: status message must confirm completion via complete_run MCP tool.
    const msg = await kubectlGetField('runs', workerRun, NS, '{.status.message}');
    expect(msg).toContain('agent signalled completion');
  }, 185_000);

  let reviewRun: string;
  it('review run is spawned', async () => {
    reviewRun = await waitFor(`review run spawned for worker ${workerRun}`, 180, 3, () =>
      findReviewRun(NS, TASK_NAME, workerRun),
    );
    expect(reviewRun).toBeTruthy();
    console.log(`    Review run spawned: ${reviewRun}`);

    // Strict: review run must reference the exact worker run.
    const target = await kubectlGetField(
      'runs',
      reviewRun,
      NS,
      '{.spec.facilitation.targetRunName}',
    );
    expect(target).toBe(workerRun);

    // Strict: successReview flag must be true.
    const successReview = await kubectlGetField(
      'runs',
      reviewRun,
      NS,
      '{.spec.facilitation.successReview}',
    );
    expect(successReview).toBe('true');
  }, 185_000);

  it('task reaches awaiting-human', async () => {
    await waitFor(`task ${TASK_NAME} phase=awaiting-human`, 180, 3, () =>
      pollTaskAwaitingHuman(TASK_NAME, NS),
    );
    const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    expect(phase).toBe('awaiting-human');
  }, 185_000);
});
