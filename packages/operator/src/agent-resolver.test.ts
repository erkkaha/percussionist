// agent-resolver.test.ts — unit tests for resolveAgents() driven through the
// BUILD-1 recording fake kube client. getClusterAgent() resolves via
// @percussionist/kube's CustomObjectsApi singleton, which the fake intercepts
// on CustomObjectsApi.prototype.

import { describe, expect, it } from 'bun:test';
import type { ClusterAgent } from '@percussionist/api';
import { resolveAgents } from './agent-resolver.js';
import { installFakeKube, notFound, serverError } from './test-helpers/fake-kube.js';

function clusterAgent(name: string, content: string): ClusterAgent {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterAgent',
    metadata: { name },
    spec: { content },
  } as ClusterAgent;
}

describe('resolveAgents', () => {
  it('resolves each named ClusterAgent into an {name, content} pair', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: [
        { value: clusterAgent('planner', 'content-planner') },
        { value: clusterAgent('builder', 'content-builder') },
      ],
    });
    try {
      const result = await resolveAgents(['planner', 'builder']);

      expect(result.agents).toEqual([
        { name: 'planner', content: 'content-planner' },
        { name: 'builder', content: 'content-builder' },
      ]);
      expect(result.missing).toEqual([]);
      // One GET per agent name, in order, against the ClusterAgent plural.
      expect(fake.calls.map((c) => c.args[0]?.name)).toEqual(['planner', 'builder']);
      expect(fake.calls.every((c) => c.args[0]?.plural === 'clusteragents')).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it('records a missing ClusterAgent in missing and skips it', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: { error: notFound('no such agent') },
    });
    try {
      const result = await resolveAgents(['ghost']);

      expect(result.agents).toEqual([]);
      expect(result.missing).toEqual(['ghost']);
    } finally {
      fake.restore();
    }
  });

  it('records any lookup error (not just 404) as missing', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: { error: serverError('apiserver down') },
    });
    try {
      const result = await resolveAgents(['planner']);

      expect(result.missing).toEqual(['planner']);
      expect(result.agents).toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it('mixes resolved agents with missing names', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: [
        { value: clusterAgent('a', 'A') },
        { error: notFound() },
        { value: clusterAgent('c', 'C') },
      ],
    });
    try {
      const result = await resolveAgents(['a', 'b', 'c']);

      expect(result.agents.map((a) => a.name)).toEqual(['a', 'c']);
      expect(result.missing).toEqual(['b']);
    } finally {
      fake.restore();
    }
  });

  it('lets an inline agent override a ClusterAgent of the same name', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: { value: clusterAgent('planner', 'from-cluster-agent') },
    });
    try {
      const result = await resolveAgents(
        ['planner'],
        [{ name: 'planner', content: 'from-inline' }],
      );

      expect(result.agents).toEqual([{ name: 'planner', content: 'from-inline' }]);
      expect(result.missing).toEqual([]);
    } finally {
      fake.restore();
    }
  });

  it('appends an inline agent when no ClusterAgent of the same name exists', async () => {
    const fake = installFakeKube({
      getClusterCustomObject: { value: clusterAgent('planner', 'cluster-content') },
    });
    try {
      const result = await resolveAgents(
        ['planner'],
        [{ name: 'inline-extra', content: 'inline-content' }],
      );

      expect(result.agents).toEqual([
        { name: 'planner', content: 'cluster-content' },
        { name: 'inline-extra', content: 'inline-content' },
      ]);
      expect(result.missing).toEqual([]);
    } finally {
      fake.restore();
    }
  });
});
