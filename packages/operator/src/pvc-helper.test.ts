// pvc-helper.test.ts — unit tests for ensureDataPVC() driven through the
// BUILD-1 recording fake kube client. The helper talks to core() from
// @percussionist/kube, whose CoreV1Api instance methods are intercepted on
// CoreV1Api.prototype.

import { describe, expect, it } from 'bun:test';
import { API_GROUP_VERSION, KIND_PROJECT } from '@percussionist/api';
import {
  DEFAULT_STORAGE_ACCESS_MODE,
  DEFAULT_STORAGE_CLASS,
  DEFAULT_STORAGE_SIZE,
} from './config.js';
import { type DataPVCOptions, ensureDataPVC } from './pvc-helper.js';
import { conflict, installFakeKube, notFound, serverError } from './test-helpers/fake-kube.js';

const opts: DataPVCOptions = {
  projectName: 'proj',
  namespace: 'ns',
  projectUid: 'uid-1',
};

const existingPvc = {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name: 'proj-data', namespace: 'ns' },
  status: { phase: 'Bound' },
};

interface CreateBody {
  metadata: {
    name: string;
    labels: Record<string, string>;
    ownerReferences: unknown[];
  };
  spec: {
    accessModes: string[];
    resources: { requests: { storage: string } };
    storageClassName: string;
  };
}

describe('ensureDataPVC', () => {
  it('returns the existing PVC as-is when it is already present (no create call)', async () => {
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { value: existingPvc },
    });
    try {
      const pvc = await ensureDataPVC(opts);

      expect(pvc).toBe(existingPvc);
      expect(fake.calls.map((c) => c.method)).toEqual(['readNamespacedPersistentVolumeClaim']);
    } finally {
      fake.restore();
    }
  });

  it('creates the PVC on 404 with ownerReference, labels, access mode, size, and storage class', async () => {
    const created = { ...existingPvc, status: undefined };
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { value: created },
    });
    try {
      const pvc = await ensureDataPVC({ ...opts, storageClass: 'longhorn-rwx', size: '10Gi' });

      expect(pvc).toBe(created);
      const createCall = fake.calls.find(
        (c) => c.method === 'createNamespacedPersistentVolumeClaim',
      );
      const body = createCall?.args[0]?.body as CreateBody;
      expect(body.metadata.name).toBe('proj-data');
      expect(body.metadata.labels).toEqual({
        'percussionist.dev/project': 'proj',
        'percussionist.dev/component': 'data',
      });
      expect(body.metadata.ownerReferences).toEqual([
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name: 'proj',
          uid: 'uid-1',
          controller: true,
          blockOwnerDeletion: true,
        },
      ]);
      expect(body.spec.accessModes).toEqual(['ReadWriteOnce']);
      expect(body.spec.resources.requests.storage).toBe('10Gi');
      expect(body.spec.storageClassName).toBe('longhorn-rwx');
    } finally {
      fake.restore();
    }
  });

  it('uses config defaults for storage when no overrides are provided', async () => {
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { value: existingPvc },
    });
    try {
      await ensureDataPVC(opts);

      const createCall = fake.calls.find(
        (c) => c.method === 'createNamespacedPersistentVolumeClaim',
      );
      const body = createCall?.args[0]?.body as CreateBody;
      expect(body.spec.accessModes).toEqual([DEFAULT_STORAGE_ACCESS_MODE]);
      expect(body.spec.resources.requests.storage).toBe(DEFAULT_STORAGE_SIZE);
      expect(body.spec.storageClassName).toBe(DEFAULT_STORAGE_CLASS);
    } finally {
      fake.restore();
    }
  });

  it('read-backs and returns the existing PVC when create races with a 409', async () => {
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: [{ error: notFound() }, { value: existingPvc }],
      createNamespacedPersistentVolumeClaim: { error: conflict('already exists') },
    });
    try {
      const pvc = await ensureDataPVC(opts);

      expect(pvc).toBe(existingPvc);
      // read (existence check) + create (409) + read-back
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedPersistentVolumeClaim',
        'createNamespacedPersistentVolumeClaim',
        'readNamespacedPersistentVolumeClaim',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('rethrows a non-404 read error', async () => {
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: serverError() },
    });
    try {
      await expect(ensureDataPVC(opts)).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      fake.restore();
    }
  });

  it('rethrows a non-409 create error', async () => {
    const fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { error: serverError() },
    });
    try {
      await expect(ensureDataPVC(opts)).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      fake.restore();
    }
  });
});
