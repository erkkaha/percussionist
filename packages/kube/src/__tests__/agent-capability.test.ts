import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ClusterAgent, Project } from '@percussionist/api';
import * as kube from '../index.js';

function projectWithRoster(names: string[]): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'proj', namespace: 'percussionist', uid: 'uid-1' },
    spec: {
      displayName: 'proj',
      agents: names.map((name) => ({ name })),
      secrets: { llmKeysSecret: 'llm-keys' },
    },
  } as Project;
}

function clusterAgent(
  name: string,
  capabilities: ClusterAgent['spec']['capabilities'],
): ClusterAgent {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterAgent',
    metadata: { name },
    spec: { content: `# ${name}`, capabilities },
  } as ClusterAgent;
}

describe('requiredCapabilityForTaskType', () => {
  it('maps PLAN to task.plan.execute', () => {
    expect(kube.requiredCapabilityForTaskType('PLAN')).toBe('task.plan.execute');
  });

  it('maps BUILD to task.build.execute', () => {
    expect(kube.requiredCapabilityForTaskType('BUILD')).toBe('task.build.execute');
  });
});

describe('validateAgentTaskCapability', () => {
  let listSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    listSpy?.mockRestore();
    listSpy = undefined;
  });

  it('fails when selected agent is not in project roster', async () => {
    listSpy = spyOn(kube, 'listClusterAgents').mockResolvedValue([]);
    const result = await kube.validateAgentTaskCapability(
      projectWithRoster(['builder']),
      'BUILD',
      'reviewer',
    );

    expect(result.ok).toBe(false);
    expect(result.requiredCapability).toBe('task.build.execute');
    if (!result.ok) expect(result.error).toContain('not in project roster');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('fails when cluster agent is missing', async () => {
    listSpy = spyOn(kube, 'listClusterAgents').mockResolvedValue([
      clusterAgent('builder', ['task.build.execute']),
    ]);

    const result = await kube.validateAgentTaskCapability(
      projectWithRoster(['builder', 'reviewer']),
      'BUILD',
      'reviewer',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cluster agent "reviewer" not found');
  });

  it('fails closed when required capability is missing', async () => {
    listSpy = spyOn(kube, 'listClusterAgents').mockResolvedValue([
      clusterAgent('reviewer', ['task.review.evaluate', 'run.complete.review']),
    ]);

    const result = await kube.validateAgentTaskCapability(
      projectWithRoster(['reviewer']),
      'BUILD',
      'reviewer',
    );

    expect(result.ok).toBe(false);
    expect(result.requiredCapability).toBe('task.build.execute');
    if (!result.ok)
      expect(result.error).toContain('missing required capability "task.build.execute"');
  });

  it('succeeds when required capability is present', async () => {
    listSpy = spyOn(kube, 'listClusterAgents').mockResolvedValue([
      clusterAgent('builder', ['task.build.execute', 'run.complete.build']),
    ]);

    const result = await kube.validateAgentTaskCapability(
      projectWithRoster(['builder']),
      'BUILD',
      'builder',
    );

    expect(result).toEqual({ ok: true, requiredCapability: 'task.build.execute' });
  });
});
