// namespace-file.test.ts — File submissions must preserve the file's
// metadata.namespace unless -n is explicitly passed.
//
// Regression: `submit -f` / `project create -f` unconditionally overwrote the
// file namespace because commander gave -n a static DEFAULT_NAMESPACE default,
// so opts.namespace was never falsy and the `if (opts.namespace)` guards always
// fired. A YAML with `namespace: my-ns` silently landed in the `percussionist`
// default namespace instead.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectFromFile } from '../src/project.ts';
import { buildRunFromFile } from '../src/submit.ts';

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'beatctl-ns-'));
  const p = join(dir, 'manifest.yaml');
  writeFileSync(p, body);
  return p;
}

describe('buildRunFromFile namespace semantics', () => {
  it('preserves metadata.namespace from the file when -n is not passed', () => {
    const p = writeYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: from-file
  namespace: my-ns
spec:
  project: my-project
  task: "say hi"
`);
    const run = buildRunFromFile(p, {} as Parameters<typeof buildRunFromFile>[1]);
    expect(run.metadata.namespace).toBe('my-ns');
  });

  it('lets an explicit -n override the file namespace', () => {
    const p = writeYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Run
metadata:
  name: from-file
  namespace: my-ns
spec:
  project: my-project
  task: "say hi"
`);
    const run = buildRunFromFile(p, { namespace: 'explicit' } as Parameters<
      typeof buildRunFromFile
    >[1]);
    expect(run.metadata.namespace).toBe('explicit');
  });
});

describe('buildProjectFromFile namespace semantics', () => {
  it('preserves metadata.namespace from the file when -n is not passed', () => {
    const p = writeYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: from-file
  namespace: my-ns
spec:
  displayName: Test
`);
    const project = buildProjectFromFile(p, {} as Parameters<typeof buildProjectFromFile>[1]);
    expect(project.metadata.namespace).toBe('my-ns');
  });

  it('lets an explicit -n override the file namespace', () => {
    const p = writeYaml(`apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: from-file
  namespace: my-ns
spec:
  displayName: Test
`);
    const project = buildProjectFromFile(p, { namespace: 'explicit' } as Parameters<
      typeof buildProjectFromFile
    >[1]);
    expect(project.metadata.namespace).toBe('explicit');
  });
});
