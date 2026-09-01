import { describe, expect, test } from 'bun:test';
import type { Project } from '@percussionist/api';
import { resolveAgentModel } from '../worker-builder.js';

// A14: resolveAgentModel must only fall back silently on a NotFound ClusterAgent
// lookup. Transient API errors (503, network) are logged and rethrown so a run
// never silently executes under an unintended model.

function makeProject(agents: Array<{ name: string; model?: string }>): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'test-project' },
    spec: {
      model: 'claude-code/claude-sonnet-5',
      agents,
    },
  } as Project;
}

function notFound(): Error {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

describe('resolveAgentModel — per-agent model resolution', () => {
  test('roster model takes priority (no ClusterAgent lookup needed)', async () => {
    const project = makeProject([{ name: 'reviewer', model: 'opencode-go/deepseek-v4-flash' }]);
    expect(await resolveAgentModel(project, 'reviewer')).toBe('opencode-go/deepseek-v4-flash');
  });

  test('uses the ClusterAgent spec.model when the roster has none', async () => {
    const project = makeProject([{ name: 'reviewer' }]);
    expect(
      await resolveAgentModel(project, 'reviewer', {
        getClusterAgent: async () => ({ spec: { model: 'agent-chosen-model' } }) as never,
      }),
    ).toBe('agent-chosen-model');
  });

  test('returns undefined when the ClusterAgent lookup is NotFound', async () => {
    const project = makeProject([{ name: 'reviewer' }]);
    expect(
      await resolveAgentModel(project, 'reviewer', {
        getClusterAgent: async () => {
          throw notFound();
        },
      }),
    ).toBeUndefined();
  });

  test('rethrows transient ClusterAgent lookup errors instead of silently falling back', async () => {
    const project = makeProject([{ name: 'reviewer' }]);
    await expect(
      resolveAgentModel(project, 'reviewer', {
        getClusterAgent: async () => {
          const err = new Error('503 upstream');
          (err as Error & { statusCode?: number }).statusCode = 503;
          throw err;
        },
      }),
    ).rejects.toThrow('503 upstream');
  });

  test('rethrows plain non-NotFound errors', async () => {
    const project = makeProject([{ name: 'reviewer' }]);
    await expect(
      resolveAgentModel(project, 'reviewer', {
        getClusterAgent: async () => {
          throw new Error('cluster unreachable');
        },
      }),
    ).rejects.toThrow('cluster unreachable');
  });
});
