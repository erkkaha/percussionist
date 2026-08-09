// gitops-manifest.test.ts — the substitutions `beatctl deploy --gitops` makes
// to k8s/flux/percussionist.yaml before applying it.
//
// The real manifest is read from the repo rather than fixtured, so that a
// change to its shape that breaks the regexes fails here instead of at deploy
// time on someone's cluster.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { patchFluxManifest, tagFromVersion } from '../src/gitops-manifest.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const MANIFEST = readFileSync(path.join(REPO_ROOT, 'k8s/flux/percussionist.yaml'), 'utf8');

describe('patchFluxManifest — against the checked-in manifest', () => {
  it('pins the OCIRepository tag', () => {
    const out = patchFluxManifest(MANIFEST, { tag: 'v9.9.9' });

    expect(out).toMatch(/^ {4}tag: v9\.9\.9$/m);
    // Exactly one tag line, so no other mapping key was caught.
    expect(out.match(/^[ \t]+tag: /gm)).toHaveLength(1);
  });

  it('rewrites the ingress base URL inside the kustomize patch', () => {
    const out = patchFluxManifest(MANIFEST, {
      ingressBaseUrl: 'https://10.0.0.5.nip.io:30443',
    });

    expect(out).toContain(
      '- name: PERCUSSIONIST_INGRESS_BASE_URL\n' +
        '                      value: https://10.0.0.5.nip.io:30443',
    );
  });

  it('applies both substitutions together and changes nothing else', () => {
    const out = patchFluxManifest(MANIFEST, {
      tag: 'v1.2.3',
      ingressBaseUrl: 'https://example.test',
    });

    const changed = MANIFEST.split('\n')
      .map((line, i) => [line, out.split('\n')[i]] as const)
      .filter(([a, b]) => a !== b);

    expect(changed).toHaveLength(2);
    expect(out).toContain('tag: v1.2.3');
    expect(out).toContain('value: https://example.test');
  });

  it('leaves the manifest untouched when no substitutions are requested', () => {
    expect(patchFluxManifest(MANIFEST, {})).toBe(MANIFEST);
  });

  it('preserves the comment that mentions `tag:` in prose', () => {
    const out = patchFluxManifest(MANIFEST, { tag: 'v9.9.9' });
    expect(out).toContain('replace `tag:` with a `semver:` range');
  });
});

describe('patchFluxManifest — drift detection', () => {
  it('throws rather than silently applying an unpinned manifest', () => {
    expect(() => patchFluxManifest('kind: OCIRepository\n', { tag: 'v1.0.0' })).toThrow(
      /could not find an OCIRepository `tag:` line/,
    );
  });

  it('throws when the ingress patch block is missing', () => {
    expect(() =>
      patchFluxManifest('kind: Kustomization\n', { ingressBaseUrl: 'https://x' }),
    ).toThrow(/could not find the PERCUSSIONIST_INGRESS_BASE_URL patch/);
  });
});

describe('tagFromVersion', () => {
  it('adds the v prefix used by release tags', () => {
    expect(tagFromVersion('0.2.12')).toBe('v0.2.12');
  });

  it('leaves an already-prefixed tag alone', () => {
    expect(tagFromVersion('v0.2.12')).toBe('v0.2.12');
  });
});
