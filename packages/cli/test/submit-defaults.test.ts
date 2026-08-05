// submit-defaults.test.ts — Project defaults merge in buildRunFromFlags.
//
// `beatctl submit --project p` is supposed to fill run.spec gaps from
// p.spec: agent, image, timeoutSeconds, resources (plus read-only
// inheritance of data/gitCache/runner.packages). It only actually merged
// model/secrets/git/sidecars/initScript — agent/image/timeout/resources were
// never pulled from the Project, so a project configured with `--agent
// builder` submitted agent-less runs, and on capability-gated flows the
// dispatcher withheld the completion tool (gated on run.complete.* of
// spec.agent), killing the run with "session ended without completion
// signal". These tests pin the merge down.

import { describe, expect, it } from 'bun:test';
import type { ProjectSpec } from '@percussionist/api';
import { buildRunFromFlags } from '../src/submit.ts';

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    project: 'my-project',
    task: 'say hi',
    namespace: 'percussionist',
    name: 'r-defaults',
    ...overrides,
  } as Parameters<typeof buildRunFromFlags>[0];
}

const PD: ProjectSpec = {
  agent: 'builder',
  image: 'img',
  timeoutSeconds: 600,
  resources: { requests: { cpu: '100m', memory: '256Mi' } },
};

describe('buildRunFromFlags project defaults merge', () => {
  it('carries agent/image/timeoutSeconds/resources from projectDefaults when no flags are set', () => {
    const run = buildRunFromFlags(makeOpts(), PD);
    expect(run.spec.agent).toBe('builder');
    expect(run.spec.image).toBe('img');
    expect(run.spec.timeoutSeconds).toBe(600);
    expect(run.spec.resources).toEqual({ requests: { cpu: '100m', memory: '256Mi' } });
  });

  it('lets explicit --agent/--image/--timeout flags win over projectDefaults', () => {
    const run = buildRunFromFlags(
      makeOpts({ agent: 'myagent', image: 'myimg', timeout: '120' }),
      PD,
    );
    expect(run.spec.agent).toBe('myagent');
    expect(run.spec.image).toBe('myimg');
    expect(run.spec.timeoutSeconds).toBe(120);
    // resources has no CLI flag; it is always inherited from the project.
    expect(run.spec.resources).toEqual({ requests: { cpu: '100m', memory: '256Mi' } });
  });

  it('inherits data/gitCache/runner.packages from projectDefaults', () => {
    const run = buildRunFromFlags(makeOpts(), {
      ...PD,
      data: { pvcName: 'custom-data', mountPath: '/data', storageClass: 'fast' },
      gitCache: { worktreeReuse: false },
      runner: { packages: ['ripgrep', 'jq'] },
    } as ProjectSpec);
    expect(run.spec.data).toEqual({
      pvcName: 'custom-data',
      mountPath: '/data',
      storageClass: 'fast',
    });
    expect(run.spec.gitCache).toEqual({ worktreeReuse: false });
    expect(run.spec.runner).toEqual({ packages: ['ripgrep', 'jq'] });
  });

  it('leaves inherited fields absent when no projectDefaults are passed', () => {
    const run = buildRunFromFlags(makeOpts());
    expect(run.spec.agent).toBeUndefined();
    expect(run.spec.resources).toBeUndefined();
    expect(run.spec.data).toBeUndefined();
    expect(run.spec.gitCache).toBeUndefined();
    expect(run.spec.runner).toBeUndefined();
    // RunSchema defaults apply for the defaulted fields.
    expect(run.spec.image).toBe('ghcr.io/erkkaha/percussionist/runner:latest');
    expect(run.spec.timeoutSeconds).toBe(3600);
  });
});
