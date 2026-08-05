// fake-kube.test.ts — self-test for the operator fake-kube helper. Proves the
// three core contracts (call recording, scripted failure injection, restore)
// against the operator's own clients (reconciler.ts's `co`/`core`) and against
// @percussionist/kube's shared singletons (both resolve through the class
// prototypes the fake spies on).

import { describe, expect, it } from 'bun:test';
import { AppsV1Api, CoreV1Api, CustomObjectsApi, NetworkingV1Api } from '@kubernetes/client-node';
import { core as kubeCore } from '@percussionist/kube';
import { co } from '../reconciler.js';
import {
  conflict,
  installFakeKube,
  kubeError,
  notFound,
  serverError,
  tooManyRequests,
} from './fake-kube.js';

describe('installFakeKube (operator)', () => {
  it("records calls made through the operator's own clients", async () => {
    const fake = installFakeKube({
      getClusterCustomObject: { value: { spec: { runTTLDays: 14 } } },
    });
    try {
      const cs = (await co.getClusterCustomObject({
        group: 'percussionist.dev',
        version: 'v1alpha1',
        plural: 'clustersettings',
        name: 'default',
      })) as { spec: { runTTLDays: number } };
      expect(cs.spec.runTTLDays).toBe(14);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.method).toBe('getClusterCustomObject');
      expect(fake.calls[0]!.args[0]).toEqual({
        group: 'percussionist.dev',
        version: 'v1alpha1',
        plural: 'clustersettings',
        name: 'default',
      });
    } finally {
      fake.restore();
    }
  });

  it('intercepts @percussionist/kube shared singletons via the prototypes', async () => {
    const fake = installFakeKube({
      readNamespacedPod: { value: { metadata: { name: 'run-1' }, status: { phase: 'Running' } } },
    });
    try {
      // kubeCore() returns a CoreV1Api instance — the prototype spy must catch it.
      const pod = await kubeCore().readNamespacedPod({ name: 'run-1', namespace: 'test-ns' });
      expect(pod.metadata?.name).toBe('run-1');
      expect(fake.calls[0]!.method).toBe('readNamespacedPod');
    } finally {
      fake.restore();
    }
  });

  it('covers every prototype the operator touches (core/custom/apps/networking)', async () => {
    const fake = installFakeKube({
      readNamespacedDeployment: { value: { metadata: { name: 'op' } } },
      readNamespacedIngress: { value: { metadata: { name: 'ing' } } },
    });
    try {
      // Use fresh instances: prototype spies apply to any instance.
      const appsClient = new AppsV1Api();
      const netClient = new NetworkingV1Api();
      const dep = await appsClient.readNamespacedDeployment({ name: 'op', namespace: 'n' });
      const ing = await netClient.readNamespacedIngress({ name: 'ing', namespace: 'n' });
      expect(dep.metadata?.name).toBe('op');
      expect(ing.metadata?.name).toBe('ing');
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedDeployment',
        'readNamespacedIngress',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('injects scripted failures with statusCode (404/409/429/500)', async () => {
    const fake = installFakeKube({
      getNamespacedCustomObject: { error: notFound('project missing') },
      patchNamespacedCustomObjectStatus: { error: conflict() },
      listNamespacedCustomObject: { error: tooManyRequests() },
      readNamespacedService: { error: serverError() },
    });
    try {
      await expect(
        co.getNamespacedCustomObject({
          group: 'g',
          version: 'v',
          namespace: 'n',
          plural: 'projects',
          name: 'proj',
        }),
      ).rejects.toMatchObject({ statusCode: 404, message: 'project missing' });
      await expect(
        co.patchNamespacedCustomObjectStatus(
          { group: 'g', version: 'v', namespace: 'n', plural: 'runs', name: 'r', body: {} },
          undefined as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        co.listNamespacedCustomObject({ group: 'g', version: 'v', namespace: 'n', plural: 'runs' }),
      ).rejects.toMatchObject({ statusCode: 429 });
      await expect(
        kubeCore().readNamespacedService({ name: 's', namespace: 'n' }),
      ).rejects.toMatchObject({
        statusCode: 500,
      });
    } finally {
      fake.restore();
    }
  });

  it('supports kubeError with an arbitrary status code', () => {
    expect(kubeError(503, 'unavailable').statusCode).toBe(503);
  });

  it('sequences array scripts left-to-right with the last entry repeating', async () => {
    const fake = installFakeKube({
      patchNamespacedCustomObjectStatus: [
        { error: conflict('stale resourceVersion') },
        { value: { status: { phase: 'Failed' } } },
      ],
    });
    try {
      const args = {
        group: 'g',
        version: 'v',
        namespace: 'n',
        plural: 'runs',
        name: 'r',
        body: { status: { phase: 'Failed' } },
      } as never;
      await expect(
        co.patchNamespacedCustomObjectStatus(args, undefined as never),
      ).rejects.toMatchObject({ statusCode: 409 });
      const res = await co.patchNamespacedCustomObjectStatus(args, undefined as never);
      expect((res as { status: { phase: string } }).status.phase).toBe('Failed');
      expect(fake.calls).toHaveLength(2);
    } finally {
      fake.restore();
    }
  });

  it('exhausts the script after a final `once` entry', async () => {
    const fake = installFakeKube({
      deleteNamespacedCustomObject: [{ once: { value: undefined } }],
    });
    try {
      await co.deleteNamespacedCustomObject({
        group: 'g',
        version: 'v',
        namespace: 'n',
        plural: 'runs',
        name: 'r',
      });
      await expect(
        co.deleteNamespacedCustomObject({
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
      await expect(
        kubeCore().readNamespacedConfigMap({ name: 'x', namespace: 'n' }),
      ).rejects.toThrow(/no scripted response for method "readNamespacedConfigMap"/);
      expect(fake.calls).toEqual([
        { method: 'readNamespacedConfigMap', args: [{ name: 'x', namespace: 'n' }] },
      ]);
    } finally {
      fake.restore();
    }
  });

  it('restores the real prototype implementations when restore() is called', async () => {
    const originalPod = CoreV1Api.prototype.readNamespacedPod;
    const originalCustom = CustomObjectsApi.prototype.getClusterCustomObject;
    const fake = installFakeKube({
      readNamespacedPod: { value: { metadata: { name: 'p' } } },
      getClusterCustomObject: { value: { metadata: { name: 'a' } } },
    });
    expect(CoreV1Api.prototype.readNamespacedPod).not.toBe(originalPod);
    expect(CustomObjectsApi.prototype.getClusterCustomObject).not.toBe(originalCustom);

    fake.restore();

    expect(CoreV1Api.prototype.readNamespacedPod).toBe(originalPod);
    expect(CustomObjectsApi.prototype.getClusterCustomObject).toBe(originalCustom);
  });

  it('supports installing, restoring, and reinstalling with fresh scripts', async () => {
    const fake1 = installFakeKube({ readNamespacedPod: { value: { metadata: { name: 'a' } } } });
    await kubeCore().readNamespacedPod({ name: 'a', namespace: 'n' });
    expect(fake1.calls).toHaveLength(1);
    fake1.restore();

    const fake2 = installFakeKube({ readNamespacedPod: { value: { metadata: { name: 'b' } } } });
    try {
      const pod = await kubeCore().readNamespacedPod({ name: 'b', namespace: 'n' });
      expect(pod.metadata?.name).toBe('b');
      expect(fake1.calls).toHaveLength(1); // first fake's log is a snapshot
      expect(fake2.calls).toHaveLength(1);
    } finally {
      fake2.restore();
    }
  });
});
