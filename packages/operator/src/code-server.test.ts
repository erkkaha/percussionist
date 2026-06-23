import { describe, expect, it } from 'bun:test';
import type { Project } from '@percussionist/api';
import { renderIdeDeployment } from './code-server.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    apiVersion: 'percussionist.dev/v1alpha1',
    kind: 'Project',
    metadata: {
      name: 'test-project',
      namespace: 'test-ns',
      uid: 'test-uid-123',
    },
    spec: {
      source: { local: true },
      codeServer: { enabled: true },
    },
    status: {},
    ...overrides,
  } as Project;
}

function getInitContainer(dep: ReturnType<typeof renderIdeDeployment>) {
  return dep.spec?.template.spec?.initContainers?.find((c) => c.name === 'code-server-init');
}

describe('renderIdeDeployment', () => {
  it('should include an init container named code-server-init', () => {
    const dep = renderIdeDeployment(makeProject());
    const init = dep.spec?.template.spec?.initContainers ?? [];
    expect(init.some((c) => c.name === 'code-server-init')).toBe(true);
  });

  it('should use --config pointing to the PVC config path in main container args', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    const args = container?.args ?? [];
    expect(args[0]).toBe('--config');
    expect(args[1] as string).toMatch(/\/\.code-server-config\/config\.yaml$/);
  });

  it('should set GIT_CONFIG_GLOBAL env to .code-server-vscode/.gitconfig', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    const env = container?.env ?? [];
    const gitEnv = env.find((e) => e.name === 'GIT_CONFIG_GLOBAL');
    expect(gitEnv?.value).toMatch(/\/\.code-server-vscode\/\.gitconfig$/);
  });

  it('should run main container as root (runAsUser: 0)', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    expect(container?.securityContext?.runAsUser).toBe(0);
  });

  it('should run init container as root (runAsUser: 0)', () => {
    const dep = renderIdeDeployment(makeProject());
    const init = dep.spec?.template.spec?.initContainers?.find(
      (c) => c.name === 'code-server-init',
    );
    expect(init?.securityContext?.runAsUser).toBe(0);
  });

  it('should not have --bind-addr or --auth in main container args', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    const args = container?.args?.join(' ') ?? '';
    expect(args).not.toContain('--bind-addr');
    expect(args).not.toContain('--auth');
  });

  it('should include the workspace folder as the last main container arg', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    const args = container?.args ?? [];
    const last = args[args.length - 1] as string;
    expect(last).toBe('/data');
  });

  it('should include a readiness probe on the main container', () => {
    const dep = renderIdeDeployment(makeProject());
    const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
    expect(container?.readinessProbe?.httpGet?.path).toBe('/healthz');
  });

  it('should include code-server-init in initContainers', () => {
    const dep = renderIdeDeployment(makeProject());
    const init = dep.spec?.template.spec?.initContainers ?? [];
    const names = init.map((c) => c.name);
    expect(names).toContain('code-server-init');
  });

  it('should not set CODE_SERVER_PACKAGES env when no packages specified', () => {
    const dep = renderIdeDeployment(makeProject());
    const init = getInitContainer(dep);
    const env = init?.env ?? [];
    expect(env.find((e) => e.name === 'CODE_SERVER_PACKAGES')).toBeUndefined();
  });

  it('should set CODE_SERVER_PACKAGES env when packages are specified', () => {
    const dep = renderIdeDeployment(
      makeProject({
        spec: {
          source: { local: true },
          codeServer: { enabled: true, packages: ['ripgrep', 'jq'] },
        },
      }),
    );
    const init = getInitContainer(dep);
    const env = init?.env ?? [];
    const pkgEnv = env.find((e) => e.name === 'CODE_SERVER_PACKAGES');
    expect(pkgEnv?.value).toBe('ripgrep jq');
  });

  it('should include package install block in init script when packages given', () => {
    const dep = renderIdeDeployment(
      makeProject({
        spec: {
          source: { local: true },
          codeServer: { enabled: true, packages: ['ripgrep'] },
        },
      }),
    );
    const init = getInitContainer(dep);
    const cmd = init?.command?.[2] ?? '';
    expect(cmd).toContain('# Install extra packages');
    expect(cmd).toContain('CODE_SERVER_PACKAGES');
    expect(cmd).toContain('apt-get');
    expect(cmd).toContain('apk');
  });
});
