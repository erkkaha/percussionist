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

  it('sends codeServer.humanFolder.enabled when the human folder toggle is on', () => {
    const state = createInitialState(undefined);
    state.codeServerEnabled = true;
    state.humanFolderEnabled = true;

    const request = buildProjectRequest(state, false);

    expect(request.codeServer).toEqual({
      enabled: true,
      image: 'codercom/code-server:4.96.4',
      humanFolder: { enabled: true },
    });
  });

  it('omits humanFolder from the payload when the toggle is off', () => {
    const state = createInitialState(undefined);
    state.codeServerEnabled = true;

    const request = buildProjectRequest(state, false);

    expect(request.codeServer).toEqual({
      enabled: true,
      image: 'codercom/code-server:4.96.4',
    });
    expect(request.codeServer?.humanFolder).toBeUndefined();
  });

  it('initializes humanFolderEnabled from spec when editing', () => {
    const state = createInitialState({
      codeServer: { enabled: true, humanFolder: { enabled: true } },
    });

    expect(state.humanFolderEnabled).toBe(true);
  });

  it('omits humanFolder entirely when code-server is disabled', () => {
    const state = createInitialState({
      codeServer: { enabled: true, humanFolder: { enabled: true } },
    });
    state.codeServerEnabled = false;

    const request = buildProjectRequest(state, true);

    expect(request.codeServer).toEqual({ enabled: false });
    expect(request.codeServer?.humanFolder).toBeUndefined();
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

  it('round-trips spec.agents with models into roster rows', () => {
    const state = createInitialState({
      agents: [{ name: 'builder', model: 'a/b' }, { name: 'reviewer' }],
    });

    expect(state.rosterAgents).toEqual([
      { name: 'builder', model: 'a/b' },
      { name: 'reviewer', model: '' },
    ]);
  });

  it('serializes roster rows to { name, model } with trimmed models', () => {
    const state = createInitialState(undefined);
    state.rosterAgents = [
      { name: 'builder', model: '  a/b  ' },
      { name: 'reviewer', model: '' },
    ];

    const request = buildProjectRequest(state, true);

    expect(request.agents).toEqual([
      { name: 'builder', model: 'a/b' },
      { name: 'reviewer', model: '' },
    ]);
  });

  it('serializes an empty roster as an empty agents array', () => {
    const request = buildProjectRequest(createInitialState(undefined), false);

    expect(request.agents).toEqual([]);
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

  it('consumes nested null delete-markers even when the existing spec lacks the subtree', () => {
    // Edit mode always sends the full flow/resources override objects with
    // null for "keep the default". A project saved without those subtrees
    // must not end up with literal nulls in its spec (ProjectSpecSchema
    // rejects them with "expected string, received null" / invalid enum).
    expect(
      mergeProjectPatch(
        {
          flow: { preset: 'plan-build-review-merge', merge: { agent: 'integrator', mode: 'auto' } },
        },
        {
          flow: {
            preset: 'plan-build-review-merge',
            humanApproval: { plan: null, build: null },
            plan: { onApprove: null },
            build: { onSuccess: null, onApprove: null },
            merge: { mode: null },
          },
          resources: { requests: { cpu: null, memory: null }, limits: { cpu: null, memory: null } },
        },
      ),
    ).toEqual({
      flow: {
        preset: 'plan-build-review-merge',
        humanApproval: {},
        plan: {},
        build: {},
        merge: { agent: 'integrator' },
      },
      resources: { requests: {}, limits: {} },
    });
  });
});
