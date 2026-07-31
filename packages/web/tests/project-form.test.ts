import { describe, expect, it } from 'bun:test';
import {
  buildProjectRequest,
  createInitialState,
} from '../src/client/components/project-form/useProjectForm.js';
import { mergeProjectPatch } from '../src/server/routes/projects.js';

describe('project form request', () => {
  it('sends default flow values when editing so existing overrides can be reset', () => {
    const state = createInitialState({
      flow: { merge: { mode: 'disabled' } },
    });
    state.flowMergeMode = 'auto';

    const request = buildProjectRequest(state, true);

    expect(request.flow).toEqual({
      preset: 'plan-build-review-merge',
      humanApproval: { plan: null, build: null },
      plan: { onApprove: null },
      build: { onSuccess: null, onApprove: null },
      merge: { mode: null },
    });
  });

  it('still omits default flow values when creating a project', () => {
    const request = buildProjectRequest(createInitialState(undefined), false);

    expect(request.flow).toBeUndefined();
  });

  it('sends code-server disabled when editing', () => {
    const state = createInitialState({ codeServer: { enabled: true } });
    state.codeServerEnabled = false;

    const request = buildProjectRequest(state, true);

    expect(request.codeServer).toEqual({ enabled: false });
  });

  it('omits disabled code-server when creating a project', () => {
    const request = buildProjectRequest(createInitialState(undefined), false);

    expect(request.codeServer).toBeUndefined();
  });

  it('sends explicit resets and disables for edited fields', () => {
    const state = createInitialState({
      displayName: 'Old name',
      model: 'provider/model',
      agent: 'builder',
      maxParallel: 4,
      timeoutSeconds: 900,
      phase: 'Archived',
      initScript: 'setup',
      retryPolicy: { enabled: true },
      reviewPolicy: { aiReviewerEnabled: true },
      image: 'custom-runner',
      runner: { packages: ['jq'] },
      resources: { requests: { cpu: '500m', memory: '1Gi' } },
      data: { pvcName: 'custom', mountPath: '/custom', storageClass: 'fast' },
      embedding: { enabled: true },
      exec: { image: 'custom-exec' },
    });
    state.displayName = '';
    state.model = '';
    state.agent = '';
    state.maxParallel = '';
    state.timeoutSeconds = '';
    state.phase = 'Active';
    state.initScript = '';
    state.retryPolicyEnabled = false;
    state.reviewPolicyAiReviewerEnabled = false;
    state.runnerImage = '';
    state.runnerPackages = '';
    state.cpuRequest = '';
    state.memRequest = '';
    state.pvcName = '';
    state.mountPath = '/data';
    state.storageClass = '';
    state.embeddingEnabled = false;
    state.execImage = '';

    const request = buildProjectRequest(state, true);

    expect(request.displayName).toBeNull();
    expect(request.model).toBeNull();
    expect(request.agent).toBeNull();
    expect(request.maxParallel).toBeNull();
    expect(request.timeoutSeconds).toBeNull();
    expect(request.phase).toBe('Active');
    expect(request.initScript).toBeNull();
    expect(request.retryPolicy).toEqual({ enabled: false });
    expect(request.reviewPolicy).toEqual({ aiReviewerEnabled: false });
    expect(request.image).toBeNull();
    expect(request.runner).toBeNull();
    expect(request.resources).toEqual({
      requests: { cpu: null, memory: null },
      limits: { cpu: null, memory: null },
    });
    expect(request.data).toEqual({ pvcName: null, mountPath: null, storageClass: null });
    expect(request.embedding).toEqual({ enabled: false });
    expect(request.exec).toBeNull();
  });

  it('includes color on create when set', () => {
    const state = createInitialState(undefined);
    state.color = '#58c4dd';

    const request = buildProjectRequest(state, false);

    expect(request.color).toBe('#58c4dd');
  });

  it('omits color on create when left at Auto', () => {
    const request = buildProjectRequest(createInitialState(undefined), false);

    expect(request.color).toBeUndefined();
  });

  it('sends color: null on edit when cleared back to Auto', () => {
    const state = createInitialState({ color: '#58c4dd' });
    state.color = '';

    const request = buildProjectRequest(state, true);

    expect(request.color).toBeNull();
  });

  it('clears sidecar values while retaining the sidecar', () => {
    const state = createInitialState(undefined);
    state.sidecars = [{ id: 1, name: 'db', image: 'postgres', ports: '', env: '' }];

    const request = buildProjectRequest(state, true);

    expect(request.sidecars).toEqual([{ name: 'db', image: 'postgres', ports: [], env: [] }]);
  });

  it('does not override the simple preset with hidden flow controls', () => {
    const state = createInitialState(undefined);
    state.flowPreset = 'simple';

    const request = buildProjectRequest(state, true);

    expect(request.flow).toEqual({
      preset: 'simple',
      humanApproval: { plan: null, build: null },
      plan: { onApprove: null },
      build: { onSuccess: null, onApprove: null },
      merge: { mode: null },
    });
  });
});

describe('project update merge', () => {
  it('deletes null fields and preserves unmanaged nested fields', () => {
    expect(
      mergeProjectPatch(
        {
          model: 'old-model',
          source: {
            git: {
              url: 'git@example/repo.git',
              ref: 'main',
              parentRef: 'base',
              sshSecret: { name: 'ssh', key: 'custom-key' },
            },
          },
          resources: { requests: { cpu: '500m', memory: '1Gi', gpu: '1' } },
        },
        {
          model: null,
          source: { git: { ref: null, sshSecret: { name: 'new-ssh' } } },
          resources: { requests: { cpu: null, memory: '2Gi' } },
        },
      ),
    ).toEqual({
      source: {
        git: {
          url: 'git@example/repo.git',
          parentRef: 'base',
          sshSecret: { name: 'new-ssh', key: 'custom-key' },
        },
      },
      resources: { requests: { memory: '2Gi', gpu: '1' } },
    });
  });
});
