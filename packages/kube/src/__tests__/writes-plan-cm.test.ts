// writes-plan-cm.test.ts — write-path regression tests for writePlanToConfigMap.
//
// The plans ConfigMap is the store for PLAN artifacts ({task}.md keys in a
// {project}-plans ConfigMap). These tests drive the two write branches (create
// when the ConfigMap is missing, replace when it exists) through the recording
// fake-kube helper and assert on the exact request bodies sent to the API
// server — the write side that was previously untested.

import { describe, expect, it } from 'bun:test';
import { writePlanToConfigMap } from '../index.js';
import { installFakeKube, notFound } from './helpers/fake-kube.js';

const NS = 'test-ns';
const PROJECT = 'my-proj';
const CM_NAME = `${PROJECT}-plans`;

describe('writePlanToConfigMap', () => {
  it('create path: no existing ConfigMap → createNamespacedConfigMap with a {task}.md key', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound('no plans cm') },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-1', '# Plan content', NS);

      expect(result).toEqual({
        written: true,
        sizeBytes: Buffer.byteLength('# Plan content', 'utf8'),
        warning: undefined,
      });

      // Only the read (miss) and the create are recorded — never a replace.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'createNamespacedConfigMap',
      ]);
      expect(fake.calls[0]?.args[0]).toEqual({ name: CM_NAME, namespace: NS });

      const createArgs = fake.calls[1]?.args[0] as {
        namespace: string;
        body: {
          apiVersion: string;
          kind: string;
          metadata: Record<string, unknown>;
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
        'percussionist.dev/component': 'plans',
      });
      expect(createArgs.body.data).toEqual({ 'plan-1.md': '# Plan content' });
    } finally {
      fake.restore();
    }
  });

  it('replace path: existing ConfigMap with resourceVersion → replaceNamespacedConfigMap', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: CM_NAME, namespace: NS, resourceVersion: '42' },
          data: { 'old-plan.md': 'old content' },
        },
      },
      replaceNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-2', 'new content', NS);

      expect(result.written).toBe(true);
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedConfigMap',
        'replaceNamespacedConfigMap',
      ]);

      const replaceArgs = fake.calls[1]?.args[0] as {
        name: string;
        namespace: string;
        body: { metadata: Record<string, unknown>; data: Record<string, string> };
      };
      expect(replaceArgs.name).toBe(CM_NAME);
      expect(replaceArgs.namespace).toBe(NS);
      // The existing resourceVersion is carried through so the API server's
      // optimistic concurrency check passes.
      expect(replaceArgs.body.metadata.resourceVersion).toBe('42');
      expect(replaceArgs.body.data).toEqual({
        'old-plan.md': 'old content',
        'plan-2.md': 'new content',
      });
    } finally {
      fake.restore();
    }
  });

  it('merged data preserves existing keys on the create path too', async () => {
    // read returns 404 but the "existing" placeholder starts empty; the merge
    // with existing.data must not drop anything already in the CM (here the
    // CM exists so replace is used — this guards the spread of existing.data).
    const fake = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          metadata: { name: CM_NAME, namespace: NS, resourceVersion: '7' },
          data: { 'keep-me.md': 'keep' },
        },
      },
      replaceNamespacedConfigMap: { value: {} },
    });
    try {
      await writePlanToConfigMap(PROJECT, 'plan-3', 'third', NS);
      const replaceArgs = fake.calls[1]?.args[0] as {
        body: { data: Record<string, string> };
      };
      expect(replaceArgs.body.data).toEqual({
        'keep-me.md': 'keep',
        'plan-3.md': 'third',
      });
    } finally {
      fake.restore();
    }
  });

  it('warns when the merged data size crosses the 900KB soft threshold', async () => {
    const big = 'x'.repeat(930 * 1024); // ~930 KB, over the 900 KB warning line
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound() },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-big', big, NS);
      expect(result.written).toBe(true);
      expect(result.sizeBytes).toBe(big.length);
      expect(result.warning).toMatch(/approaching 1MB limit/);
      expect(result.warning).toContain('930KB');
    } finally {
      fake.restore();
    }
  });

  it('does not warn when the content is small', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: notFound() },
      createNamespacedConfigMap: { value: {} },
    });
    try {
      const result = await writePlanToConfigMap(PROJECT, 'plan-small', 'tiny', NS);
      expect(result.warning).toBeUndefined();
    } finally {
      fake.restore();
    }
  });

  it('failure path: a non-404 read error propagates instead of creating', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { error: Object.assign(new Error('boom'), { statusCode: 500 }) },
    });
    try {
      await expect(writePlanToConfigMap(PROJECT, 'plan-1', 'content', NS)).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(fake.calls.map((c) => c.method)).toEqual(['readNamespacedConfigMap']);
    } finally {
      fake.restore();
    }
  });
});
