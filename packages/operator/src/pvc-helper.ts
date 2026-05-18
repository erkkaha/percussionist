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

import { core } from "@percussionist/kube";
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { API_GROUP_VERSION, KIND_PROJECT } from "@percussionist/api";

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
 *   - RWX (ReadWriteMany) access mode for parallel worker execution
 *   - Owner reference to the Project CR (auto-cleanup on project deletion)
 *   - 10Gi default size
 *
 * @throws If PVC creation fails or project UID is invalid
 */
export async function ensureDataPVC(
  opts: DataPVCOptions,
): Promise<V1PersistentVolumeClaim> {
  const {
    projectName,
    namespace,
    projectUid,
    storageClass,
    size = "10Gi",
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
      (err as { statusCode?: number }).statusCode ??
      (err as { code?: number }).code;
    if (statusCode !== 404) {
      throw err; // Unexpected error
    }
    // PVC doesn't exist, continue to create it
  }

  // Build PVC manifest
  const pvc: V1PersistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        "percussionist.dev/project": projectName,
        "percussionist.dev/component": "data",
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
      accessModes: ["ReadWriteMany"], // RWX for parallel workers
      resources: {
        requests: {
          storage: size,
        },
      },
      ...(storageClass ? { storageClassName: storageClass } : {}),
    },
  };

  // Create PVC
  console.log(
    `[pvc-helper] Creating data PVC ${namespace}/${pvcName} (${size}, RWX)`,
  );
  try {
    const created = await coreApi.createNamespacedPersistentVolumeClaim({
      namespace,
      body: pvc,
    });
    console.log(
      `[pvc-helper] Data PVC ${namespace}/${pvcName} created successfully`,
    );
    return created;
  } catch (err: unknown) {
    const statusCode =
      (err as { statusCode?: number }).statusCode ??
      (err as { code?: number }).code;
    // If PVC was created by another reconcile loop concurrently, treat as success
    if (statusCode === 409) {
      console.log(
        `[pvc-helper] PVC ${namespace}/${pvcName} already exists (created concurrently)`,
      );
      const existing = await coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
      });
      return existing;
    }
    throw err;
  }
}

/**
 * Checks if a PVC is bound and ready to be mounted.
 *
 * @returns true if PVC is in Bound phase, false otherwise
 */
export async function isPVCBound(
  namespace: string,
  pvcName: string,
): Promise<boolean> {
  const coreApi = core();
  try {
    const pvc = await coreApi.readNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace,
    });
    return pvc.status?.phase === "Bound";
  } catch (err: unknown) {
    const statusCode =
      (err as { statusCode?: number }).statusCode ??
      (err as { code?: number }).code;
    if (statusCode === 404) {
      return false; // PVC doesn't exist
    }
    throw err;
  }
}
