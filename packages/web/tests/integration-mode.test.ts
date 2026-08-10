import { describe, expect, it } from 'bun:test';
import type { Project } from '@percussionist/api';
import { resolveIntegrationMode } from '../src/server/lib/integration-mode.js';

function makeProject(spec: Partial<Project['spec']>): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'test-proj' },
    spec: { source: { local: true }, agents: [], maxParallel: 2, ...spec },
  } as unknown as Project;
}

describe('resolveIntegrationMode', () => {
  it('returns disabled when featureBranchingEnabled is false, regardless of flow config', () => {
    const project = makeProject({
      featureBranchingEnabled: false,
      flow: { preset: 'plan-build-review-merge', integration: { mode: 'pr' } },
    });
    expect(resolveIntegrationMode(project)).toBe('disabled');
  });

  it('uses the explicit flow.integration.mode override when featureBranchingEnabled is true', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
      flow: { preset: 'plan-build-review-merge', integration: { mode: 'pr' } },
    });
    expect(resolveIntegrationMode(project)).toBe('pr');
  });

  it('defaults to auto-merge for plan-build-review-merge preset with no override', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
      flow: { preset: 'plan-build-review-merge' },
    });
    expect(resolveIntegrationMode(project)).toBe('auto-merge');
  });

  it('defaults to auto-merge for plan-build preset with no override', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
      flow: { preset: 'plan-build' },
    });
    expect(resolveIntegrationMode(project)).toBe('auto-merge');
  });

  it('defaults to disabled for simple preset with no override', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
      flow: { preset: 'simple' },
    });
    expect(resolveIntegrationMode(project)).toBe('disabled');
  });

  it('defaults to disabled for review preset with no override', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
      flow: { preset: 'review' },
    });
    expect(resolveIntegrationMode(project)).toBe('disabled');
  });

  it('defaults to plan-build-review-merge preset behavior when flow is entirely unset', () => {
    const project = makeProject({
      featureBranchingEnabled: true,
    });
    expect(resolveIntegrationMode(project)).toBe('auto-merge');
  });
});
