// facilitator-image.test.ts
//
// The review and PR-feedback facilitator runs used to build their RunSpec with
// `runner.image: undefined`, which resolveRunConfig turns into the schema
// default DEFAULT_RUNNER_IMAGE (`runner-opencode:latest`). On a node that pulls
// with IfNotPresent, `:latest` is whatever build happened to be cached (a stale
// v0.2.28 while ClusterSettings pinned v0.2.30 — 2026-09-20). Buildgen already
// honored the ClusterSettings pin; these lock the same behavior in for the
// other two.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Project, RunStatus } from '@percussionist/api';
import { DEFAULT_RUNNER_IMAGE } from '@percussionist/api';
import * as kube from '@percussionist/kube';
import { buildPrFeedbackEvalRun, buildReviewRun } from '../facilitator.js';
import { makeTask } from '../reconciler/__tests__/fixtures.js';

const PINNED = 'ghcr.io/erkkaha/percussionist/runner-opencode:v0.2.30';

function project(): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: 'proj-a', namespace: 'percussionist', uid: 'uid-proj-a' },
    spec: {
      model: 'opencode-go/deepseek-v4-flash',
      // Roster model → resolveAgentModel never reaches getClusterAgent.
      agents: [{ name: 'reviewer', model: 'opencode-go/deepseek-v4-flash' }],
      source: { git: { url: 'https://github.com/acme/proj.git', ref: 'main' } },
    },
  } as Project;
}

const succeeded: RunStatus = { phase: 'Succeeded', message: 'agent signalled completion' };

let getClusterSettingsSpy: ReturnType<typeof spyOn>;
let readPlanSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  readPlanSpy = spyOn(kube, 'readPlanFromConfigMap').mockResolvedValue(null);
});

afterEach(() => {
  getClusterSettingsSpy?.mockRestore();
  readPlanSpy.mockRestore();
});

function pinClusterSettings(image: string | undefined) {
  getClusterSettingsSpy = spyOn(kube, 'getClusterSettings').mockResolvedValue(
    (image
      ? { spec: { runner: { image, resources: { requests: { cpu: '1' } } } } }
      : undefined) as never,
  );
}

describe('review-flavoured facilitator runs honor the ClusterSettings runner pin', () => {
  it('buildReviewRun uses spec.runner.image and resources from ClusterSettings', async () => {
    pinClusterSettings(PINNED);
    const task = makeTask('build-1', 'proj-a', { type: 'BUILD' });
    const run = await buildReviewRun(
      project(),
      task,
      'run-1',
      succeeded,
      'review-1',
      undefined,
      'reviewer',
    );
    expect(run.spec.image).toBe(PINNED);
    expect(run.spec.resources).toEqual({ requests: { cpu: '1' } });
  });

  it('buildPrFeedbackEvalRun uses spec.runner.image from ClusterSettings', async () => {
    pinClusterSettings(PINNED);
    const task = makeTask('build-2', 'proj-a', { type: 'BUILD' });
    const run = await buildPrFeedbackEvalRun(project(), task, 'eval-1', 42, undefined, 'reviewer');
    expect(run.spec.image).toBe(PINNED);
  });

  it('falls back to the schema default only when ClusterSettings is absent', async () => {
    pinClusterSettings(undefined);
    const task = makeTask('build-3', 'proj-a', { type: 'BUILD' });
    const run = await buildReviewRun(
      project(),
      task,
      'run-3',
      succeeded,
      'review-3',
      undefined,
      'reviewer',
    );
    expect(run.spec.image).toBe(DEFAULT_RUNNER_IMAGE);
  });
});
