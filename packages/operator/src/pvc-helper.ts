// PVC helper for creating and managing data PersistentVolumeClaims.
//
// Each Project gets a shared data PVC that holds:
//   - Package manager caches  (/data/cache/pnpm, /data/cache/npm, etc.)
//   - Git bare mirrors         (/data/git-mirrors/{url-hash}/)
//   - Per-run worktrees        (/data/worktrees/{run-name}/)
//   - Local git workspace      (/data/workspace/)
//
// The PVC is owned by the Project CR and is automatically garbage-collected
// when the project is deleted.

import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { API_GROUP_VERSION, KIND_PROJECT } from '@percussionist/api';
import { core } from '@percussionist/kube';
import {
  DEFAULT_STORAGE_ACCESS_MODE,
  DEFAULT_STORAGE_CLASS,
  DEFAULT_STORAGE_SIZE,
} from './config.js';

export interface DataPVCOptions {
  projectName: string;
  namespace: string;
  projectUid: string;
  storageClass?: string;
  size?: string;
  pvcName?: string;
}

/**
 * Ensures a data PVC exists for the given project. Idempotent — succeeds if
 * PVC already exists. Creates the PVC with:
 *   - Configurable access mode (default ReadWriteOnce for minikube compat)
 *   - Owner reference to the Project CR (auto-cleanup on project deletion)
 *   - 50Gi default size
 *
 * @throws If PVC creation fails or project UID is invalid
 */
export async function ensureDataPVC(opts: DataPVCOptions): Promise<V1PersistentVolumeClaim> {
  const {
    projectName,
    namespace,
    projectUid,
    storageClass,
    size = DEFAULT_STORAGE_SIZE,
    pvcName = `${projectName}-data`,
  } = opts;

  const coreApi = core();

  // Check if PVC already exists
  try {
    const existing = await coreApi.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace,
    });
    console.log(
      `[pvc-helper] PVC ${namespace}/${pvcName} already exists (${existing.status?.phase})`,
    );
    return existing;
  } catch (err: unknown) {
    const statusCode =
      (err as { statusCode?: number }).statusCode ?? (err as { code?: number }).code;
    if (statusCode !== 404) {
      throw err; // Unexpected error
    }
    // PVC doesn't exist, continue to create it
  }

  // Build PVC manifest
  const pvc: V1PersistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        'percussionist.dev/project': projectName,
        'percussionist.dev/component': 'data',
      },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name: projectName,
          uid: projectUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      accessModes: [DEFAULT_STORAGE_ACCESS_MODE],
      resources: {
        requests: {
          storage: size,
        },
      },
      storageClassName: storageClass ?? DEFAULT_STORAGE_CLASS,
    },
  };

  // Create PVC
  console.log(
    `[pvc-helper] Creating data PVC ${namespace}/${pvcName} (${size}, ${DEFAULT_STORAGE_ACCESS_MODE})`,
  );
  try {
    const created = await coreApi.createNamespacedPersistentVolumeClaim({
      namespace,
      body: pvc,
    });
    console.log(`[pvc-helper] Data PVC ${namespace}/${pvcName} created successfully`);
    return created;
  } catch (err: unknown) {
    const statusCode =
      (err as { statusCode?: number }).statusCode ?? (err as { code?: number }).code;
    // If PVC was created by another reconcile loop concurrently, treat as success
    if (statusCode === 409) {
      console.log(`[pvc-helper] PVC ${namespace}/${pvcName} already exists (created concurrently)`);
      const existing = await coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
      });
      return existing;
    }
    throw err;
  }
}
