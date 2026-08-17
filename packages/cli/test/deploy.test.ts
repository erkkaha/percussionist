// deploy.test.ts — `beatctl deploy` operator-manifest patching (C18).
//
// patchedOperatorManifest rewrites the PERCUSSIONIST_INGRESS_BASE_URL env value
// in k8s/deploy/operator.yaml to https://<node-ip>.nip.io:30443 so per-run
// webURLs are HTTPS from the start. It is regex-based, so the tests pin the
// regexes against the real checked-in manifest (a manifest-shape change that
// breaks the regex fails here instead of at deploy time) plus synthetic
// manifests for the edge cases (already-https, non-nip.io domain, missing env).

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchedOperatorManifest } from '../src/deploy.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const OPERATOR_YAML = path.join(REPO_ROOT, 'k8s/deploy/operator.yaml');

const IP = '10.0.0.5';
const HTTPS_URL = `https://${IP}.nip.io:30443`;

// Track temp files created by the function so they are always cleaned up.
const tempFiles: string[] = [];
afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try {
      rmSync(f);
    } catch {
      /* already gone */
    }
  }
});

function writeTempManifest(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-test-'));
  const file = path.join(dir, 'operator.yaml');
  writeFileSync(file, content);
  return file;
}

describe('patchedOperatorManifest', () => {
  it('rewrites the nip.io value in the real checked-in operator.yaml to https', () => {
    const patchedPath = patchedOperatorManifest(OPERATOR_YAML, IP);
    tempFiles.push(patchedPath);

    // A temp copy is produced — the checked-in file is never modified.
    expect(patchedPath).not.toBe(OPERATOR_YAML);
    expect(existsSync(patchedPath)).toBe(true);

    const patched = readFileSync(patchedPath, 'utf8');
    expect(patched).toContain(`value: ${HTTPS_URL}`);
    expect(patched).not.toContain('value: http://192.168.49.2.nip.io:30080');
    // Only the value line changed — the env var name and everything else stay.
    expect(patched).toContain('- name: PERCUSSIONIST_INGRESS_BASE_URL');
  });

  it('keeps the non-ingress content untouched', () => {
    const patchedPath = patchedOperatorManifest(OPERATOR_YAML, IP);
    tempFiles.push(patchedPath);
    const original = readFileSync(OPERATOR_YAML, 'utf8');
    const patched = readFileSync(patchedPath, 'utf8');

    const originalLines = original.split('\n');
    const patchedLines = patched.split('\n');
    const changed = originalLines
      .map((line, i) => [line, patchedLines[i]] as const)
      .filter(([a, b]) => a !== b);
    expect(changed.length).toBeGreaterThan(0); // the value line changed
    // And nothing else did.
    for (const [a, b] of changed) {
      expect(a.trim()).not.toBe(b.trim());
      expect(a.trim().replace(/^value:.*/, 'value: …')).toBe(
        b.trim().replace(/^value:.*/, 'value: …'),
      );
    }
    const nonValueChanges = originalLines
      .map((line, i) => [line, patchedLines[i]] as const)
      .filter(([a, b]) => a !== b && !a.trim().startsWith('value:'));
    expect(nonValueChanges).toHaveLength(0);
  });

  it('is idempotent: an already-correct https value needs no change and returns the original path', () => {
    const manifest = [
      '- name: PERCUSSIONIST_INGRESS_BASE_URL',
      `  value: ${HTTPS_URL}`,
      '- name: OTHER',
      '  value: keep-me',
    ].join('\n');
    const file = writeTempManifest(manifest);

    const result = patchedOperatorManifest(file, IP);
    // Nothing to patch → apply unmodified (original path returned, no temp file).
    expect(result).toBe(file);
  });

  it('replaces an existing https nip.io value with a new IP (re-runs with a fresh cluster)', () => {
    const manifest = [
      '- name: PERCUSSIONIST_INGRESS_BASE_URL',
      '  value: https://192.168.99.100.nip.io:30443',
      '- name: OTHER',
      '  value: keep-me',
    ].join('\n');
    const file = writeTempManifest(manifest);

    const patchedPath = patchedOperatorManifest(file, '172.16.0.9');
    tempFiles.push(patchedPath);
    expect(patchedPath).not.toBe(file);
    const patched = readFileSync(patchedPath, 'utf8');
    expect(patched).toContain('value: https://172.16.0.9.nip.io:30443');
    expect(patched).toContain('value: keep-me');
  });

  it('falls back to the env-var-name regex when the value is not a nip.io domain', () => {
    const manifest = [
      '- name: PERCUSSIONIST_INGRESS_BASE_URL',
      '  value: http://percussionist.localhost',
      '- name: OTHER',
      '  value: keep-me',
    ].join('\n');
    const file = writeTempManifest(manifest);

    const patchedPath = patchedOperatorManifest(file, IP);
    tempFiles.push(patchedPath);
    expect(patchedPath).not.toBe(file);
    expect(readFileSync(patchedPath, 'utf8')).toContain(`value: ${HTTPS_URL}`);
  });

  it('returns the original path when the manifest has no ingress base URL at all (warns instead of failing)', () => {
    const manifest = ['- name: UNRELATED', '  value: x', '  value: y'].join('\n');
    const file = writeTempManifest(manifest);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      const result = patchedOperatorManifest(file, IP);
      expect(result).toBe(file);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join('\n')).toContain('could not patch PERCUSSIONIST_INGRESS_BASE_URL');
  });
});
