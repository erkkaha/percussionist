// writes-findings.test.ts — write-path regression tests for the findings
// ConfigMap helpers: appendFindingToConfigMap, getFindingsConfigMap and
// patchFindingsConfigMap.
//
// The regression this file exists for: the original inbox layout was
// `inbox/<id>.json` and every write was rejected by the API server with a 422
// (`/` is not in the ConfigMap data key charset `[-._a-zA-Z0-9]+`), so no
// finding was ever stored. The parse helpers were unit-tested against hand
// built maps, but nothing ever asserted on the *write* body. These tests drive
// the write path through the recording fake-kube helper and assert on the
// exact request body keys and labels sent to the API server.

import { describe, expect, it } from 'bun:test';
import type { Finding } from '@percussionist/api';
import {
  appendFindingToConfigMap,
  getFindingsConfigMap,
  inboxFindingKey,
  patchFindingsConfigMap,
  triagedFindingKey,
} from '../index.js';
import { installFakeKube, kubeError, notFound, serverError } from './helpers/fake-kube.js';

const NS = 'test-ns';
const PROJECT = 'my-proj';
const CM_NAME = `${PROJECT}-findings`;

// ConfigMap data keys must match this charset (the API server rejects anything
// else with 422). This is the contract the original `inbox/<id>.json` layout
// violated.
const CONFIGMAP_KEY = /^[-._a-zA-Z0-9]+$/;

/** Extract the single key of a ConfigMap data record, failing loudly if absent. */
function singleDataKey(data: Record<string, string>): string {
  const [key] = Object.keys(data);
  if (!key) throw new Error(`expected exactly one data key, got ${Object.keys(data).length}`);
  return key;
}

const makeFinding = (overrides: Partial<Finding> & { id: string }): Finding => ({
  id: overrides.id,
  title: overrides.title ?? 'Test finding',
  description: overrides.description ?? 'Something is wrong',
  severity: overrides.severity ?? 'high',
  category: overrides.category ?? 'bug',
  source: overrides.source ?? {
    project: PROJECT,
    task: 'task-1',
    run: 'run-1',
    agent: 'builder',
  },
  dedupKey: overrides.dedupKey ?? 'dk-1',
  createdAt: overrides.createdAt ?? '2026-06-15T00:00:00.000Z',
  ...(overrides.filePath ? { filePath: overrides.filePath } : {}),
  ...(overrides.snippet ? { snippet: overrides.snippet } : {}),
  ...(overrides.clusterId ? { clusterId: overrides.clusterId } : {}),
  ...(overrides.status ? { status: overrides.status } : {}),
});

describe('appendFindingToConfigMap', () => {
  it('patch fast path: merge-patch body carries the inbox key and labels', async () => {
    const fake = installFakeKube({ patchNamespacedConfigMap: { value: {} } });
    try {
      const finding = makeFinding({ id: '1785144009598-1232b4487768' });
      const result = await appendFindingToConfigMap(PROJECT, finding, NS);

      expect(result).toEqual({ written: true });
      expect(fake.calls.map((c) => c.method)).toEqual(['patchNamespacedConfigMap']);

      const patchArgs = fake.calls[0]?.args[0] as {
        name: string;
        namespace: string;
        body: { metadata: { labels: Record<string, string> }; data: Record<string, string> };
      };
      expect(patchArgs.name).toBe(CM_NAME);
      expect(patchArgs.namespace).toBe(NS);
      expect(patchArgs.body.metadata.labels).toEqual({
        'percussionist.dev/project': PROJECT,
        'percussionist.dev/component': 'findings',
      });
      expect(Object.keys(patchArgs.body.data)).toEqual([inboxFindingKey(finding.id)]);
      const stored = patchArgs.body.data[inboxFindingKey(finding.id)];
      expect(stored).toBeDefined();
      expect(JSON.parse(stored as string)).toMatchObject({ id: finding.id });
    } finally {
      fake.restore();
    }
  });

  it('404 → create fallback: create body carries the key and labels (422-key regression)', async () => {
    const fake = installFakeKube({
      patchNamespacedConfigMap: { error: notFound('no findings cm') },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      const finding = makeFinding({ id: '1785144009598-1232b4487768' });
      const result = await appendFindingToConfigMap(PROJECT, finding, NS);

      expect(result).toEqual({ written: true });
      // patch (miss) → create — never a read-modify-write.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'patchNamespacedConfigMap',
        'createNamespacedConfigMap',
      ]);

      const createArgs = fake.calls[1]?.args[0] as {
        namespace: string;
        body: {
          apiVersion: string;
          kind: string;
          metadata: { name: string; namespace: string; labels: Record<string, string> };
          data: Record<string, string>;
        };
      };
      expect(createArgs.namespace).toBe(NS);
      expect(createArgs.body.apiVersion).toBe('v1');
      expect(createArgs.body.kind).toBe('ConfigMap');
      expect(createArgs.body.metadata.name).toBe(CM_NAME);
      expect(createArgs.body.metadata.namespace).toBe(NS);
      expect(createArgs.body.metadata.labels).toEqual({
        'percussionist.dev/project': PROJECT,
        'percussionist.dev/component': 'findings',
      });
      // The key that the API server must accept — `inbox.<id>.json`, never
      // `inbox/<id>.json`.
      const key = singleDataKey(createArgs.body.data);
      expect(key).toBe(inboxFindingKey(finding.id));
      expect(key).toMatch(CONFIGMAP_KEY);
      expect(key.startsWith('inbox.')).toBe(true);
      expect(key.endsWith('.json')).toBe(true);
      const stored = createArgs.body.data[key];
      expect(stored).toBeDefined();
      expect(JSON.parse(stored as string)).toMatchObject({ id: finding.id });
    } finally {
      fake.restore();
    }
  });

  it('non-404 errors rethrow without creating', async () => {
    const fake = installFakeKube({
      patchNamespacedConfigMap: { error: serverError('api is sad') },
    });
    try {
      const finding = makeFinding({ id: 'f1' });
      await expect(appendFindingToConfigMap(PROJECT, finding, NS)).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(fake.calls.map((c) => c.method)).toEqual(['patchNamespacedConfigMap']);
    } finally {
      fake.restore();
    }
  });

  it('a 422-style validation rejection is rethrown, not swallowed (write never silently succeeds)', async () => {
    const fake = installFakeKube({
      patchNamespacedConfigMap: { error: kubeError(422, 'ConfigMap is invalid') },
    });
    try {
      const finding = makeFinding({ id: 'f1' });
      await expect(appendFindingToConfigMap(PROJECT, finding, NS)).rejects.toMatchObject({
        statusCode: 422,
      });
      expect(fake.calls).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  it('end-to-end key charset: every write body key matches [-._a-zA-Z0-9]+ even for hostile ids', async () => {
    const fake = installFakeKube({
      patchNamespacedConfigMap: { error: notFound() },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      // A hostile id that would break the old `inbox/<id>.json` layout.
      const finding = makeFinding({ id: 'a/b:c d#ä' });
      await appendFindingToConfigMap(PROJECT, finding, NS);

      const patchArgs = fake.calls[0]?.args[0] as { body: { data: Record<string, string> } };
      const createArgs = fake.calls[1]?.args[0] as { body: { data: Record<string, string> } };

      // The sanitized key is used consistently across the patch attempt and
      // the create fallback — both are keys the API server will accept.
      const patchKey = singleDataKey(patchArgs.body.data);
      const createKey = singleDataKey(createArgs.body.data);
      expect(patchKey).toMatch(CONFIGMAP_KEY);
      expect(createKey).toMatch(CONFIGMAP_KEY);
      expect(createKey).toBe(patchKey);
      expect(createKey).not.toContain('/');
    } finally {
      fake.restore();
    }
  });
});

describe('getFindingsConfigMap', () => {
  it('returns null when the ConfigMap is missing (404)', async () => {
    const fake = installFakeKube({ readNamespacedConfigMap: { error: notFound() } });
    try {
      const result = await getFindingsConfigMap(PROJECT, NS);
      expect(result).toBeNull();
    } finally {
      fake.restore();
    }
  });

  it('throws on non-404 errors', async () => {
    const fake = installFakeKube({ readNamespacedConfigMap: { error: serverError() } });
    try {
      await expect(getFindingsConfigMap(PROJECT, NS)).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      fake.restore();
    }
  });

  it('returns the data record when the ConfigMap exists', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { value: { data: { 'inbox.f1.json': '{}' } } },
    });
    try {
      const result = await getFindingsConfigMap(PROJECT, NS);
      expect(result).toEqual({ 'inbox.f1.json': '{}' });
      expect(fake.calls[0]?.args[0]).toEqual({ name: CM_NAME, namespace: NS });
    } finally {
      fake.restore();
    }
  });
});

describe('patchFindingsConfigMap', () => {
  it('sends a merge-patch with null deletions preserved in the body', async () => {
    const fake = installFakeKube({ patchNamespacedConfigMap: { value: {} } });
    try {
      await patchFindingsConfigMap(
        PROJECT,
        {
          [inboxFindingKey('f1')]: null,
          [triagedFindingKey('c1')]: JSON.stringify({ id: 'f1' }),
        },
        NS,
      );

      expect(fake.calls.map((c) => c.method)).toEqual(['patchNamespacedConfigMap']);
      const patchArgs = fake.calls[0]?.args[0] as {
        name: string;
        namespace: string;
        body: { data: Record<string, string | null> };
      };
      expect(patchArgs.name).toBe(CM_NAME);
      expect(patchArgs.namespace).toBe(NS);
      // `null` must survive serialization — `undefined` would be stripped by
      // JSON.stringify and the key would never be deleted.
      expect(patchArgs.body.data).toEqual({
        'inbox.f1.json': null,
        'triaged.c1.json': JSON.stringify({ id: 'f1' }),
      });
      expect(patchArgs.body.data['inbox.f1.json']).toBeNull();
    } finally {
      fake.restore();
    }
  });

  it('failure path: non-404 patch errors propagate', async () => {
    const fake = installFakeKube({ patchNamespacedConfigMap: { error: serverError() } });
    try {
      await expect(
        patchFindingsConfigMap(PROJECT, { [inboxFindingKey('f1')]: null }, NS),
      ).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      fake.restore();
    }
  });
});
