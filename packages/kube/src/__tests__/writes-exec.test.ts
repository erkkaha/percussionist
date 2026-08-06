// writes-exec.test.ts — regression tests for execInWorkspace.
//
// execInWorkspace spawns a one-shot `ws-exec-*` pod to run a command against
// the project's data PVC, polls it to a terminal phase, grabs logs, and deletes
// the pod. It accepts optional `client`/`getProjectFn`/`pollIntervalMs` seams
// (defaulting to the live core() client, getProject, and a 2s poll) so tests
// can drive the whole lifecycle through the recording fake-kube helper without
// a cluster.

import { describe, expect, it } from 'bun:test';
import { DEFAULT_EXEC_IMAGE, type Project } from '@percussionist/api';
import { core, execInWorkspace } from '../index.js';
import { installFakeKube, notFound, serverError } from './helpers/fake-kube.js';

const NS = 'test-ns';
const PROJECT = 'my-proj';

// Minimal project fixture — only the fields execInWorkspace reads matter.
const projectFixture = (overrides: { execImage?: string; pvcName?: string } = {}): Project =>
  ({
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name: PROJECT, namespace: NS },
    spec: {
      ...(overrides.execImage ? { exec: { image: overrides.execImage } } : {}),
      ...(overrides.pvcName ? { data: { pvcName: overrides.pvcName } } : {}),
    },
  }) as Project;

// Helper to extract the pod body from the recorded createNamespacedPod call.
function createdPodBody(calls: { method: string; args: unknown[] }[]) {
  const call = calls.find((c) => c.method === 'createNamespacedPod');
  if (!call) throw new Error('createNamespacedPod was never called');
  return (call.args[0] as { namespace: string; body: Record<string, unknown> }).body as {
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    spec: {
      restartPolicy: string;
      containers: {
        name: string;
        image: string;
        command: string[];
        volumeMounts: { name: string; mountPath: string }[];
      }[];
      volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
    };
  };
}

// One pod-method script used by every test that reaches the poll loop.
const podLifecycleScript = (phase: 'Succeeded' | 'Failed', exitCode: number) => ({
  createNamespacedPod: { value: {} },
  readNamespacedPod: {
    value: {
      status: {
        phase,
        containerStatuses: [{ state: { terminated: { exitCode } } }],
      },
    },
  },
  readNamespacedPodLog: { value: 'hello from the pod' },
  deleteNamespacedPod: { value: undefined },
});

describe('execInWorkspace — pod create body', () => {
  it('sanitizes and caps the pod name (63 chars, [a-z0-9-])', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        'My_Project_Name_That_Is_Far_Too_Long_For_A_Pod_Name',
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.metadata.name).toMatch(/^[a-z0-9-]+$/);
      expect(pod.metadata.name.length).toBeLessThanOrEqual(63);
      expect(pod.metadata.name.startsWith('ws-exec-')).toBe(true);
      expect(pod.metadata.namespace).toBe(NS);
      expect(pod.metadata.labels).toEqual({
        'app.kubernetes.io/managed-by': 'percussionist',
        'percussionist.dev/component': 'ws-exec',
        'percussionist.dev/project': 'My_Project_Name_That_Is_Far_Too_Long_For_A_Pod_Name',
      });
    } finally {
      fake.restore();
    }
  });

  it('uses spec.data.pvcName when set, else {project}-data', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture({ pvcName: 'custom-pvc' }),
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe('custom-pvc');
      expect(pod.spec.containers[0]?.volumeMounts[0]).toEqual({ name: 'data', mountPath: '/data' });
    } finally {
      fake.restore();
    }
  });

  it('defaults the PVC claim to {project}-data when the project sets no pvcName', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(`${PROJECT}-data`);
    } finally {
      fake.restore();
    }
  });

  it('mounts the given mountPath on the exec container', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'ls',
        '/mnt/custom',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.spec.containers[0]?.volumeMounts).toEqual([
        { name: 'data', mountPath: '/mnt/custom' },
      ]);
    } finally {
      fake.restore();
    }
  });

  it('image precedence: imageOverride > spec.exec.image > DEFAULT_EXEC_IMAGE', async () => {
    // spec.exec.image wins over the default.
    let fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture({ execImage: 'project-exec:1' }),
        1,
      );
      expect(createdPodBody(fake.calls).spec.containers[0]?.image).toBe('project-exec:1');
    } finally {
      fake.restore();
    }

    // imageOverride beats spec.exec.image.
    fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        'override-image:2',
        core(),
        async () => projectFixture({ execImage: 'project-exec:1' }),
        1,
      );
      expect(createdPodBody(fake.calls).spec.containers[0]?.image).toBe('override-image:2');
    } finally {
      fake.restore();
    }

    // No exec.image and no override → DEFAULT_EXEC_IMAGE.
    fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      expect(createdPodBody(fake.calls).spec.containers[0]?.image).toBe(DEFAULT_EXEC_IMAGE);
    } finally {
      fake.restore();
    }
  });

  it('falls back to defaults when the project lookup fails', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => {
          throw notFound('no such project');
        },
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.spec.containers[0]?.image).toBe(DEFAULT_EXEC_IMAGE);
      expect(pod.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(`${PROJECT}-data`);
    } finally {
      fake.restore();
    }
  });

  it('falls back to defaults when getProject (the real lookup) 404s', async () => {
    const fake = installFakeKube({
      ...podLifecycleScript('Succeeded', 0),
      getNamespacedCustomObject: { error: notFound() },
    });
    try {
      // No injected getProjectFn — the default getProject goes through the fake.
      await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        undefined,
        1,
      );
      const pod = createdPodBody(fake.calls);
      expect(pod.spec.containers[0]?.image).toBe(DEFAULT_EXEC_IMAGE);
      expect(pod.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(`${PROJECT}-data`);
    } finally {
      fake.restore();
    }
  });
});

describe('execInWorkspace — poll loop', () => {
  it('returns the exit code and logs when the pod Succeeds', async () => {
    const fake = installFakeKube(podLifecycleScript('Succeeded', 0));
    try {
      const result = await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello from the pod');
      expect(result.podName).toBe(createdPodBody(fake.calls).metadata.name);
      // create → poll(read) → logs → delete
      expect(fake.calls.map((c) => c.method)).toEqual([
        'createNamespacedPod',
        'readNamespacedPod',
        'readNamespacedPodLog',
        'deleteNamespacedPod',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('returns the exit code when the pod Fails', async () => {
    const fake = installFakeKube(podLifecycleScript('Failed', 3));
    try {
      const result = await execInWorkspace(
        PROJECT,
        'exit 3',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe('hello from the pod');
    } finally {
      fake.restore();
    }
  });

  it('breaks out of the poll and reports logs unavailable when reading the pod throws', async () => {
    const fake = installFakeKube({
      createNamespacedPod: { value: {} },
      readNamespacedPod: { error: serverError('pod vanished') },
      readNamespacedPodLog: { error: serverError('no logs') },
      deleteNamespacedPod: { value: undefined },
    });
    try {
      const result = await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe('(logs unavailable — pod phase: Unknown)');
    } finally {
      fake.restore();
    }
  });

  it('honors the deadline timeout without ever reading the pod', async () => {
    const fake = installFakeKube({
      createNamespacedPod: { value: {} },
      readNamespacedPodLog: { value: 'partial output' },
      deleteNamespacedPod: { value: undefined },
    });
    try {
      // timeoutMs = 0 → the deadline is already past when the poll starts.
      const result = await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        0,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      expect(result.exitCode).toBeNull();
      // Logs and delete still run after the deadline.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'createNamespacedPod',
        'readNamespacedPodLog',
        'deleteNamespacedPod',
      ]);
    } finally {
      fake.restore();
    }
  });

  it('failure path: delete is best-effort — non-404 errors are swallowed', async () => {
    const fake = installFakeKube({
      ...podLifecycleScript('Succeeded', 0),
      deleteNamespacedPod: { error: serverError('delete failed') },
    });
    try {
      const result = await execInWorkspace(
        PROJECT,
        'echo hi',
        '/data',
        120_000,
        NS,
        undefined,
        core(),
        async () => projectFixture(),
        1,
      );
      // The function still resolves with the exec outcome; the delete failure
      // is logged-and-ignored (best effort), including a 404 on an already
      // cleaned-up pod.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello from the pod');
      expect(fake.calls.some((c) => c.method === 'deleteNamespacedPod')).toBe(true);
    } finally {
      fake.restore();
    }
  });
});
