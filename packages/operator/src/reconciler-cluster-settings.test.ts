// reconciler-cluster-settings.test.ts — ClusterSettings reconciliation into
// the managed ConfigMaps (C14): injectDispatcherMcpStanza, ssaConfigMap and
// reconcileClusterSettings.
//
// These functions decide every run pod's MCP stanza (opencode-config) and the
// manager sidecar's agent-config, so a regression here silently breaks agent
// tool access (complete_run / fail_run) or the manager's own MCP wiring. The
// suite drives reconcileClusterSettings through the recording fake kube and
// asserts the exact SSA request shapes (field manager, force flag, content
// type) as well as the merged JSON payloads.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ClusterSettings } from '@percussionist/api';
import { injectDispatcherMcpStanza, reconcileClusterSettings, ssaConfigMap } from './reconciler.js';
import { type FakeKubeInstaller, installFakeKube } from './test-helpers/fake-kube.js';

const NS = 'percussionist'; // NAMESPACE / SELF_NAMESPACE defaults in tests

function makeClusterSettings(overrides: Partial<ClusterSettings['spec']> = {}): ClusterSettings {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'ClusterSettings',
    metadata: { name: 'default' },
    spec: {
      ...overrides,
    },
  } as ClusterSettings;
}

/** Find the first recorded SSA call for a given ConfigMap name. */
function ssaCall(kube: FakeKubeInstaller, name: string) {
  return kube.calls.find(
    (c) =>
      c.method === 'patchNamespacedConfigMap' && (c.args[0] as { name?: string }).name === name,
  );
}

function ssaArg(kube: FakeKubeInstaller, name: string) {
  const call = ssaCall(kube, name);
  if (!call) throw new Error(`no SSA call recorded for ConfigMap "${name}"`);
  return call.args[0] as {
    name: string;
    namespace: string;
    fieldManager?: string;
    force?: boolean;
    body: { data?: Record<string, string> };
  };
}

describe('injectDispatcherMcpStanza', () => {
  it('injects the dispatcher stanza into an empty config', () => {
    const out = JSON.parse(injectDispatcherMcpStanza('{}')) as Record<string, any>;
    expect(out.mcp['percussionist-dispatcher']).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4097/mcp',
      enabled: true,
    });
  });

  it('keeps remote MCP entries and strips local/stdio entries', () => {
    const raw = JSON.stringify({
      mcp: {
        'safe-remote': { type: 'remote', url: 'http://example.com/mcp', enabled: true },
        'bad-local': { type: 'local', command: ['node', 'x.js'] },
        'bad-stdio': { type: 'stdio', command: 'npx y' },
      },
    });
    const out = JSON.parse(injectDispatcherMcpStanza(raw)) as Record<string, any>;
    // Local/stdio entries are unsafe in headless run pods and must be dropped.
    expect(out.mcp['bad-local']).toBeUndefined();
    expect(out.mcp['bad-stdio']).toBeUndefined();
    // Remote entries survive so user-supplied MCP servers keep working.
    expect(out.mcp['safe-remote']).toEqual({
      type: 'remote',
      url: 'http://example.com/mcp',
      enabled: true,
    });
    expect(out.mcp['percussionist-dispatcher']).toBeDefined();
  });

  it('defaults to an empty object on parse error instead of throwing', () => {
    const out = JSON.parse(injectDispatcherMcpStanza('not json{')) as Record<string, any>;
    expect(out.mcp['percussionist-dispatcher']).toBeDefined();
  });

  it('the injected stanza is merged last so user config cannot override it', () => {
    const raw = JSON.stringify({
      mcp: { 'percussionist-dispatcher': { type: 'local', command: 'bad' } },
    });
    const out = JSON.parse(injectDispatcherMcpStanza(raw)) as Record<string, any>;
    expect(out.mcp['percussionist-dispatcher']).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4097/mcp',
      enabled: true,
    });
  });
});

describe('reconcileClusterSettings', () => {
  let kube: FakeKubeInstaller;
  let originalLog: typeof console.log;
  let originalErr: typeof console.error;

  beforeEach(() => {
    kube = installFakeKube();
    // Quiet the operator's logging so test output stays readable.
    originalLog = console.log;
    originalErr = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    kube.restore();
    console.log = originalLog;
    console.error = originalErr;
  });

  it('SSAs opencode-config with the injected stanza when runnerConfig.config is set', async () => {
    const config = JSON.stringify({ provider: { id: 'anthropic' } });
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(makeClusterSettings({ runnerConfig: { config } }));

    const ssa = ssaArg(kube, 'opencode-config');
    expect(ssa.namespace).toBe(NS);
    expect(ssa.fieldManager).toBe('percussionist-operator');
    expect(ssa.force).toBe(true);
    const applied = JSON.parse(ssa.body.data?.['opencode.json'] ?? '{}') as Record<string, any>;
    // Original user config survives...
    expect(applied.provider).toEqual({ id: 'anthropic' });
    // ...and the dispatcher stanza is always present.
    expect(applied.mcp['percussionist-dispatcher']).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4097/mcp',
      enabled: true,
    });
  });

  it('writes SSA with the server-side-apply middleware option (Content-Type: application/apply-patch+yaml)', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(makeClusterSettings({ runnerConfig: { config: '{}' } }));

    const call = ssaCall(kube, 'opencode-config');
    expect(call).toBeDefined();
    // setHeaderOptions adds a header-injecting middleware to the options
    // object (same shape reconciler-flow.test.ts asserts for the
    // Deployment/Service SSA patches).
    const opts = call?.args[1] as { middleware?: unknown[] } | undefined;
    expect(Array.isArray(opts?.middleware)).toBe(true);
    expect((opts?.middleware ?? []).length).toBeGreaterThan(0);
  });

  it('mirrors the configMapRef source CM into opencode-config with the stanza', async () => {
    kube = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          data: { 'opencode.json': '{"mcp":{"other":{"type":"remote","url":"http://x"}}}' },
        },
      },
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(
      makeClusterSettings({
        runnerConfig: { configMapRef: { name: 'my-opencode', key: 'opencode.json' } },
      }),
    );

    const ssa = ssaArg(kube, 'opencode-config');
    const applied = JSON.parse(ssa.body.data?.['opencode.json'] ?? '{}') as Record<string, any>;
    expect(applied.mcp?.other).toBeDefined(); // mirrored content kept
    expect(applied.mcp?.['percussionist-dispatcher']).toBeDefined(); // stanza always added
  });

  it('does not touch opencode-config when the referenced CM lacks an opencode.json key', async () => {
    kube = installFakeKube({
      readNamespacedConfigMap: { value: { data: { 'other.json': 'x' } } },
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(
      makeClusterSettings({
        runnerConfig: { configMapRef: { name: 'empty', key: 'opencode.json' } },
      }),
    );

    const calls = kube.calls.filter(
      (c) =>
        c.method === 'patchNamespacedConfigMap' &&
        (c.args[0] as { name?: string }).name === 'opencode-config',
    );
    expect(calls).toHaveLength(0);
  });

  it('leaves an existing opencode-config alone when neither config nor configMapRef is set', async () => {
    kube = installFakeKube({
      readNamespacedConfigMap: { value: { data: { 'opencode.json': '{}' } } },
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(makeClusterSettings({}));

    const calls = kube.calls.filter(
      (c) =>
        c.method === 'patchNamespacedConfigMap' &&
        (c.args[0] as { name?: string }).name === 'opencode-config',
    );
    expect(calls).toHaveLength(0);
  });

  it('always SSAs agent-config with the manager-agent MCP stanza and decision agent', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(makeClusterSettings({}));

    const ssa = ssaArg(kube, 'agent-config');
    const agentJson = ssa.body.data?.['opencode.json'] ?? '';
    const parsed = JSON.parse(agentJson) as Record<string, any>;
    expect(parsed.mcp['manager-agent']).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:4097/mcp',
      enabled: true,
    });
    expect(parsed.skills).toEqual({ directories: ['/root/.config/opencode/agents/'] });
    // The decision agent markdown is always shipped alongside.
    expect(ssa.body.data?.['manager-decision.md']).toContain('Manager decision agent');
  });

  it('layers manager.model and a custom decisionAgentContent onto agent-config', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(
      makeClusterSettings({
        manager: { model: 'claude-sonnet-4', decisionAgentContent: '# custom decision' },
      }),
    );

    const ssa = ssaArg(kube, 'agent-config');
    const parsed = JSON.parse(ssa.body.data?.['opencode.json'] ?? '{}') as Record<string, any>;
    expect(parsed.model).toBe('claude-sonnet-4');
    expect(ssa.body.data?.['manager-decision.md']).toBe('# custom decision');
  });

  it('pulls provider/skills from the runnerConfig.config when set', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    const config = JSON.stringify({
      provider: { id: 'openai', model: 'gpt-x' },
      skills: { directories: ['/custom/skills'] },
    });
    await reconcileClusterSettings(makeClusterSettings({ runnerConfig: { config } }));

    const ssa = ssaArg(kube, 'agent-config');
    const parsed = JSON.parse(ssa.body.data?.['opencode.json'] ?? '{}') as Record<string, any>;
    expect(parsed.provider).toEqual({ id: 'openai', model: 'gpt-x' });
    expect(parsed.skills).toEqual({ directories: ['/custom/skills'] });
  });

  it('falls back to the existing opencode-config CM for provider/skills when config is unset', async () => {
    kube = installFakeKube({
      readNamespacedConfigMap: {
        value: {
          data: {
            'opencode.json': JSON.stringify({
              provider: { id: 'bedrock' },
              skills: { directories: ['/legacy/skills'] },
            }),
          },
        },
      },
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings(makeClusterSettings({}));

    const ssa = ssaArg(kube, 'agent-config');
    const parsed = JSON.parse(ssa.body.data?.['opencode.json'] ?? '{}') as Record<string, any>;
    expect(parsed.provider).toEqual({ id: 'bedrock' });
    expect(parsed.skills).toEqual({ directories: ['/legacy/skills'] });
  });

  it('is a no-op when the ClusterSettings CR has no spec', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { value: {} },
    });
    await reconcileClusterSettings({ metadata: { name: 'default' } } as ClusterSettings);
    expect(kube.calls).toHaveLength(0);
  });
});

describe('ssaConfigMap', () => {
  let kube: FakeKubeInstaller;
  let originalErr: typeof console.error;

  beforeEach(() => {
    kube = installFakeKube();
    originalErr = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    kube.restore();
    console.error = originalErr;
  });

  it('swallows a failed patch (logs only) rather than throwing', async () => {
    kube = installFakeKube({
      patchNamespacedConfigMap: { error: Object.assign(new Error('boom'), { statusCode: 500 }) },
    });
    await expect(
      ssaConfigMap(NS, 'agent-config', { 'opencode.json': '{}' }),
    ).resolves.toBeUndefined();
  });
});
