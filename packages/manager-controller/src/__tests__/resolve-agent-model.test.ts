import { describe, expect, test } from 'bun:test';
import type { Project } from '@percussionist/api';
import { resolveAgentModel } from '../worker-builder.js';

// Note: the ClusterAgent-model fallback path needs a live cluster (or a
// mock.module on @percussionist/kube, which leaks across test files — see
// summarizer.test.ts). These tests cover the roster-priority path, which
// returns before any kube call, and the no-cluster safe fallback.

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

describe('resolveAgentModel — per-agent model resolution', () => {
  test('roster model takes priority (no ClusterAgent lookup needed)', async () => {
    const project = makeProject([{ name: 'reviewer', model: 'opencode-go/deepseek-v4-flash' }]);
    expect(await resolveAgentModel(project, 'reviewer')).toBe('opencode-go/deepseek-v4-flash');
  });

  test('returns undefined when roster has no model and ClusterAgent is unreachable', async () => {
    const project = makeProject([{ name: 'reviewer' }]);
    expect(await resolveAgentModel(project, 'reviewer')).toBeUndefined();
  });

  test('returns undefined for an agent not in the roster when ClusterAgent is unreachable', async () => {
    const project = makeProject([]);
    expect(await resolveAgentModel(project, 'ghost')).toBeUndefined();
  });
});
