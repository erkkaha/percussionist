// writes-plan-cm.test.ts — write-path regression tests for writePlanToConfigMap
// and readPlanFromConfigMap.
//
// The plans ConfigMap is the store for PLAN artifacts ({task}.md keys in a
// {project}-plans ConfigMap). Writes use a conflict-free per-key merge-patch
// (setting only `data["{task}.md"]`) so concurrent plan writers never clobber
// each other — mirroring the findings ConfigMap path. These tests drive the
// write branches (patch fast path, 404 → create, create-409 → retry patch)
// through the recording fake-kube helper and assert on the exact request
// bodies and call sequences sent to the API server.

import { describe, expect, it } from 'bun:test';
import { plansDataKey, readPlanFromConfigMap, writePlanToConfigMap } from '../index.js';
import { conflict, installFakeKube, notFound, serverError } from './helpers/fake-kube.js';

const NS = 'test-ns';
const PROJECT = 'my-proj';
const CM_NAME = `${PROJECT}-plans`;

// ConfigMap data keys must match this charset (the API server rejects anything
// else with 422). This is the contract plansDataKey must always satisfy.
const CONFIGMAP_KEY = /^[-._a-zA-Z0-9]+$/;

/** Extract the single key of a ConfigMap data record, failing loudly if absent. */
function singleDataKey(data: Record<string, string>): string {
  const [key] = Object.keys(data);
  if (!key) throw new Error(`expected exactly one data key, got ${Object.keys(data).length}`);
  return key;
}

const LABELS = {
  'percussionist.dev/project': PROJECT,
  'percussionist.dev/component': 'plans',
};

describe('plansDataKey', () => {
  it('leaves DNS-1123 task names untouched', () => {
    expect(plansDataKey('plan-1')).toBe('plan-1.md');
    expect(plansDataKey('percussionist-dev-plan-rev17')).toBe('percussionist-dev-plan-rev17.md');
  });

  it('sanitizes hostile task names into a valid ConfigMap data key', () => {
    // A hostile name that would break the naive `{task}.md` key and get the
    // write rejected with a 422 (ConfigMap data key charset [-._a-zA-Z0-9]+).
    const key = plansDataKey('a/b:c d#ä');
    expect(key).toMatch(CONFIGMAP_KEY);
    expect(key).not.toContain('/');
    expect(key).toBe('a_b_c_d_.md');
  });
});

describe('writePlanToConfigMap', () => {
  it('patch fast path: merge-patch body carries a single {task}.md key and labels', async () => {
    const fake = installFakeKube({
      // Best-effort read for the advisory warning.
      readNamespacedConfigMap: {
        value: { metadata: { name: CM_NAME, namespace: NS }, data: { 'other.md': 'x' } },
      },
      patchNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-1', '# Plan content', NS);

      // Return shape contract — consumed by the dispatcher and manager
      // write_plan handlers.
      expect(result).toEqual({
        written: true,
        sizeBytes: Buffer.byteLength('# Plan content', 'utf8'),
        warning: undefined,
      });

      // Read (warning) → patch. Never a read-modify-write replace: the merge
      // patch sets only the single plan key.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
      ]);

      const patchArgs = fake.calls[1]?.args[0] as {
        name: string;
        namespace: string;
        body: { metadata: { labels: Record<string, string> }; data: Record<string, string> };
      };
      expect(patchArgs.name).toBe(CM_NAME);
      expect(patchArgs.namespace).toBe(NS);
      expect(patchArgs.body.metadata.labels).toEqual(LABELS);
      // Exactly one key — the plan being written — never the whole merged map.
      const key = singleDataKey(patchArgs.body.data);
      expect(key).toBe('plan-1.md');
      expect(patchArgs.body.data['plan-1.md']).toBe('# Plan content');
    } finally {
      fake.restore();
    }
  });

  it('404 → create fallback: create body carries the {task}.md key and labels', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound('no plans cm') },
      patchNamespacedConfigMap: { error: notFound('no plans cm') },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-1', '# Plan content', NS);

      expect(result).toEqual({
        written: true,
        sizeBytes: Buffer.byteLength('# Plan content', 'utf8'),
        warning: undefined,
      });

      // Read (warning) → patch (miss) → create — never a replace.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
        'createNamespacedConfigMap',
      ]);

      const createArgs = fake.calls[2]?.args[0] as {
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
      expect(createArgs.body.metadata.labels).toEqual(LABELS);
      const key = singleDataKey(createArgs.body.data);
      expect(key).toBe('plan-1.md');
      expect(key).toMatch(CONFIGMAP_KEY);
      expect(createArgs.body.data['plan-1.md']).toBe('# Plan content');
    } finally {
      fake.restore();
    }
  });

  it('concurrent-writer scenario: create-409 falls back to retrying the patch, no throw', async () => {
    // Two writers race: the read 404s, the first patch 404s, another writer
    // creates the ConfigMap first so our create 409s — the write must loop
    // back to the merge-patch (which now succeeds) instead of losing the
    // artifact.
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound('no plans cm') },
      patchNamespacedConfigMap: [{ error: notFound('no plans cm') }, { value: {} }],
      createNamespacedConfigMap: { error: conflict('already exists') },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-race', 'race content', NS);

      expect(result).toEqual({
        written: true,
        sizeBytes: Buffer.byteLength('race content', 'utf8'),
        warning: undefined,
      });

      // Read → patch (miss) → create (409) → patch (ok).
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
        'createNamespacedConfigMap',
        'patchNamespacedConfigMap',
      ]);

      // The retried patch carries the same single key the original attempt did.
      const retried = fake.calls[3]?.args[0] as { body: { data: Record<string, string> } };
      const key = singleDataKey(retried.body.data);
      expect(key).toBe('plan-race.md');
      expect(retried.body.data['plan-race.md']).toBe('race content');
    } finally {
      fake.restore();
    }
  });

  it('warning is computed from a scripted read of existing plans, not just the new content', async () => {
    // The new content is tiny; the merged total crosses the 900KB line only
    // because the (best-effort) read reports a big existing plan.
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          metadata: { name: CM_NAME, namespace: NS },
          data: { 'huge-plan.md': 'x'.repeat(930 * 1024) },
        },
      },
      patchNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-tiny', 'tiny', NS);
      expect(result.written).toBe(true);
      expect(result.sizeBytes).toBe(Buffer.byteLength('tiny', 'utf8'));
      expect(result.warning).toMatch(/approaching 1MB limit/);
      expect(result.warning).toContain('930KB');
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('does not warn when the merged size stays under the threshold', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: { metadata: { name: CM_NAME, namespace: NS }, data: { 'small.md': 'x' } },
      },
      patchNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-small', 'tiny', NS);
      expect(result.warning).toBeUndefined();
    } finally {
      fake.restore();
    }
  });

  it('warning is skipped when the best-effort read fails, and the write still succeeds', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: serverError('api is sad') },
      patchNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-1', 'content', NS);
      expect(result.written).toBe(true);
      expect(result.warning).toBeUndefined();
      // The failing read never short-circuits the write.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('non-404 patch errors rethrow without creating', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound() },
      patchNamespacedConfigMap: { error: serverError('api is sad') },
    });
    try {
      await expect(writePlanToConfigMap(PROJECT, 'plan-1', 'content', NS)).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'patchNamespacedConfigMap',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('hostile task names are sanitized to a valid key on both the patch and create bodies', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound() },
      patchNamespacedConfigMap: { error: notFound() },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      await writePlanToConfigMap(PROJECT, 'a/b:c d#ä', 'hostile', NS);

      const patchArgs = fake.calls[1]?.args[0] as { body: { data: Record<string, string> } };
      const createArgs = fake.calls[2]?.args[0] as { body: { data: Record<string, string> } };
      const patchKey = singleDataKey(patchArgs.body.data);
      const createKey = singleDataKey(createArgs.body.data);
      expect(patchKey).toMatch(CONFIGMAP_KEY);
      expect(createKey).toMatch(CONFIGMAP_KEY);
      expect(createKey).toBe(patchKey);
      expect(createKey).toBe(plansDataKey('a/b:c d#ä'));
      expect(createKey).not.toContain('/');
    } finally {
      fake.restore();
    }
  });
});

describe('readPlanFromConfigMap', () => {
  it('reads the sanitized {task}.md key', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          metadata: { name: CM_NAME, namespace: NS },
          data: { 'a_b_c_d_.md': 'hostile plan' },
        },
      },
    });
    try {
      const result = await readPlanFromConfigMap(PROJECT, 'a/b:c d#ä', NS);
      expect(result).toBe('hostile plan');
      expect(fake.calls[0]?.args[0]).toEqual({ name: CM_NAME, namespace: NS });
    } finally {
      fake.restore();
    }
  });

  it('returns null when the ConfigMap is missing', async () => {
    const fake = installFakeKube({ readNamespacedConfigMap: { error: notFound() } });
    try {
      expect(await readPlanFromConfigMap(PROJECT, 'plan-1', NS)).toBeNull();
    } finally {
      fake.restore();
    }
  });

  it('returns null when the key is absent from an existing ConfigMap', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: { metadata: { name: CM_NAME, namespace: NS }, data: { 'other.md': 'x' } },
      },
    });
    try {
      expect(await readPlanFromConfigMap(PROJECT, 'plan-1', NS)).toBeNull();
    } finally {
      fake.restore();
    }
  });
});
