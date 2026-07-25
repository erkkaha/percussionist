// submit-labels.test.ts — Regression tests for the project label on submitted Runs.
//
// The operator's renderPod() requires metadata.labels["percussionist.dev/project"];
// it resolves the project's data PVC from it and throws without it. That
// requirement arrived with PVC-based caching, but `beatctl submit` was never
// updated, so every submitted Run failed at pod creation with:
//
//   failed to create pod: Run <ns>/<name> missing required label: percussionist.dev/project
//
// These tests pin the label onto both construction paths (flags and -f file).

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABELS, MANAGED_BY } from '@percussionist/api';
import { buildRunFromFile, buildRunFromFlags, withProjectLabels } from '../src/submit.ts';

const PROJECT_LABEL = LABELS.projectName; // percussionist.dev/project

describe('withProjectLabels', () => {
  it('adds the project and managed-by labels', () => {
    const meta = withProjectLabels({ name: 'r1' }, 'my-project');
    expect(meta.labels[PROJECT_LABEL]).toBe('my-project');
    expect(meta.labels[LABELS.managedBy]).toBe(MANAGED_BY);
    expect(meta.name).toBe('r1');
  });

  it('does not clobber labels the user already set', () => {
    const meta = withProjectLabels(
      { name: 'r1', labels: { [PROJECT_LABEL]: 'explicit', mine: 'kept' } },
      'from-flag',
    );
    expect(meta.labels[PROJECT_LABEL]).toBe('explicit');
    expect(meta.labels.mine).toBe('kept');
  });

  it('omits the project label when no project is known', () => {
    const meta = withProjectLabels({ name: 'r1' }, '');
    expect(meta.labels[PROJECT_LABEL]).toBeUndefined();
  });
});

describe('buildRunFromFlags', () => {
  it('labels the Run so the operator can resolve the data PVC', () => {
    const run = buildRunFromFlags({
      project: 'my-project',
      task: 'say hi',
      namespace: 'percussionist',
      name: 'r-flags',
    } as Parameters<typeof buildRunFromFlags>[0]);
    expect(run.metadata.labels?.[PROJECT_LABEL]).toBe('my-project');
    expect(run.spec.project).toBe('my-project');
  });
});

describe('buildRunFromFile', () => {
  function writeRunYaml(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'beatctl-submit-'));
    const p = join(dir, 'run.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('derives the label from spec.project when --project is not passed', () => {
    const p = writeRunYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: from-file
spec:
  project: file-project
  task: "say hi"
`);
    const run = buildRunFromFile(p, {} as Parameters<typeof buildRunFromFile>[1]);
    expect(run.metadata.labels?.[PROJECT_LABEL]).toBe('file-project');
  });

  it('preserves labels already present in the file', () => {
    const p = writeRunYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: from-file
  labels:
    percussionist.dev/project: explicit-project
    team: platform
spec:
  project: file-project
  task: "say hi"
`);
    const run = buildRunFromFile(p, {} as Parameters<typeof buildRunFromFile>[1]);
    expect(run.metadata.labels?.[PROJECT_LABEL]).toBe('explicit-project');
    expect(run.metadata.labels?.team).toBe('platform');
  });
});
