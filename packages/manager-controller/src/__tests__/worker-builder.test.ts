// worker-builder.test.ts
//
// Coverage for test gap C2 from percussionist-dev-plan-4abf54. The three run
// builders are mocked away in effects.test.ts (lines 76-78), so their real
// behavior — auth validation, memory-context injection and the source.git.ref
// feature-branch override — is exercised here against a fake kube (spies on
// @percussionist/kube exports; validateModelAuth stays real, so the auth
// assertions verify actual validation logic).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project, Task } from '@percussionist/api';
import { LABELS, type SecretsRef } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import * as memoryClient from '../agent/memory-client.js';
import { makeTask } from '../reconciler/__tests__/fixtures.js';
import { buildMergeRun, buildPrOpenRun, buildWorkerRun } from '../worker-builder.js';

const NS = 'percussionist';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function featureProject(overrides: Partial<Project['spec']> = {}): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'proj-a', namespace: NS, uid: 'uid-proj-a' },
    spec: {
      model: 'opencode-go/deepseek-v4-flash', // not a cloud provider — no auth needed
      agents: [{ name: 'builder' }, { name: 'integrator' }],
      featureBranchingEnabled: true,
      source: { git: { url: 'https://github.com/acme/proj.git', ref: 'main' } },
      ...overrides,
    },
  } as Project;
}

function planTask(name = 'plan-abc'): Task {
  return makeTask(name, 'proj-a', { type: 'PLAN' });
}

function buildTask(name = 'build-123', parent?: string): Task {
  return makeTask(name, 'proj-a', {
    type: 'BUILD',
    ...(parent ? { parentTaskRef: parent } : {}),
  });
}

let getClusterSettingsSpy: ReturnType<typeof spyOn>;
let getClusterAgentSpy: ReturnType<typeof spyOn>;
let readPlanFromConfigMapSpy: ReturnType<typeof spyOn>;
let getContextSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // ClusterSettings absent (404-like) — builders must proceed with project
  // defaults.
  getClusterSettingsSpy = spyOn(kube, 'getClusterSettings').mockResolvedValue(undefined as never);
  // No ClusterAgent — resolveAgentModel falls back to project default model.
  getClusterAgentSpy = spyOn(kube, 'getClusterAgent').mockRejectedValue(
    Object.assign(new Error('not found'), { statusCode: 404 }),
  );
  readPlanFromConfigMapSpy = spyOn(kube, 'readPlanFromConfigMap').mockResolvedValue(null);
  getContextSpy = spyOn(memoryClient, 'getContext').mockResolvedValue({
    context: 'irrelevant',
  });
});

afterEach(() => {
  getClusterSettingsSpy.mockRestore();
  getClusterAgentSpy.mockRestore();
  readPlanFromConfigMapSpy.mockRestore();
  getContextSpy.mockRestore();
  delete process.env.MERGING_AGENT;
});

// ---------------------------------------------------------------------------
// buildWorkerRun — auth validation
// ---------------------------------------------------------------------------

describe('buildWorkerRun — auth validation', () => {
  it('throws when the resolved model needs cloud auth and no secrets are configured', async () => {
    const project = featureProject({ model: 'claude-code/claude-sonnet-5' });

    await expect(buildWorkerRun(project, buildTask(), 'run-1', 0)).rejects.toThrow(
      /Auth validation failed for task "build-123" \(agent="builder"\)/,
    );
  });

  it('passes when a cloud model has an authSecret configured', async () => {
    const secrets: SecretsRef = { authSecret: { name: 'opencode-auth', key: 'auth.json' } };
    const project = featureProject({ model: 'claude-code/claude-sonnet-5', secrets });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.model).toBe('claude-code/claude-sonnet-5');
  });

  it('passes when a cloud model has an llmKeysSecret configured', async () => {
    const secrets: SecretsRef = { llmKeysSecret: 'provider-keys' };
    const project = featureProject({ model: 'deepseek/deepseek-chat', secrets });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.model).toBe('deepseek/deepseek-chat');
  });

  it('uses the per-agent roster model, which passes auth even when the project model is absent', async () => {
    const project = featureProject({
      agents: [{ name: 'builder', model: 'claude-code/claude-sonnet-5' }],
      secrets: { authSecret: { name: 'opencode-auth', key: 'auth.json' } },
    });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.model).toBe('claude-code/claude-sonnet-5');
    expect(run.spec.agent).toBe('builder');
  });

  it('uses the ClusterAgent model when the roster has none', async () => {
    getClusterAgentSpy.mockResolvedValue({
      metadata: { name: 'builder' },
      spec: { model: 'anthropic/claude-sonnet-5' },
    });
    const project = featureProject({
      agents: [{ name: 'builder' }],
      secrets: { llmKeysSecret: 'provider-keys' },
    });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.model).toBe('anthropic/claude-sonnet-5');
  });
});

// ---------------------------------------------------------------------------
// buildWorkerRun — memory-context injection
// ---------------------------------------------------------------------------

describe('buildWorkerRun — memory-context injection', () => {
  it('injects RELEVANT PROJECT CONTEXT when the memory service returns context', async () => {
    getContextSpy.mockResolvedValue({ context: 'A past finding about the websocket flood.' });
    const project = featureProject({ embedding: { enabled: true } });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(getContextSpy).toHaveBeenCalledWith('proj-a', '', 'build-123');
    expect(run.spec.task).toContain('RELEVANT PROJECT CONTEXT:');
    expect(run.spec.task).toContain('A past finding about the websocket flood.');
  });

  it('omits the block when the memory service reports no relevant context', async () => {
    getContextSpy.mockResolvedValue({ context: 'No relevant context found.' });
    const project = featureProject({ embedding: { enabled: true } });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.task).not.toContain('RELEVANT PROJECT CONTEXT:');
  });

  it('degrades silently when the memory service is unavailable', async () => {
    getContextSpy.mockRejectedValue(new Error('service down'));
    const project = featureProject({ embedding: { enabled: true } });

    // Must not throw — the run still builds without context.
    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.task).not.toContain('RELEVANT PROJECT CONTEXT:');
  });

  it('skips the memory lookup entirely when embedding is disabled', async () => {
    const project = featureProject(); // embedding not set

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(getContextSpy).not.toHaveBeenCalled();
    expect(run.spec.task).not.toContain('RELEVANT PROJECT CONTEXT:');
  });
});

// ---------------------------------------------------------------------------
// buildWorkerRun — source.git.ref feature-branch override
// ---------------------------------------------------------------------------

describe('buildWorkerRun — source.git.ref override', () => {
  it('overrides ref to the feature branch and sets parentRef for a standalone BUILD', async () => {
    const project = featureProject();
    const task = buildTask('build-99');

    const run = await buildWorkerRun(project, task, 'run-1', 0, undefined, [task]);

    expect(run.spec.source?.git?.ref).toBe('feature/build-99');
    expect(run.spec.source?.git?.parentRef).toBe('main');
  });

  it('uses the parent PLAN branch for a BUILD with a parent', async () => {
    const project = featureProject();
    const plan = planTask('plan-abc');
    const task = buildTask('build-123', 'plan-abc');

    const run = await buildWorkerRun(project, task, 'run-1', 0, undefined, [plan, task]);

    expect(run.spec.source?.git?.ref).toBe('feature/plan-abc--build-123');
    expect(run.spec.source?.git?.parentRef).toBe('feature/plan-abc');
  });

  it('overrides plan refs too when the project has a non-main default ref', async () => {
    const project = featureProject({
      source: { git: { url: 'https://github.com/acme/proj.git', ref: 'develop' } },
    });
    const task = makeTask('plan-x', 'proj-a', { type: 'PLAN' });

    const run = await buildWorkerRun(project, task, 'run-1', 0, undefined, [task]);

    expect(run.spec.source?.git?.ref).toBe('feature/plan-x');
    expect(run.spec.source?.git?.parentRef).toBe('develop');
  });

  it('does not touch source.git.ref when feature branching is disabled', async () => {
    const project = featureProject({ featureBranchingEnabled: false });

    const run = await buildWorkerRun(project, buildTask(), 'run-1', 0);

    expect(run.spec.source?.git?.ref).toBe('main');
    expect(run.spec.source?.git?.parentRef).toBeUndefined();
  });

  it('throws when a BUILD references a missing parent PLAN', async () => {
    const project = featureProject();
    const task = buildTask('build-123', 'ghost-plan');

    await expect(buildWorkerRun(project, task, 'run-1', 0, undefined, [task])).rejects.toThrow(
      /non-existent parent PLAN: ghost-plan/,
    );
  });
});

// ---------------------------------------------------------------------------
// buildWorkerRun — prompt & run shape
// ---------------------------------------------------------------------------

describe('buildWorkerRun — prompt and run shape', () => {
  it('builds a deterministic metadata label set and owner reference', async () => {
    const project = featureProject();

    const run = await buildWorkerRun(project, buildTask('build-123'), 'run-1', 0);

    expect(run.apiVersion).toBe('percussionist.dev/v1alpha1');
    expect(run.kind).toBe('Run');
    expect(run.metadata.name).toBe('run-1');
    expect(run.metadata.labels?.[LABELS.projectName]).toBe('proj-a');
    expect(run.metadata.labels?.[LABELS.taskId]).toBe('build-123');
    expect(run.metadata.ownerReferences?.[0]).toMatchObject({
      name: 'proj-a',
      uid: 'uid-proj-a',
      kind: 'Project',
      controller: true,
    });
    expect(run.spec.project).toBe('proj-a');
    expect(run.spec.boardTask).toBe('build-123');
    expect(run.spec.ttlSecondsAfterFinished).toBe(7 * 86400);
  });

  it('includes GIT COMMIT REQUIREMENTS and UNRELATED ISSUES for BUILD tasks', async () => {
    const run = await buildWorkerRun(featureProject(), buildTask(), 'run-1', 0);

    expect(run.spec.task).toContain('GIT COMMIT REQUIREMENTS:');
    expect(run.spec.task).toContain('UNRELATED ISSUES:');
    expect(run.spec.task).toContain('TASK: build-123');
  });

  it('includes the PLAN CONTEXT block with the read_plan tool for BUILD tasks with a parent', async () => {
    const project = featureProject();
    const plan = planTask('plan-abc');
    const task = buildTask('build-123', 'plan-abc');

    const run = await buildWorkerRun(project, task, 'run-1', 0, undefined, [plan, task]);

    expect(run.spec.task).toContain('PLAN CONTEXT:');
    expect(run.spec.task).toContain('percussionist_dispatcher_read_plan');
    expect(run.spec.task).toContain('.percussionist/plans/plan-abc.md');
  });

  it('injects the RETRY block for retries', async () => {
    const run = await buildWorkerRun(featureProject(), buildTask(), 'run-1', 1, 'rework note');

    expect(run.spec.task).toContain('RETRY 1/3:');
    expect(run.spec.task).toContain('rework note');
  });
});

// ---------------------------------------------------------------------------
// buildMergeRun
// ---------------------------------------------------------------------------

describe('buildMergeRun — branch resolution', () => {
  it('legacy mode (no feature branching): feat/{task} → main, runContext merge-worker', async () => {
    const project = featureProject({ featureBranchingEnabled: false });

    const run = await buildMergeRun(project, buildTask('build-123'), 'merge-1');

    expect(run.spec.source?.git?.ref).toBe('feat/build-123');
    expect(run.spec.source?.git?.parentRef).toBe('main');
    expect(run.spec.runContext).toBe('merge-worker');
    expect(run.spec.ttlSecondsAfterFinished).toBe(7 * 86400);
    expect(run.spec.task).toContain('TASK: Merge approved changes for build-123');
  });

  it('feature mode: source = task branch, target = merge branch', async () => {
    const project = featureProject();
    const plan = planTask('plan-abc');
    const task = buildTask('build-123', 'plan-abc');

    const run = await buildMergeRun(project, task, 'merge-1', [plan, task]);

    expect(run.spec.source?.git?.ref).toBe('feature/plan-abc--build-123');
    expect(run.spec.source?.git?.parentRef).toBe('feature/plan-abc');
    expect(run.spec.task).toContain('Source branch: feature/plan-abc--build-123');
    expect(run.spec.task).toContain('Target branch: feature/plan-abc');
  });

  it('throws when feature branching is enabled but the branch cannot be resolved', async () => {
    const project = featureProject();
    const task = buildTask('build-123', 'ghost-plan');

    await expect(buildMergeRun(project, task, 'merge-1', [task])).rejects.toThrow(
      /non-existent parent PLAN: ghost-plan/,
    );
  });
});

describe('buildMergeRun — agent resolution', () => {
  it('defaults to the task agent when neither override is present', async () => {
    const run = await buildMergeRun(featureProject(), buildTask('build-123'), 'merge-1');

    expect(run.spec.agent).toBe('builder');
  });

  it('uses an explicit mergeAgentName that is in the project roster', async () => {
    const run = await buildMergeRun(
      featureProject(),
      buildTask('build-123'),
      'merge-1',
      [],
      'integrator',
    );

    expect(run.spec.agent).toBe('integrator');
  });

  it('ignores a mergeAgentName that is not in the roster', async () => {
    const run = await buildMergeRun(
      featureProject(),
      buildTask('build-123'),
      'merge-1',
      [],
      'not-in-roster',
    );

    expect(run.spec.agent).toBe('builder');
  });

  it('uses the MERGING_AGENT env var when set to a roster agent', async () => {
    process.env.MERGING_AGENT = 'integrator';

    const run = await buildMergeRun(featureProject(), buildTask('build-123'), 'merge-1');

    expect(run.spec.agent).toBe('integrator');
  });

  it('falls back to the task agent when MERGING_AGENT is set but not in the roster', async () => {
    process.env.MERGING_AGENT = 'ghost-agent';

    const run = await buildMergeRun(featureProject(), buildTask('build-123'), 'merge-1');

    expect(run.spec.agent).toBe('builder');
  });
});

describe('buildMergeRun — auth validation', () => {
  it('throws when the resolved merge agent model needs auth and none is configured', async () => {
    const project = featureProject({
      model: 'claude-code/claude-sonnet-5',
      featureBranchingEnabled: false,
    });

    await expect(buildMergeRun(project, buildTask(), 'merge-1')).rejects.toThrow(
      /Auth validation failed for merge run of task "build-123" \(agent="builder"\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// buildPrOpenRun
// ---------------------------------------------------------------------------

describe('buildPrOpenRun — prerequisites', () => {
  it('throws when the project does not enable feature branching', async () => {
    const project = featureProject({ featureBranchingEnabled: false });

    await expect(buildPrOpenRun(project, buildTask('build-123'), 'pr-1')).rejects.toThrow(
      /PR-mode integration requires featureBranchingEnabled/,
    );
  });
});

describe('buildPrOpenRun — branch resolution', () => {
  it('checks out the source branch and targets the merge branch', async () => {
    const project = featureProject();
    const plan = planTask('plan-abc');
    const task = buildTask('build-123', 'plan-abc');

    const run = await buildPrOpenRun(project, task, 'pr-1', [plan, task]);

    expect(run.spec.source?.git?.ref).toBe('feature/plan-abc--build-123');
    expect(run.spec.source?.git?.parentRef).toBe('feature/plan-abc');
    expect(run.spec.runContext).toBe('merge-worker');
  });

  it('throws when the source branch cannot be resolved (missing parent)', async () => {
    const project = featureProject();
    const task = buildTask('build-123', 'ghost-plan');

    await expect(buildPrOpenRun(project, task, 'pr-1', [task])).rejects.toThrow(
      /non-existent parent PLAN: ghost-plan/,
    );
  });
});

describe('buildPrOpenRun — PR authoring materials', () => {
  it('embeds the plan document when one is found', async () => {
    const project = featureProject();
    const plan = planTask('plan-abc');
    const task = makeTask('plan-abc', 'proj-a', { type: 'PLAN' });
    readPlanFromConfigMapSpy.mockResolvedValue('# Plan: fix the sensor drift');

    const run = await buildPrOpenRun(project, task, 'pr-1', [plan, task]);

    expect(readPlanFromConfigMapSpy).toHaveBeenCalledWith('proj-a', 'plan-abc');
    expect(run.spec.task).toContain('### Plan document');
    expect(run.spec.task).toContain('# Plan: fix the sensor drift');
  });

  it('notes the missing plan document when none is found', async () => {
    const project = featureProject();
    const task = planTask('plan-abc');
    readPlanFromConfigMapSpy.mockResolvedValue(null);

    const run = await buildPrOpenRun(project, task, 'pr-1', [task]);

    expect(run.spec.task).toContain('(No plan document was found for this task.)');
  });

  it('degrades gracefully when reading the plan throws', async () => {
    const project = featureProject();
    const task = planTask('plan-abc');
    readPlanFromConfigMapSpy.mockRejectedValue(new Error('ConfigMap gone'));

    const run = await buildPrOpenRun(project, task, 'pr-1', [task]);

    expect(run.spec.task).toContain('(No plan document was found for this task.)');
  });

  it('renders build-task review records into the prompt', async () => {
    const project = featureProject();
    const task = planTask('plan-abc');
    task.status = {
      ...task.status,
      worker: {
        ...task.status?.worker,
        createdBuildTaskRefs: ['child-1'],
      },
    };
    const child = buildTask('child-1');
    child.status = {
      ...child.status,
      reviews: [
        {
          action: 'approve' as const,
          diagnosis: 'Correct implementation, tests pass.',
          reviewedAt: '2026-01-02T00:00:00.000Z',
          attempt: 1,
        },
      ],
    };

    const run = await buildPrOpenRun(project, task, 'pr-1', [task, child]);

    expect(run.spec.task).toContain('#### child-1');
    expect(run.spec.task).toContain('Review history (oldest first):');
    expect(run.spec.task).toContain('Correct implementation, tests pass.');
  });

  it('instructs the agent how to open the PR with gh', async () => {
    const project = featureProject();
    const task = buildTask('build-123', 'plan-abc');

    const run = await buildPrOpenRun(project, task, 'pr-1', [planTask('plan-abc'), task]);

    expect(run.spec.task).toContain(
      'gh pr create --base "feature/plan-abc" --head "feature/plan-abc--build-123"',
    );
    expect(run.spec.task).toContain('outcome=`pr-opened`');
  });
});

describe('buildPrOpenRun — auth validation', () => {
  it('throws when the resolved model needs auth and none is configured', async () => {
    const project = featureProject({
      model: 'claude-code/claude-sonnet-5',
    });

    await expect(buildPrOpenRun(project, buildTask('build-123'), 'pr-1', [])).rejects.toThrow(
      /Auth validation failed for PR-open run of task "build-123"/,
    );
  });
});
