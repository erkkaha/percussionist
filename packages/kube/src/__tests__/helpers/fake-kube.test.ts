// fake-kube.test.ts — self-test for the kube fake-kube helper. Proves the
// three core contracts: call recording, scripted failure injection, and
// restore. Also covers `once`/array sequencing and the strict-oracle
// behavior for unscripted universe methods.

import { describe, expect, it } from 'bun:test';
import { apps, core, custom } from '../../index.js';
import {
  conflict,
  installFakeKube,
  kubeError,
  notFound,
  serverError,
  tooManyRequests,
} from './fake-kube.js';

describe('installFakeKube (kube)', () => {
  it('records every intercepted call as { method, args }', async () => {
    const fake = installFakeKube({
      readNamespacedConfigMap: { value: { data: { 'a.md': 'hello' } } },
    });
    try {
      const res = await core().readNamespacedConfigMap({
        name: 'my-proj-plans',
        namespace: 'test-ns',
      });
      expect(res.data?.['a.md']).toBe('hello');
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.method).toBe('readNamespacedConfigMap');
      expect(fake.calls[0]!.args[0]).toEqual({ name: 'my-proj-plans', namespace: 'test-ns' });
    } finally {
      fake.restore();
    }
  });

  it('records calls to every singleton (core, custom, apps)', async () => {
    const fake = installFakeKube({
      getNamespacedCustomObject: { value: { metadata: { name: 'proj' } } },
      readNamespacedDeployment: { value: { spec: { template: { spec: { containers: [] } } } } },
    });
    try {
      await custom().getNamespacedCustomObject({
        group: 'percussionist.dev',
        version: 'v1alpha1',
        namespace: 'test-ns',
        plural: 'projects',
        name: 'proj',
      });
      await apps().readNamespacedDeployment({ name: 'op', namespace: 'percussionist' });
      expect(fake.calls.map((c) => c.method)).toEqual([
        'getNamespacedCustomObject',
        'readNamespacedDeployment',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('injects scripted 404 failures that kube helpers observe', async () => {
    const fake = installFakeKube({ readNamespacedConfigMap: { error: notFound('no such cm') } });
    try {
      await expect(
        core().readNamespacedConfigMap({ name: 'x', namespace: 'n' }),
      ).rejects.toMatchObject({ statusCode: 404, message: 'no such cm' });
    } finally {
      fake.restore();
    }
  });

  it('injects 409 / 429 / 500 failures', async () => {
    const fake = installFakeKube({
      patchNamespacedConfigMap: { error: conflict() },
      listNamespacedPod: { error: tooManyRequests() },
      deleteNamespacedPod: { error: serverError() },
    });
    try {
      await expect(
        core().patchNamespacedConfigMap(
          { name: 'x', namespace: 'n', body: {} },
          undefined as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(core().listNamespacedPod({ namespace: 'n' })).rejects.toMatchObject({
        statusCode: 429,
      });
      await expect(core().deleteNamespacedPod({ name: 'p', namespace: 'n' })).rejects.toMatchObject(
        {
          statusCode: 500,
        },
      );
    } finally {
      fake.restore();
    }
  });

  it('supports kubeError with an arbitrary status code (e.g. 422)', () => {
    expect(kubeError(422, 'bad key').statusCode).toBe(422);
  });

  it('sequences array scripts left-to-right with the last entry repeating', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: conflict('stale resourceVersion') },
        { value: { status: { phase: 'Running' } } },
      ],
    });
    try {
      const first = custom().patchNamespacedCustomObjectStatus(
        { group: 'g', version: 'v', namespace: 'n', plural: 'runs', name: 'r', body: {} },
        undefined as never,
      );
      await expect(first).rejects.toMatchObject({ statusCode: 409 });
      // Retry succeeds, and keeps succeeding (last entry repeats).
      const res = await custom().patchNamespacedCustomObjectStatus(
        { group: 'g', version: 'v', namespace: 'n', plural: 'runs', name: 'r', body: {} },
        undefined as never,
      );
      expect(res.status.phase).toBe('Running');
      const again = await custom().patchNamespacedCustomObjectStatus(
        { group: 'g', version: 'v', namespace: 'n', plural: 'runs', name: 'r', body: {} },
        undefined as never,
      );
      expect(again.status.phase).toBe('Running');
      expect(fake.calls).toHaveLength(3);
    } finally {
      fake.restore();
    }
  });

  it('exhausts the script after a final `once` entry', async () => {
    const fake = installFakeKube({
      deleteNamespacedCustomObject: [{ once: { value: undefined } }],
    });
    try {
      await custom().deleteNamespacedCustomObject({
        group: 'g',
        version: 'v',
        namespace: 'n',
        plural: 'runs',
        name: 'r',
      });
      await expect(
        custom().deleteNamespacedCustomObject({
          group: 'g',
          version: 'v',
          namespace: 'n',
          plural: 'runs',
          name: 'r',
        }),
      ).rejects.toThrow(/script exhausted for method "deleteNamespacedCustomObject"/);
    } finally {
      fake.restore();
    }
  });

  it('rejects unscripted universe methods loudly (strict oracle)', async () => {
    const fake = installFakeKube({ readNamespacedPod: { value: { metadata: { name: 'p' } } } });
    try {
      await expect(core().listNamespacedEvent({ namespace: 'n' })).rejects.toThrow(
        /no scripted response for method "listNamespacedEvent"/,
      );
      // The unscripted call is still recorded so the failure is debuggable.
      expect(fake.calls).toEqual([{ method: 'listNamespacedEvent', args: [{ namespace: 'n' }] }]);
    } finally {
      fake.restore();
    }
  });

  it('restores the real implementations when restore() is called', async () => {
    const originalRead = core().readNamespacedConfigMap;
    const originalPatch = custom().patchNamespacedCustomObjectStatus;
    const fake = installFakeKube({
      readNamespacedConfigMap: { value: { data: {} } },
      patchNamespacedCustomObjectStatus: { value: { status: {} } },
    });
    expect(core().readNamespacedConfigMap).not.toBe(originalRead);
    expect(custom().patchNamespacedCustomObjectStatus).not.toBe(originalPatch);

    fake.restore();

    expect(core().readNamespacedConfigMap).toBe(originalRead);
    expect(custom().patchNamespacedCustomObjectStatus).toBe(originalPatch);
    // No calls were made against this fake, so its log stays empty.
    expect(fake.calls).toHaveLength(0);
  });

  it('supports installing, restoring, and reinstalling with fresh scripts', async () => {
    const fake1 = installFakeKube({ readNamespacedConfigMap: { value: { data: { a: '1' } } } });
    await core().readNamespacedConfigMap({ name: 'x', namespace: 'n' });
    expect(fake1.calls).toHaveLength(1);
    fake1.restore();

    const fake2 = installFakeKube({ readNamespacedConfigMap: { value: { data: { b: '2' } } } });
    try {
      const res = await core().readNamespacedConfigMap({ name: 'y', namespace: 'n' });
      expect(res.data?.b).toBe('2');
      expect(res.data?.a).toBeUndefined();
      // The first fake's log is a snapshot — the second install did not touch it.
      expect(fake1.calls).toHaveLength(1);
      expect(fake2.calls).toHaveLength(1);
    } finally {
      fake2.restore();
    }
  });
});
