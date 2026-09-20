/**
 * e2e-pr-stage-scope-change: deterministic PR-stage scope-change wiring.
 *
 * Scenario:
 *   1. Shared cluster setup (operator + manager watching the e2e namespace).
 *   2. Apply deterministic ClusterAgents for the PLAN worker and BUILD child.
 *   3. Apply a feature-branching Project with `flow.integration.mode=pr`.
 *   4. Apply a PLAN task, then force it into `awaiting-feature-merge` with
 *      `worker.prNumber` set. `source.local` means there is no GitHub URL, so
 *      the manager cannot poll and `prState` stays undefined.
 *   5. Write `action-request-changes` + `action-rework-feedback` annotations.
 *   6. Assert: exactly one follow-up BUILD child appears with
 *      `spec.parentTaskRef` = PLAN, agent = `flow.build.defaultAgent`, high
 *      priority, and the human feedback in its description.
 *   7. Assert: the PLAN moves to `awaiting-children`, records the child in
 *      `worker.createdBuildTaskRefs`, and consumes both annotations.
 *
 * This test exercises the human request-changes path in the PR stage
 * (`decidePrStateOutcome` -> `prFollowUpDecision`). It is deterministic: it
 * depends only on CR status/annotations, never on model output, and never on a
 * reachable GitHub API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  kubectl,
  kubectlGetField,
  kubectlGetJSONSilent,
  kubectlGetNames,
} from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  applyTask,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-pr-stage-scope-change';
const PROJECT = 'e2e-pr-stage-scope-change';
const PLAN_TASK = 'plan-pr-stage';
const PROJECT_LABEL = 'percussionist.dev/project';
const REQUEST_CHANGES_KEY = 'percussionist.dev/action-request-changes';
const REWORK_FEEDBACK_KEY = 'percussionist.dev/action-rework-feedback';
const PLAN_AGENT = 'plan-complete';
const DEFAULT_AGENT = 'e2e-complete-worker';
const PR_NUMBER = 4242;
const FEEDBACK = 'Add a --verbose flag and document it in the README.';
const LLM_SECRET = process.env.LLM_SECRET ?? 'llm-keys';

/** Minimal shape of the Task fields this test inspects. */
interface TaskLike {
  metadata: {
    name: string;
    annotations?: Record<string, string>;
  };
  spec: {
    type?: string;
    parentTaskRef?: string;
    agent?: string;
    priority?: string;
    description?: string;
  };
  status?: {
    phase?: string;
    worker?: {
      prNumber?: number;
      createdBuildTaskRefs?: string[];
    };
  };
}

/**
 * Force the PLAN task into the PR stage with an open PR number. The manager
 * ignores a task in `awaiting-feature-merge` with `prNumber` set and no
 * annotations, so this status sticks.
 */
async function forcePrStage(): Promise<boolean> {
  try {
    await kubectl([
      'patch',
      'task',
      PLAN_TASK,
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
            prNumber: PR_NUMBER,
            prFeedbackRunName: null,
          },
        },
      }),
    ]);
  } catch {
    return false;
  }
  const phase = await kubectlGetField('tasks', PLAN_TASK, NS, '{.status.phase}');
  const prNumber = await kubectlGetField('tasks', PLAN_TASK, NS, '{.status.worker.prNumber}');
  return phase === 'awaiting-feature-merge' && prNumber === String(PR_NUMBER);
}

/** Write the canonical human request-changes annotations on the PLAN task. */
async function writeRequestChanges(): Promise<void> {
  await kubectl([
    'patch',
    'task',
    PLAN_TASK,
    '-n',
    NS,
    '--type=merge',
    '-p',
    JSON.stringify({
      metadata: {
        annotations: {
          [REQUEST_CHANGES_KEY]: 'true',
          [REWORK_FEEDBACK_KEY]: FEEDBACK,
        },
      },
    }),
  ]);
}

/** Names of BUILD tasks whose spec.parentTaskRef is the PLAN task. */
async function followUpChildren(): Promise<string[]> {
  const names = await kubectlGetNames('tasks', NS, `${PROJECT_LABEL}=${PROJECT}`);
  const children: string[] = [];
  for (const name of names) {
    if (name === PLAN_TASK) continue;
    const parent = await kubectlGetField('tasks', name, NS, '{.spec.parentTaskRef}');
    if (parent === PLAN_TASK) children.push(name);
  }
  return children;
}

describe('pr-stage-scope-change', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents(['e2e-plan-agent.yaml', 'clusteragent-complete-worker.yaml']);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E PR-stage scope change',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: PLAN_AGENT }, { name: DEFAULT_AGENT }],
      featureBranchingEnabled: true,
      sourceYaml: `\
  source:
    local: true`,
      flowYaml: `\
  flow:
    build:
      defaultAgent: ${DEFAULT_AGENT}
    integration:
      mode: pr`,
    });

    console.log(`==> Step 9: Apply PLAN Task ${PLAN_TASK}`);
    await applyTask({
      name: PLAN_TASK,
      ns: NS,
      projectRef: PROJECT,
      type: 'PLAN',
      title: 'PR-stage scope change',
      agent: PLAN_AGENT,
      description: 'Deterministic PR-stage scope-change wiring test.',
    });

    console.log('==> Step 10: Park the PLAN task in awaiting-feature-merge with an open PR');
    await waitFor(`task ${PLAN_TASK} parked in awaiting-feature-merge`, 90, 2, async () =>
      (await forcePrStage()) ? true : null,
    );

    console.log('==> Step 11: Write request-changes annotations');
    await writeRequestChanges();
  });

  afterAll(async () => {
    await teardown(NS);
  });

  let child: string;

  it('creates exactly one follow-up BUILD child', async () => {
    child = await waitFor(`follow-up BUILD child for ${PLAN_TASK}`, 120, 3, async () => {
      const children = await followUpChildren();
      return children.length > 0 ? (children[0] as string) : null;
    });

    const children = await followUpChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBe(child);
    console.log(`    Follow-up child: ${child}`);
  }, 125_000);

  it('child spec points back at the PLAN and carries the human feedback', async () => {
    const task = await kubectlGetJSONSilent<TaskLike>('tasks', child, NS);
    expect(task?.spec.type).toBe('BUILD');
    expect(task?.spec.parentTaskRef).toBe(PLAN_TASK);
    expect(task?.spec.agent).toBe(DEFAULT_AGENT);
    expect(task?.spec.priority).toBe('high');
    expect(task?.spec.description ?? '').toContain(FEEDBACK);
  }, 30_000);

  it('PLAN moves to awaiting-children with the child recorded', async () => {
    await waitFor(`PLAN ${PLAN_TASK} phase=awaiting-children`, 60, 2, async () => {
      const phase = await kubectlGetField('tasks', PLAN_TASK, NS, '{.status.phase}');
      return phase === 'awaiting-children' ? phase : null;
    });

    const plan = await kubectlGetJSONSilent<TaskLike>('tasks', PLAN_TASK, NS);
    expect(plan?.status?.phase).toBe('awaiting-children');
    expect(plan?.status?.worker?.createdBuildTaskRefs ?? []).toContain(child);
  }, 65_000);

  it('consumes the request-changes annotations', async () => {
    await waitFor(`request-changes annotations cleared on ${PLAN_TASK}`, 60, 2, async () => {
      const plan = await kubectlGetJSONSilent<TaskLike>('tasks', PLAN_TASK, NS);
      const annotations = plan?.metadata.annotations ?? {};
      if (annotations[REQUEST_CHANGES_KEY] || annotations[REWORK_FEEDBACK_KEY]) return null;
      return true;
    });

    const plan = await kubectlGetJSONSilent<TaskLike>('tasks', PLAN_TASK, NS);
    expect(plan?.metadata.annotations?.[REQUEST_CHANGES_KEY]).toBeUndefined();
    expect(plan?.metadata.annotations?.[REWORK_FEEDBACK_KEY]).toBeUndefined();
  }, 65_000);
});
