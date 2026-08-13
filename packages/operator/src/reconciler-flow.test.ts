// reconciler-flow.test.ts — table-driven scenario coverage for the operator's
// reconcile() resource-creation flow and the safeReconcileProject crash-safe
// wrapper, driven entirely through the BUILD-1 recording fake kube client.
//
// Every branch of reconcile() is exercised: the non-terminal happy path
// (Service / opencode-config / agents ConfigMap / PVC / Pod creation, with the
// Initializing + pod-phase-mirror status patches), the Succeeded-vs-Failed
// pod-phase terminal-claim symmetry (Succeeded claim guarded by a fresh run
// read, pinned by name below), the missing-ClusterAgent warning,
// the credentials ValidationError abort, PVC failure (Failed patch + rethrow),
// "already exists" tolerance on the create paths, and the terminal-run
// cleanup/dequeue branches. safeReconcileProject is covered for the Ready
// patch + observedGeneration, the unchanged-status skip
// (hasReconcileStatusChanged), the transient-error 30s retry timer (single,
// cancelled by the next event), and the permanent-4xx no-retry path.
//
// Queue semantics live in queue.test.ts; the terminal-cleanup behavior already
// asserted in reconciler.test.ts is folded into the table here rather than
// duplicated as separate tests.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { V1Pod } from '@kubernetes/client-node';
import { type ClusterAgent, type Project, type Run, RunPhase } from '@percussionist/api';
import * as reconciler from './reconciler.js';
import * as runKeyClient from './run-key-client.js';
import {
  type FakeKubeInstaller,
  type FakeKubeScript,
  installFakeKube,
  kubeError,
  notFound,
  serverError,
} from './test-helpers/fake-kube.js';

// ---------------------------------------------------------------------------
// Fixtures

function makeRun(name: string, overrides: Partial<Run> = {}): Run {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Run',
    metadata: {
      name,
      namespace: 'test-ns',
      uid: `uid-${name}`,
      labels: { 'percussionist.dev/project': 'test-project' },
    },
    spec: {
      project: 'test-project',
      task: 'test-task',
      interactive: false,
      image: 'ghcr.io/erkkaha/percussionist/runner:latest',
      timeoutSeconds: 3600,
      agents: [{ name: 'builder' }],
    },
    status: {},
    ...overrides,
  } as Run;
}

function clusterAgent(name: string, content: string): ClusterAgent {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterAgent',
    metadata: { name },
    spec: { content },
  } as ClusterAgent;
}

function projectWithUid(name: string, uid: string): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: { name, uid },
    spec: { source: { local: true } },
  } as Project;
}

function pod(phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'): V1Pod {
  return { status: { phase } } as V1Pod;
}

/** A pod that terminated with a non-zero exit code (drives summarizePodFailure). */
function failedPod(): V1Pod {
  return {
    status: {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'opencode',
          state: { terminated: { reason: 'Error', exitCode: 1, message: 'boom' } },
        },
      ],
    },
  } as V1Pod;
}

/** 409-style error whose message carries the apiserver's "already exists" text. */
function alreadyExists(kind: string, name: string): Error {
  return kubeError(409, `${kind} "${name}" already exists`);
}

/**
 * The shared non-terminal happy-path script: ClusterSettings miss, one resolved
 * ClusterAgent, everything created fresh (Service, opencode-config, agents CM,
 * PVC, Pod with phase Pending). Individual scenarios override the slices they
 * want to perturb.
 */
function happyPathScript(overrides: Partial<FakeKubeScript> = {}): FakeKubeScript {
  return {
    getClusterCustomObject: [
      { error: notFound() }, // ClusterSettings → cs undefined
      { value: clusterAgent('builder', 'builder-content') },
    ],
    readNamespacedService: { error: notFound() },
    createNamespacedService: { value: {} },
    readNamespacedConfigMap: [
      { error: notFound() }, // opencode-config in operator ns → no source config
      { error: notFound() }, // opencode-config in run ns → must be created
      { error: notFound() }, // agents CM → must be created
    ],
    createNamespacedConfigMap: [
      { value: {} }, // opencode-config
      { value: {} }, // agents CM
    ],
    getNamespacedCustomObject: { value: projectWithUid('test-project', 'proj-uid') },
    readNamespacedPersistentVolumeClaim: { error: notFound() },
    createNamespacedPersistentVolumeClaim: { value: {} },
    readNamespacedPod: { error: notFound() },
    createNamespacedPod: { value: pod('Pending') },
    patchNamespacedCustomObjectStatus: { value: {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers

/** Every Run status patch body, in order — `patchStatus` sends `{ status: patch }`. */
function runStatusPatches(fake: FakeKubeInstaller): Array<Record<string, unknown>> {
  return fake.calls
    .filter((c) => c.method === 'patchNamespacedCustomObjectStatus')
    .map((c) => (c.args[0] as { body: { status: Record<string, unknown> } }).body.status);
}

/** Every Project status.reconcile patch body, in order. */
function projectReconcilePatches(fake: FakeKubeInstaller): Array<Record<string, unknown>> {
  return fake.calls
    .filter((c) => c.method === 'patchNamespacedCustomObjectStatus')
    .map(
      (c) =>
        (c.args[0] as { body: { status: { reconcile: Record<string, unknown> } } }).body.status
          .reconcile,
    );
}

const createConfigMapBody = (fake: FakeKubeInstaller, index = 0) =>
  (
    fake.calls.filter((c) => c.method === 'createNamespacedConfigMap')[index]?.args[0] as {
      body: { metadata: { name: string }; data: Record<string, string> };
    }
  ).body;

// ---------------------------------------------------------------------------
// reconcile() — table-driven scenarios

interface ReconcileCase {
  name: string;
  run: Run;
  script: FakeKubeScript;
  expectedMethods: string[];
  expectedPatches?: Array<Record<string, unknown>>;
  /** When set, reconcile() must reject with an error carrying this statusCode. */
  rejectsWith?: number;
  /** When set, reconcile() must have called dequeue() with this key. */
  dequeueKey?: string;
}

// The non-terminal create sequence shared by the happy path, the already-exists
// tolerances, and the PVC-failure rows (up to the point each deviates).
const CREATE_SEQUENCE = [
  'getClusterCustomObject', // ClusterSettings
  'getClusterCustomObject', // ClusterAgent 'builder'
  'readNamespacedService',
  'createNamespacedService',
  'readNamespacedConfigMap', // opencode-config (operator ns)
  'readNamespacedConfigMap', // opencode-config (run ns)
  'createNamespacedConfigMap', // opencode-config
  'readNamespacedConfigMap', // agents CM
  'createNamespacedConfigMap', // agents CM
  'getNamespacedCustomObject', // Project (for the PVC owner reference)
  'readNamespacedPersistentVolumeClaim',
  'createNamespacedPersistentVolumeClaim',
  'readNamespacedPod',
  'createNamespacedPod',
];

const reconcileCases: ReconcileCase[] = [
  {
    name: 'happy path: creates Service, opencode-config, agents CM, PVC and Pod, then patches Initializing (podName/serviceName) and mirrors the pod phase',
    run: makeRun('run-1'),
    script: happyPathScript(),
    expectedMethods: [
      ...CREATE_SEQUENCE,
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [
      {
        phase: RunPhase.Initializing,
        podName: 'run-1',
        serviceName: 'run-1',
        message: 'pod created',
      },
      {
        phase: RunPhase.Initializing,
        podPhase: 'Pending',
        podName: 'run-1',
        serviceName: 'run-1',
        message: 'pod phase: Pending',
      },
      { podPhase: 'Pending' },
    ],
  },
  {
    name: 'missing ClusterAgents → Initializing warning message, run still proceeds',
    run: makeRun('run-2', { spec: { ...makeRun('run-2').spec, agents: [{ name: 'ghost' }] } }),
    script: happyPathScript({
      getClusterCustomObject: [
        { error: notFound() }, // ClusterSettings
        { error: notFound() }, // ClusterAgent 'ghost' → missing
      ],
      // No agents resolved → the agents ConfigMap block is skipped entirely.
      readNamespacedConfigMap: [{ error: notFound() }, { error: notFound() }],
      createNamespacedConfigMap: [{ value: {} }],
    }),
    expectedMethods: [
      'getClusterCustomObject',
      'getClusterCustomObject',
      'patchNamespacedCustomObjectStatus', // warning (missing agents)
      'readNamespacedService',
      'createNamespacedService',
      'readNamespacedConfigMap',
      'readNamespacedConfigMap',
      'createNamespacedConfigMap',
      'getNamespacedCustomObject',
      'readNamespacedPersistentVolumeClaim',
      'createNamespacedPersistentVolumeClaim',
      'readNamespacedPod',
      'createNamespacedPod',
      'patchNamespacedCustomObjectStatus', // pod created
      'patchNamespacedCustomObjectStatus', // pod phase: Pending
      'patchNamespacedCustomObjectStatus', // podPhase change
    ],
    expectedPatches: [
      {
        phase: RunPhase.Initializing,
        message:
          'Warning: ClusterAgent(s) not found and will be skipped: ghost. Run will proceed with available agents.',
      },
      {
        phase: RunPhase.Initializing,
        podName: 'run-2',
        serviceName: 'run-2',
        message: 'pod created',
      },
      {
        phase: RunPhase.Initializing,
        podPhase: 'Pending',
        podName: 'run-2',
        serviceName: 'run-2',
        message: 'pod phase: Pending',
      },
      { podPhase: 'Pending' },
    ],
  },
  {
    name: 'Service/ConfigMap create races with "already exists" → tolerated, flow continues',
    run: makeRun('run-3'),
    script: happyPathScript({
      createNamespacedService: { error: alreadyExists('services', 'run-3') },
      createNamespacedConfigMap: [
        { error: alreadyExists('configmaps', 'opencode-config') },
        { error: alreadyExists('configmaps', 'run-3-agents') },
      ],
    }),
    expectedMethods: [
      ...CREATE_SEQUENCE,
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [
      {
        phase: RunPhase.Initializing,
        podName: 'run-3',
        serviceName: 'run-3',
        message: 'pod created',
      },
      {
        phase: RunPhase.Initializing,
        podPhase: 'Pending',
        podName: 'run-3',
        serviceName: 'run-3',
        message: 'pod phase: Pending',
      },
      { podPhase: 'Pending' },
    ],
  },
  {
    name: 'Service create fails (non-already-exists) → reconcile rejects, no status patch',
    run: makeRun('run-3b'),
    script: happyPathScript({
      createNamespacedService: { error: serverError('service backend down') },
    }),
    rejectsWith: 500,
    expectedMethods: [
      'getClusterCustomObject',
      'getClusterCustomObject',
      'readNamespacedService',
      'createNamespacedService',
    ],
  },
  {
    name: 'agents ConfigMap create fails (non-already-exists) → reconcile rejects, no status patch',
    run: makeRun('run-3c'),
    script: happyPathScript({
      createNamespacedConfigMap: [
        { value: {} }, // opencode-config
        { error: serverError('agents cm backend down') }, // agents CM
      ],
    }),
    rejectsWith: 500,
    expectedMethods: [
      'getClusterCustomObject',
      'getClusterCustomObject',
      'readNamespacedService',
      'createNamespacedService',
      'readNamespacedConfigMap',
      'readNamespacedConfigMap',
      'createNamespacedConfigMap',
      'readNamespacedConfigMap',
      'createNamespacedConfigMap',
    ],
  },
  {
    name: 'opencode-config create failure is tolerated (logged only) — run proceeds',
    run: makeRun('run-3d'),
    script: happyPathScript({
      createNamespacedConfigMap: [
        { error: serverError('cm backend down') }, // opencode-config → tolerated
        { value: {} }, // agents CM
      ],
    }),
    expectedMethods: [
      ...CREATE_SEQUENCE,
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [
      {
        phase: RunPhase.Initializing,
        podName: 'run-3d',
        serviceName: 'run-3d',
        message: 'pod created',
      },
      {
        phase: RunPhase.Initializing,
        podPhase: 'Pending',
        podName: 'run-3d',
        serviceName: 'run-3d',
        message: 'pod phase: Pending',
      },
      { podPhase: 'Pending' },
    ],
  },
  {
    name: 'Pod create fails (non-already-exists) → Failed patch + rethrow',
    run: makeRun('run-4b'),
    script: happyPathScript({
      createNamespacedPod: { error: serverError('pod backend down') },
    }),
    rejectsWith: 500,
    expectedMethods: [...CREATE_SEQUENCE, 'patchNamespacedCustomObjectStatus'],
    expectedPatches: [
      { phase: RunPhase.Failed, message: 'failed to create pod: pod backend down' },
    ],
  },
  {
    name: 'Pod create "already exists" → re-reads the existing pod instead of failing',
    run: makeRun('run-4'),
    script: happyPathScript({
      readNamespacedPod: [{ error: notFound() }, { value: pod('Running') }],
      createNamespacedPod: { error: alreadyExists('pods', 'run-4') },
    }),
    expectedMethods: [
      // CREATE_SEQUENCE.slice(0, 13) ends with the initial readNamespacedPod
      // probe (404), so the pod create + re-read are appended explicitly.
      ...CREATE_SEQUENCE.slice(0, 13),
      'createNamespacedPod', // raced by another reconcile → already exists
      'readNamespacedPod', // re-read the existing pod
      'patchNamespacedCustomObjectStatus',
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [
      {
        phase: RunPhase.Initializing,
        podPhase: 'Running',
        podName: 'run-4',
        serviceName: 'run-4',
        message: 'pod phase: Running',
      },
      { podPhase: 'Running' },
    ],
  },
  {
    name: 'mirrors a changed pod phase into run status (podPhase patch only, phase untouched)',
    run: makeRun('run-5', { status: { phase: RunPhase.Running, podPhase: 'Pending' } }),
    script: happyPathScript({
      // Everything already exists — no creates on this pass.
      readNamespacedService: { value: {} },
      readNamespacedConfigMap: [
        { value: {} }, // opencode-config (operator ns)
        { value: {} }, // opencode-config (run ns) → early return, no create
        { value: {} }, // agents CM → exists
      ],
      readNamespacedPersistentVolumeClaim: { value: {} },
      readNamespacedPod: { value: pod('Running') },
    }),
    expectedMethods: [
      'getClusterCustomObject',
      'getClusterCustomObject',
      'readNamespacedService',
      'readNamespacedConfigMap',
      'readNamespacedConfigMap',
      'readNamespacedConfigMap',
      'getNamespacedCustomObject',
      'readNamespacedPersistentVolumeClaim',
      'readNamespacedPod',
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [{ podPhase: 'Running' }],
  },
  {
    name: 'PVC ensure failure → Failed patch + rethrow, no pod created',
    run: makeRun('run-pvc'),
    script: happyPathScript({
      createNamespacedPersistentVolumeClaim: { error: serverError('pvc backend down') },
    }),
    rejectsWith: 500,
    expectedMethods: [
      ...CREATE_SEQUENCE.slice(0, CREATE_SEQUENCE.length - 2), // up to the PVC create
      'patchNamespacedCustomObjectStatus',
    ],
    expectedPatches: [
      { phase: RunPhase.Failed, message: 'failed to ensure data PVC: pvc backend down' },
    ],
  },
  {
    name: 'invalid Run spec (no task, not interactive) → Failed patch with the refine message, no pod work, no dequeue',
    run: makeRun('run-invalid', {
      spec: {
        project: 'test-project',
        interactive: false,
        image: 'ghcr.io/erkkaha/percussionist/runner:latest',
        timeoutSeconds: 3600,
        agents: [{ name: 'builder' }],
      },
    }),
    script: { patchNamespacedCustomObjectStatus: { value: {} } },
    expectedMethods: ['patchNamespacedCustomObjectStatus'],
    expectedPatches: [
      {
        phase: RunPhase.Failed,
        message: 'task: spec.task is required unless spec.interactive is true',
      },
    ],
  },
  {
    name: 'invalid Run spec (contradictory source) → Failed patch with the source message, no pod work, no dequeue',
    run: makeRun('run-invalid-src', {
      spec: {
        project: 'test-project',
        task: 'test-task',
        interactive: false,
        image: 'ghcr.io/erkkaha/percussionist/runner:latest',
        timeoutSeconds: 3600,
        agents: [{ name: 'builder' }],
        source: { git: { url: 'https://example.com/repo.git' }, local: true },
      },
    }),
    script: { patchNamespacedCustomObjectStatus: { value: {} } },
    expectedMethods: ['patchNamespacedCustomObjectStatus'],
    expectedPatches: [
      {
        phase: RunPhase.Failed,
        message: 'source: source.git and source.local are mutually exclusive',
      },
    ],
  },
  {
    name: 'terminal run + pod still exists → cleanupChildResources, no dequeue',
    run: makeRun('run-6', { status: { phase: RunPhase.Succeeded } }),
    script: {
      readNamespacedPod: { value: {} },
      // cleanupChildResources re-reads the Run CR fresh before deleting the
      // pod (never delete a non-terminal run's pod) — single response is fine,
      // the terminal guard path never reaches the project read, so this is the
      // only getNamespacedCustomObject call.
      getNamespacedCustomObject: {
        value: makeRun('run-6', { status: { phase: RunPhase.Succeeded } }),
      },
      deleteNamespacedPod: { value: {} },
      deleteNamespacedService: { value: {} },
    },
    expectedMethods: [
      'readNamespacedPod',
      'getNamespacedCustomObject',
      'deleteNamespacedPod',
      'deleteNamespacedService',
    ],
  },
  {
    name: 'terminal run + pod 404 → dequeue (dropped from the resync set)',
    run: makeRun('run-7', { status: { phase: RunPhase.Failed } }),
    script: { readNamespacedPod: { error: notFound() } },
    expectedMethods: ['readNamespacedPod'],
    dequeueKey: 'test-ns/run-7',
  },
];

describe('reconcile() flow', () => {
  let mintKeySpy: ReturnType<typeof spyOn>;
  let revokeKeySpy: ReturnType<typeof spyOn>;
  let dequeueSpy: ReturnType<typeof spyOn>;
  let fake: FakeKubeInstaller | undefined;

  beforeEach(() => {
    // Reconciler state is module-global; keep the queue clean between rows.
    const state = reconciler.__queueStateForTests();
    state.queue.length = 0;
    state.pending.clear();
    state.processing.clear();
    state.dirty.clear();
    state.seen.clear();
    // Per-run stats keys go over HTTP — stub both directions so no test touches
    // the network (mintRunKey would otherwise probe WEB_STATS_URL/api/health).
    mintKeySpy = spyOn(runKeyClient, 'mintRunKey').mockResolvedValue(null);
    revokeKeySpy = spyOn(runKeyClient, 'revokeRunKey').mockResolvedValue(undefined);
    dequeueSpy = spyOn(reconciler, 'dequeue');
  });

  afterEach(() => {
    mintKeySpy.mockRestore();
    revokeKeySpy.mockRestore();
    dequeueSpy.mockRestore();
    fake?.restore();
  });

  it.each<ReconcileCase>(reconcileCases)('$name', async ({
    run,
    script,
    expectedMethods,
    expectedPatches,
    rejectsWith,
    dequeueKey,
  }) => {
    fake = installFakeKube(script);
    try {
      const pending = reconciler.reconcile(run);
      if (rejectsWith !== undefined) {
        await expect(pending).rejects.toMatchObject({ statusCode: rejectsWith });
      } else {
        await pending;
      }
      expect(fake.calls.map((c) => c.method)).toEqual(expectedMethods);
      if (expectedPatches) {
        expect(runStatusPatches(fake)).toEqual(expectedPatches);
      }
      if (dequeueKey !== undefined) {
        expect(dequeueSpy).toHaveBeenCalledWith(dequeueKey);
      } else {
        expect(dequeueSpy).not.toHaveBeenCalled();
      }
    } finally {
      fake.restore();
    }
  });

  // ── Succeeded/Failed symmetry — terminal claim before cleanup ─────────────
  // A terminal pod phase (restartPolicy: Never) means the pod can never make
  // progress, so the operator claims the terminal run phase itself before
  // deleting the pod — for BOTH Succeeded and Failed pods. The Succeeded claim
  // is guarded by a fresh re-read of the Run CR: a Succeeded pod does NOT imply
  // a non-terminal run (the dispatcher can patch terminal Failed and still exit
  // 0 — "session ended without completion signal"), and the operator must not
  // clobber an existing terminal claim. Without the claim, deleting the pod
  // makes the next resync 404, mint a new run key, and re-run the task forever.
  //
  // Fake-kube scripting note: the Succeeded branch and cleanupChildResources
  // each add one fresh getNamespacedCustomObject read, so every scenario here
  // overrides happyPathScript's single-response project read with an ordered
  // array in exact call order: (1) project read, (2) branch fresh read,
  // (3) cleanup fresh read. The Failed branch patches via patchStatus (no read)
  // so its scenario scripts only (1) project read, (2) cleanup fresh read.
  it('Succeeded pod + non-terminal run phase → operator claims Succeeded (podPhase + completedAt) before deleting the pod, cleanup deletes it once', async () => {
    fake = installFakeKube(
      happyPathScript({
        readNamespacedPod: { value: pod('Succeeded') },
        deleteNamespacedPod: { value: {} },
        deleteNamespacedService: { value: {} },
        // (1) project read, (2) branch fresh read → Running (non-terminal →
        // claim fires), (3) cleanup fresh read → Succeeded (terminal → pod
        // delete allowed).
        getNamespacedCustomObject: [
          { value: projectWithUid('test-project', 'proj-uid') },
          { value: makeRun('asym-succ', { status: { phase: RunPhase.Running } }) },
          { value: makeRun('asym-succ', { status: { phase: RunPhase.Succeeded } }) },
        ],
      }),
    );
    try {
      const run = makeRun('asym-succ', { status: { phase: RunPhase.Running } });
      await reconciler.reconcile(run);

      const patches = runStatusPatches(fake);
      expect(patches).toContainEqual(
        expect.objectContaining({
          phase: RunPhase.Succeeded,
          podPhase: 'Succeeded',
          message: 'pod succeeded (operator claimed terminal phase; dispatcher exited without one)',
          completedAt: expect.any(String),
        }),
      );
      // The terminal claim lands before the pod delete (claim → cleanup).
      const claimIdx = fake.calls.findIndex(
        (c) =>
          c.method === 'patchNamespacedCustomObjectStatus' &&
          (c.args[0] as { body: { status: { phase?: string } } }).body.status.phase ===
            RunPhase.Succeeded,
      );
      const deleteIdx = fake.calls.findIndex((c) => c.method === 'deleteNamespacedPod');
      expect(claimIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThan(claimIdx);
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedPod')).toHaveLength(1);
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedService')).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  it('Succeeded pod + fresh read already terminal (dispatcher claimed Failed, exit 0) → no Succeeded claim, cleanup still deletes the pod', async () => {
    fake = installFakeKube(
      happyPathScript({
        readNamespacedPod: { value: pod('Succeeded') },
        deleteNamespacedPod: { value: {} },
        deleteNamespacedService: { value: {} },
        // (1) project read, (2) branch fresh read → Failed (terminal → no
        // claim), (3) cleanup fresh read → Failed (terminal → pod delete
        // allowed).
        getNamespacedCustomObject: [
          { value: projectWithUid('test-project', 'proj-uid') },
          { value: makeRun('asym-clobber', { status: { phase: RunPhase.Failed } }) },
          { value: makeRun('asym-clobber', { status: { phase: RunPhase.Failed } }) },
        ],
      }),
    );
    try {
      const run = makeRun('asym-clobber', { status: { phase: RunPhase.Running } });
      await reconciler.reconcile(run);

      const patches = runStatusPatches(fake);
      // The clobber guard: an existing terminal claim (the dispatcher's
      // Failed) is never overwritten by a Succeeded claim.
      expect(patches.some((p) => p.phase === RunPhase.Succeeded)).toBe(false);
      expect(patches.some((p) => p.phase === RunPhase.Failed)).toBe(false);
      // Cleanup still deletes the pod — the fresh read confirmed terminal.
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedPod')).toHaveLength(1);
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedService')).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  it('Failed pod → operator claims Failed + cleanup (cleanup fresh read scripted so the pod delete is allowed)', async () => {
    fake = installFakeKube(
      happyPathScript({
        readNamespacedPod: { value: failedPod() },
        deleteNamespacedPod: { value: {} },
        deleteNamespacedService: { value: {} },
        // (1) project read, (2) cleanup fresh read → Failed (terminal → pod
        // delete allowed). Without scripting the cleanup read, the single-
        // response project CR would make it see a non-terminal phase and skip
        // the pod delete.
        getNamespacedCustomObject: [
          { value: projectWithUid('test-project', 'proj-uid') },
          { value: makeRun('asym-fail', { status: { phase: RunPhase.Failed } }) },
        ],
      }),
    );
    try {
      const run = makeRun('asym-fail', { status: { phase: RunPhase.Running } });
      await reconciler.reconcile(run);

      const patches = runStatusPatches(fake);
      expect(patches).toContainEqual(
        expect.objectContaining({ phase: RunPhase.Failed, podPhase: 'Failed' }),
      );
      // The failed pod is deleted so it cannot be re-run — that is what makes
      // the claim necessary.
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedPod')).toHaveLength(1);
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedService')).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  it('ValidationError (ambiguous claude credentials) → Failed patch, no pod created', async () => {
    fake = installFakeKube({
      getClusterCustomObject: [{ error: notFound() }], // ClusterSettings only
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      const run = makeRun('run-cred', {
        spec: {
          project: 'test-project',
          task: 'test-task',
          interactive: false,
          image: 'ghcr.io/erkkaha/percussionist/runner:latest',
          timeoutSeconds: 3600,
          engine: 'claude',
          secrets: {
            llmKeysSecret: 'llm-secret',
            authSecret: { name: 'auth-secret' },
          },
        },
      });

      // ValidationError is absorbed — reconcile returns after patching Failed.
      await reconciler.reconcile(run);

      expect(fake.calls.map((c) => c.method)).toEqual([
        'getClusterCustomObject',
        'patchNamespacedCustomObjectStatus',
      ]);
      expect(runStatusPatches(fake)).toEqual([
        {
          phase: RunPhase.Failed,
          message:
            'Run test-ns/run-cred: engine "claude" has both spec.secrets.llmKeysSecret (llm-secret) and spec.secrets.authSecret (auth-secret) set. ANTHROPIC_API_KEY silently overrides subscription auth, so this run would bill per token while appearing to use the subscription. Remove one.',
        },
      ]);
    } finally {
      fake.restore();
    }
  });

  it('copies the operator-namespace opencode-config verbatim when the run namespace lacks one', async () => {
    fake = installFakeKube(
      happyPathScript({
        readNamespacedConfigMap: [
          { value: { data: { 'opencode.json': '{"model":"from-operator"}' } } },
          { error: notFound() },
          { error: notFound() },
        ],
      }),
    );
    try {
      await reconciler.reconcile(makeRun('run-sync'));

      const body = createConfigMapBody(fake);
      expect(body.metadata.name).toBe('opencode-config');
      // A user-supplied operator config is copied as-is — the dispatcher MCP
      // stanza is only injected into the fallback minimal config, so it is
      // never overwritten onto a real config.
      expect(body.data).toEqual({ 'opencode.json': '{"model":"from-operator"}' });
    } finally {
      fake.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// safeReconcileProject — Ready patch, unchanged-status skip, retry/backoff

describe('safeReconcileProject()', () => {
  let fake: FakeKubeInstaller | undefined;

  afterEach(() => {
    fake?.restore();
  });

  function makeProject(name: string, overrides: Partial<Project> = {}): Project {
    return {
      apiVersion: 'percussionist.dev/v1alpha1',
      kind: 'Project',
      metadata: { name, namespace: 'test-ns', uid: `uid-${name}`, generation: 3 },
      spec: { source: { local: true } },
      ...overrides,
    } as Project;
  }

  // codeServer + embedding both disabled → the reconcile is pure cleanup.
  const cleanupScript: FakeKubeScript = {
    deleteNamespacedService: { value: {} },
    deleteNamespacedDeployment: { value: {} },
    deleteNamespacedIngress: { value: {} },
  };

  it('records Ready + observedGeneration on success', async () => {
    fake = installFakeKube({
      ...cleanupScript,
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      await reconciler.safeReconcileProject(makeProject('proj-a'));

      // code-server cleanup (service, deployment, ingress) then memory-service
      // cleanup (service, deployment), then the Ready patch.
      expect(fake.calls.map((c) => c.method)).toEqual([
        'deleteNamespacedService',
        'deleteNamespacedDeployment',
        'deleteNamespacedIngress',
        'deleteNamespacedService',
        'deleteNamespacedDeployment',
        'patchNamespacedCustomObjectStatus',
      ]);
      expect(projectReconcilePatches(fake)).toEqual([
        { state: 'Ready', observedGeneration: 3, message: null },
      ]);
    } finally {
      fake.restore();
    }
  });

  it('skips the status patch when nothing changed (hasReconcileStatusChanged)', async () => {
    fake = installFakeKube(cleanupScript);
    try {
      const project = makeProject('proj-b', {
        status: { reconcile: { state: 'Ready', observedGeneration: 3 } },
      });

      await reconciler.safeReconcileProject(project);

      // Reconcile still ran (cleanup executed) but the Ready status is
      // identical → no patch, so the informer does not hot-loop.
      expect(
        fake.calls.filter((c) => c.method === 'patchNamespacedCustomObjectStatus'),
      ).toHaveLength(0);
      expect(fake.calls.filter((c) => c.method === 'deleteNamespacedService')).toHaveLength(2);
    } finally {
      fake.restore();
    }
  });

  it('transient error → Error status + a single 30s retry timer, cancelled and re-armed by the next event', async () => {
    const timers: Array<{ handle: unknown; callback: () => void; delay: number }> = [];
    const cleared: unknown[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (callback: (...args: unknown[]) => void, delay?: number) => {
        const handle = { timerId: timers.length };
        timers.push({ handle, callback: callback as () => void, delay: delay ?? 0 });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
    );
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
      (handle: unknown) => {
        cleared.push(handle);
      },
    );
    fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { value: {} },
      readNamespacedDeployment: { error: serverError() },
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      const project = makeProject('proj-c', {
        spec: { source: { local: true }, codeServer: { enabled: true } },
      });

      await reconciler.safeReconcileProject(project);

      // 5xx is transient: Error status + exactly one 30s retry timer.
      expect(projectReconcilePatches(fake)).toEqual([
        { state: 'Error', message: 'fake kube: internal server error', observedGeneration: 3 },
      ]);
      expect(timers).toHaveLength(1);
      expect(timers[0]?.delay).toBe(30_000);
      expect(cleared).toHaveLength(0);

      // The next informer event cancels the pending timer before re-arming, so
      // at most one timer is ever pending per project.
      await reconciler.safeReconcileProject(project);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toBe(timers[0]?.handle);
      expect(timers).toHaveLength(2);

      // Firing the retry re-runs reconcile with allowRetry=false: it fails
      // again but must NOT arm a further retry (no unbounded chain).
      const deploymentReadsBefore = fake.calls.filter(
        (c) => c.method === 'readNamespacedDeployment',
      ).length;
      timers[1]?.callback();
      for (let i = 0; i < 25; i++) await Promise.resolve(); // let the voided promise settle
      expect(fake.calls.filter((c) => c.method === 'readNamespacedDeployment')).toHaveLength(
        deploymentReadsBefore + 1,
      );
      expect(timers).toHaveLength(2);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      fake.restore();
    }
  });

  it('permanent 4xx error → Error status, no retry timer', async () => {
    const timerDelays: unknown[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (_callback: (...args: unknown[]) => void, delay?: number) => {
        timerDelays.push(delay);
        return { timerId: timerDelays.length } as unknown as ReturnType<typeof setTimeout>;
      },
    );
    fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { value: {} },
      readNamespacedDeployment: { error: kubeError(422, 'invalid resources.limits.memory') },
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      const project = makeProject('proj-d', {
        spec: { source: { local: true }, codeServer: { enabled: true } },
      });

      await reconciler.safeReconcileProject(project);

      expect(projectReconcilePatches(fake)).toEqual([
        { state: 'Error', message: 'invalid resources.limits.memory', observedGeneration: 3 },
      ]);
      // 4xx is a permanent spec problem — retrying cannot help, so no timer.
      expect(timerDelays).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
      fake.restore();
    }
  });

  it('invalid spec (contradictory source) → Error status with the refine message, no retry timer, reconcileProject never runs', async () => {
    const timerDelays: unknown[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (_callback: (...args: unknown[]) => void, delay?: number) => {
        timerDelays.push(delay);
        return { timerId: timerDelays.length } as unknown as ReturnType<typeof setTimeout>;
      },
    );
    fake = installFakeKube({ patchNamespacedCustomObjectStatus: { value: {} } });
    try {
      const project = makeProject('proj-invalid', {
        spec: { source: { git: { url: 'https://example.com/repo.git' }, local: true } },
      });

      await reconciler.safeReconcileProject(project);

      // Validation short-circuits before any reconcileProject work: only the
      // Error status patch fires. Spec problems are permanent — no retry timer,
      // and the terminal-ish Error state (guarded by hasReconcileStatusChanged)
      // prevents any hot-loop.
      expect(fake.calls.map((c) => c.method)).toEqual(['patchNamespacedCustomObjectStatus']);
      expect(projectReconcilePatches(fake)).toEqual([
        {
          state: 'Error',
          message: 'source: source.git and source.local are mutually exclusive',
          observedGeneration: 3,
        },
      ]);
      expect(timerDelays).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
      fake.restore();
    }
  });

  // ── Upsert helper paths (rev23 BUILD 6) ─────────────────────────────────
  // reconcileProject's Deployment/Service upserts go through the shared
  // upsertDeployment/upsertService helpers; these pin the read → create and
  // read → SSA-patch sequences and the per-resource ordering.

  it('upsert path: codeServer + embedding enabled with missing resources → creates deployments/services in order', async () => {
    fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { error: notFound() },
      createNamespacedPersistentVolumeClaim: { value: {} },
      readNamespacedDeployment: { error: notFound() },
      createNamespacedDeployment: { value: {} },
      readNamespacedService: { error: notFound() },
      createNamespacedService: { value: {} },
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      const project = makeProject('proj-upsert-create', {
        spec: {
          source: { local: true },
          codeServer: { enabled: true },
          embedding: { enabled: true },
        },
      });

      await reconciler.safeReconcileProject(project);

      // code-server Deployment + Service, then memory Deployment + Service,
      // each preceded by its own PVC probe/creation (the PVC preamble runs
      // once per enabled component).
      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedPersistentVolumeClaim', // code-server PVC probe (404)
        'createNamespacedPersistentVolumeClaim', // code-server PVC
        'readNamespacedDeployment', // code-server deployment (404)
        'createNamespacedDeployment', // code-server deployment
        'readNamespacedService', // code-server service (404)
        'createNamespacedService', // code-server service
        'readNamespacedPersistentVolumeClaim', // memory PVC probe (404)
        'createNamespacedPersistentVolumeClaim', // memory PVC
        'readNamespacedDeployment', // memory deployment (404)
        'createNamespacedDeployment', // memory deployment
        'readNamespacedService', // memory service (404)
        'createNamespacedService', // memory service
        'patchNamespacedCustomObjectStatus', // Ready
      ]);
      // No patches on the create path — nothing existed to patch.
      expect(
        fake.calls.filter(
          (c) =>
            c.method.startsWith('patchNamespaced') &&
            c.method !== 'patchNamespacedCustomObjectStatus',
        ),
      ).toHaveLength(0);
    } finally {
      fake.restore();
    }
  });

  it('upsert path: codeServer + embedding enabled with existing resources → SSA-patches, never creates', async () => {
    fake = installFakeKube({
      readNamespacedPersistentVolumeClaim: { value: {} },
      readNamespacedDeployment: { value: {} },
      patchNamespacedDeployment: { value: {} },
      readNamespacedService: { value: {} },
      patchNamespacedService: { value: {} },
      patchNamespacedCustomObjectStatus: { value: {} },
    });
    try {
      const project = makeProject('proj-upsert-patch', {
        spec: {
          source: { local: true },
          codeServer: { enabled: true },
          embedding: { enabled: true },
        },
      });

      await reconciler.safeReconcileProject(project);

      expect(fake.calls.map((c) => c.method)).toEqual([
        'readNamespacedPersistentVolumeClaim', // code-server PVC exists
        'readNamespacedDeployment', // code-server deployment exists
        'patchNamespacedDeployment', // code-server deployment SSA
        'readNamespacedService', // code-server service exists
        'patchNamespacedService', // code-server service SSA
        'readNamespacedPersistentVolumeClaim', // memory PVC exists
        'readNamespacedDeployment', // memory deployment exists
        'patchNamespacedDeployment', // memory deployment SSA
        'readNamespacedService', // memory service exists
        'patchNamespacedService', // memory service SSA
        'patchNamespacedCustomObjectStatus', // Ready
      ]);
      // Nothing missing → the create paths never fire.
      expect(fake.calls.filter((c) => c.method.startsWith('createNamespaced'))).toHaveLength(0);
      // Every Deployment/Service patch carries the SSA middleware option
      // (Content-Type: application/apply-patch+yaml) — the fake records the
      // setHeaderOptions options object as the second call argument.
      for (const method of ['patchNamespacedDeployment', 'patchNamespacedService']) {
        const patches = fake.calls.filter((c) => c.method === method);
        expect(patches.length).toBe(2);
        for (const c of patches) {
          const opts = c.args[1] as { middleware?: unknown[] } | undefined;
          expect(Array.isArray(opts?.middleware)).toBe(true);
          expect((opts?.middleware ?? []).length).toBeGreaterThan(0);
        }
      }
    } finally {
      fake.restore();
    }
  });
});
