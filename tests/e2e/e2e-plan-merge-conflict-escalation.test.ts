/**
 * e2e-plan-merge-conflict-escalation: structured merge conflict verdict escalates PLAN to awaiting-human.
 *
 * Scenario:
 *   1. Shared cluster setup.
 *   2. Apply deterministic merge agent that always calls complete_merge(outcome=conflict).
 *   3. Apply Project and PLAN task.
 *   4. Patch PLAN task to awaiting-feature-merge so the manager schedules a merge run.
 *   5. Assert: merge run reaches Succeeded (agent completed with structured conflict verdict).
 *   6. Assert: PLAN task transitions to awaiting-human (not done).
 *   7. Assert: Task.status.worker.mergedAt remains unset and mergeError is populated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { kubectl, kubectlGetField, kubectlGetNames } from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  applyTask,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-plan-merge-conflict';
const PROJECT = 'e2e-plan-merge-conflict-test';
const TASK_NAME = 'plan-1';
const TASK_LABEL = 'percussionist.dev/task-id';
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';

async function findMergeRun(ns: string, taskId: string): Promise<string | null> {
  const names = await kubectlGetNames('runs', ns, `${TASK_LABEL}=${taskId}`);
  for (const name of names) {
    if (name.startsWith(`${PROJECT}-merge-`)) return name;
  }
  return null;
}

describe('plan-merge-conflict-escalation', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents(['clusteragent-merge-conflict-integrator.yaml']);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E PLAN Merge Conflict Escalation',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'merge-conflict-integrator' }],
      sourceYaml: `\
  source:
    local: true`,
      flowYaml: `\
  flow:
    merge:
      agent: merge-conflict-integrator`,
    });

    console.log(`==> Step 9: Apply PLAN Task ${TASK_NAME}`);
    await applyTask({
      name: TASK_NAME,
      ns: NS,
      projectRef: PROJECT,
      type: 'PLAN',
      title: 'Conflict escalation path',
      agent: 'merge-conflict-integrator',
      description: 'Deterministic PLAN merge conflict escalation test.',
    });

    console.log('==> Step 10: Force task into awaiting-feature-merge to schedule merge run');
    await kubectl([
      'patch',
      'task',
      TASK_NAME,
      '-n',
      NS,
      '--subresource=status',
      '--type=merge',
      '-p',
      JSON.stringify({
        status: {
          phase: 'awaiting-feature-merge',
          worker: {
            status: 'Running',
            mergeRunName: null,
            mergeError: null,
            mergedAt: null,
          },
        },
      }),
    ]);
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let mergeRun: string;

  it('merge run is spawned and reaches Succeeded', async () => {
    mergeRun = await waitFor(`merge run spawned (taskId=${TASK_NAME})`, 120, 3, () =>
      findMergeRun(NS, TASK_NAME),
    );
    expect(mergeRun).toBeTruthy();
    console.log(`    Merge run spawned: ${mergeRun}`);

    await waitFor(`merge run ${mergeRun} reaches Succeeded`, 180, 3, async () => {
      const phase = await kubectlGetField('runs', mergeRun, NS, '{.status.phase}');
      if (phase === 'Failed') throw new Error('Merge run reached Failed unexpectedly');
      return phase === 'Succeeded' ? phase : null;
    });
  }, 185_000);

  it('PLAN task escalates to awaiting-human with mergeError and no mergedAt', async () => {
    await waitFor(`task ${TASK_NAME} phase=awaiting-human`, 180, 3, async () => {
      const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
      return phase === 'awaiting-human' ? phase : null;
    });

    const phase = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.phase}');
    expect(phase).toBe('awaiting-human');
    expect(phase).not.toBe('done');

    const mergedAt = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.worker.mergedAt}');
    expect(mergedAt).toBe('');

    const mergeError = await kubectlGetField('tasks', TASK_NAME, NS, '{.status.worker.mergeError}');
    expect(mergeError).toContain('merge-conflict-integrator: conflict requires human resolution');
  }, 185_000);
});
