/**
 * e2e-review-findings: structured reviewer findings flow end-to-end.
 *
 * Scenario:
 *   1. Shared cluster setup + deploy a web pod in the e2e namespace.
 *   2. Apply ClusterAgents: e2e-complete-worker, reviewer-findings.
 *   3. Apply Project with local git source, ai-review enabled, and
 *      flow.review.agent=reviewer-findings.
 *   4. Apply Task CR (type=BUILD, agent=e2e-complete-worker).
 *   5. Assert: worker run reaches Succeeded via complete_run.
 *   6. Assert: review run is spawned and calls complete_review with findings.
 *   7. Assert: Task.status.diffFindings contains the normalized finding.
 *   8. Assert: the web diff API returns the finding with isActive/isStale.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  kubectlExecSilent,
  kubectlGetField,
  kubectlGetJSONSilent,
  kubectlGetNames,
  kubectlRolloutStatus,
} from './helpers/kubectl.ts';
import {
  applyClusterAgents,
  applyProject,
  applyTask,
  applyWebDeployment,
  setupCluster,
  teardown,
} from './helpers/setup.ts';
import { waitFor } from './helpers/wait.ts';

const NS = 'percussionist-e2e-review-findings';
const PROJECT = 'e2e-review-findings-test';
const TASK_NAME = 't1';
const TASK_LABEL = 'percussionist.dev/task-id';
const LLM_SECRET = process.env['LLM_SECRET'] ?? 'llm-keys';

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

/** Poll until the Task CR has structured diff findings. */
async function pollTaskDiffFindings(taskName: string, ns: string): Promise<true | null> {
  const task = await kubectlGetJSONSilent<{ status?: { diffFindings?: { items?: unknown[] } } }>(
    'tasks',
    taskName,
    ns,
  );
  const count = task?.status?.diffFindings?.items?.length ?? 0;
  return count > 0 ? true : null;
}

/** Query the web diff endpoint from inside the web pod. */
async function fetchDiffPayload(project: string, taskName: string, ns: string): Promise<unknown> {
  const url = `http://127.0.0.1:8080/api/projects/${project}/tasks/${taskName}/diff`;
  const out = await kubectlExecSilent(ns, 'deployment/percussionist-web', undefined, [
    'wget',
    '-qO-',
    url,
  ]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('review-findings', () => {
  beforeAll(async () => {
    await setupCluster({ ns: NS, llmSecret: LLM_SECRET });

    await applyClusterAgents([
      'clusteragent-complete-worker.yaml',
      'clusteragent-reviewer-findings.yaml',
    ]);

    await applyWebDeployment(NS);
    await kubectlRolloutStatus('percussionist-web', NS, 120);

    console.log(`==> Step 8: Apply Project ${PROJECT}`);
    await applyProject({
      name: PROJECT,
      ns: NS,
      displayName: 'E2E Review Findings Test',
      llmSecret: LLM_SECRET,
      phase: 'Active',
      maxParallel: 1,
      agents: [{ name: 'e2e-complete-worker' }, { name: 'reviewer-findings' }],
      sourceYaml: `\
  source:
    local: true`,
      flowYaml: `\
  flow:
    build:
      onSuccess: ai-review
    review:
      aiReviewerEnabled: true
      agent: reviewer-findings`,
    });

    console.log(`==> Step 9: Apply Task ${TASK_NAME}`);
    await applyTask({
      name: TASK_NAME,
      ns: NS,
      projectRef: PROJECT,
      type: 'BUILD',
      title: 'Make a deterministic change',
      agent: 'e2e-complete-worker',
      description: 'This task is intentionally completed by the deterministic worker.',
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

    const target = await kubectlGetField(
      'runs',
      reviewRun,
      NS,
      '{.spec.facilitation.targetRunName}',
    );
    expect(target).toBe(workerRun);

    const successReview = await kubectlGetField(
      'runs',
      reviewRun,
      NS,
      '{.spec.facilitation.successReview}',
    );
    expect(successReview).toBe('true');
  }, 185_000);

  it('reviewer findings are persisted in Task.status.diffFindings', async () => {
    await waitFor(`task ${TASK_NAME} has diffFindings`, 180, 3, () =>
      pollTaskDiffFindings(TASK_NAME, NS),
    );

    const task = await kubectlGetJSONSilent<{
      status?: {
        phase?: string;
        diffFindings?: {
          sourceRunName?: string;
          items?: Array<{ id: string; severity: string; title: string }>;
        };
      };
    }>('tasks', TASK_NAME, NS);

    expect(task?.status?.diffFindings).toBeDefined();
    expect(task?.status?.diffFindings?.sourceRunName).toBe(reviewRun);
    expect(task?.status?.diffFindings?.items?.length).toBeGreaterThanOrEqual(1);
    const first = task?.status?.diffFindings?.items?.[0];
    expect(first?.id).toBe('f1');
    expect(first?.severity).toBe('high');
  }, 185_000);

  it('web diff API returns findings with active/stale mapping', async () => {
    const payload = await waitFor(
      `diff API returns findings for ${TASK_NAME}`,
      120,
      3,
      async () => {
        const data = (await fetchDiffPayload(PROJECT, TASK_NAME, NS)) as {
          findings?: Array<{ id: string; isActive: boolean; isStale: boolean }>;
        } | null;
        if (data && Array.isArray(data.findings) && data.findings.length > 0) {
          return data;
        }
        return null;
      },
    );

    expect(payload).toBeTruthy();
    const findings = (
      payload as { findings: Array<{ id: string; isActive: boolean; isStale: boolean }> }
    ).findings;
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].id).toBe('f1');
    expect(typeof findings[0].isActive).toBe('boolean');
    expect(typeof findings[0].isStale).toBe('boolean');
  }, 125_000);
});
