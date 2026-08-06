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

  describe('human folder', () => {
    it('enabled: clones into /data/code, opens it, sets env, no git-ssh volume without sshSecret', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: { git: { url: 'git@github.com:acme/repo.git', ref: 'main' } },
            codeServer: { enabled: true, humanFolder: { enabled: true } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const cmd = init?.command?.[2] ?? '';
      expect(cmd).toContain('HUMAN_DIR="/data/code"');
      expect(cmd).toContain('mkdir -p "$HUMAN_DIR"');
      expect(cmd).toContain('git clone "${HUMAN_FOLDER_REMOTE_URL}" "$HUMAN_DIR" 2>&1');

      const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
      const args = container?.args ?? [];
      expect(args[args.length - 1]).toBe('/data/code');

      const initEnv = init?.env ?? [];
      expect(initEnv.find((e) => e.name === 'HUMAN_FOLDER_REMOTE_URL')?.value).toBe(
        'git@github.com:acme/repo.git',
      );
      expect(initEnv.find((e) => e.name === 'HUMAN_FOLDER_BRANCH')?.value).toBe('main');
      expect(initEnv.find((e) => e.name === 'HUMAN_FOLDER_AUTHOR_NAME')?.value).toBe(
        'Percussionist Agent',
      );
      expect(initEnv.find((e) => e.name === 'GIT_TERMINAL_PROMPT')?.value).toBe('0');

      const volumes = dep.spec?.template.spec?.volumes ?? [];
      expect(volumes.find((v) => v.name === 'git-ssh')).toBeUndefined();
    });

    it('enabled with name/branch/remoteUrl overrides reflects the overrides', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: { git: { url: 'git@github.com:acme/repo.git', ref: 'main' } },
            codeServer: {
              enabled: true,
              humanFolder: {
                enabled: true,
                name: 'human',
                branch: 'develop',
                remoteUrl: 'git@github.com:acme/other.git',
              },
            },
          },
        }),
      );
      const init = getInitContainer(dep);
      const cmd = init?.command?.[2] ?? '';
      expect(cmd).toContain('HUMAN_DIR="/data/human"');
      expect(cmd).toContain('mkdir -p "$HUMAN_DIR"');

      const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
      const args = container?.args ?? [];
      expect(args[args.length - 1]).toBe('/data/human');

      const initEnv = init?.env ?? [];
      expect(initEnv.find((e) => e.name === 'HUMAN_FOLDER_BRANCH')?.value).toBe('develop');
      expect(initEnv.find((e) => e.name === 'HUMAN_FOLDER_REMOTE_URL')?.value).toBe(
        'git@github.com:acme/other.git',
      );
    });

    it('enabled with sshSecret: init container mounts git-ssh and has GIT_SSH_COMMAND; main container does not', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: {
              git: {
                url: 'git@github.com:acme/repo.git',
                ref: 'main',
                sshSecret: { name: 'my-ssh-key' },
              },
            },
            codeServer: { enabled: true, humanFolder: { enabled: true } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const initMounts = init?.volumeMounts ?? [];
      expect(initMounts.find((m) => m.name === 'git-ssh')?.mountPath).toBe('/etc/git-ssh');

      const initEnv = init?.env ?? [];
      const sshCmd = initEnv.find((e) => e.name === 'GIT_SSH_COMMAND')?.value;
      expect(sshCmd).toContain('-i /etc/git-ssh/id');
      expect(sshCmd).toContain('IdentitiesOnly=yes');
      expect(sshCmd).toContain('StrictHostKeyChecking=no');

      const volumes = dep.spec?.template.spec?.volumes ?? [];
      const gitSshVolume = volumes.find((v) => v.name === 'git-ssh');
      expect(gitSshVolume?.secret?.secretName).toBe('my-ssh-key');
      expect(gitSshVolume?.secret?.items).toEqual([{ key: 'ssh-privatekey', path: 'id' }]);

      const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
      expect(container?.volumeMounts?.find((m) => m.name === 'git-ssh')).toBeUndefined();
      expect(container?.env?.find((e) => e.name === 'GIT_SSH_COMMAND')).toBeUndefined();
    });

    it('absent/disabled: byte-identical to current behaviour (opens /data, no human folder strings)', () => {
      // Disabled via explicit false
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: { git: { url: 'git@github.com:acme/repo.git', ref: 'main' } },
            codeServer: { enabled: true, humanFolder: { enabled: false } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const cmd = init?.command?.[2] ?? '';
      expect(cmd).not.toContain('HUMAN_DIR');
      expect(cmd).not.toContain('git clone');
      expect(cmd).not.toContain('HUMAN_FOLDER');
      expect((init?.env ?? []).find((e) => e.name === 'HUMAN_FOLDER_REMOTE_URL')).toBeUndefined();
      expect((init?.env ?? []).find((e) => e.name === 'GIT_TERMINAL_PROMPT')).toBeUndefined();

      const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
      const args = container?.args ?? [];
      expect(args[args.length - 1]).toBe('/data');

      const volumes = dep.spec?.template.spec?.volumes ?? [];
      expect(volumes.find((v) => v.name === 'git-ssh')).toBeUndefined();

      // Absent entirely must render identically to the pre-humanFolder baseline
      const baseline = renderIdeDeployment(makeProject());
      expect(JSON.stringify(dep)).toBe(JSON.stringify(baseline));
    });

    it('source.local without a resolvable URL falls back to git init bootstrap for the human dir', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: { local: true },
            codeServer: { enabled: true, humanFolder: { enabled: true } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const cmd = init?.command?.[2] ?? '';
      expect(cmd).toContain('git init "$HUMAN_DIR" 2>&1 || true');
      expect(cmd).toContain('symbolic-ref HEAD "refs/heads/${HUMAN_FOLDER_BRANCH:-main}"');
      expect(cmd).toContain('no remote URL; bootstrapping empty git repo');
      expect((init?.env ?? []).find((e) => e.name === 'HUMAN_FOLDER_REMOTE_URL')).toBeUndefined();
    });

    it('enabled: GIT_AUTHOR_*/GIT_COMMITTER_* env gives the bootstrap commit an identity before seeding', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: {
              git: {
                url: 'git@github.com:acme/repo.git',
                ref: 'main',
                author: { name: 'Ada Lovelace', email: 'ada@example.com' },
              },
            },
            codeServer: { enabled: true, humanFolder: { enabled: true } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const initEnv = init?.env ?? [];
      // The bootstrap `git commit --allow-empty` runs before any repo-local
      // user.name/user.email seeding, so its identity must come from the
      // container env (pod-builder workspace-init pattern) or it silently no-ops
      // (exit 128 "Author identity unknown", swallowed by `|| true`).
      expect(initEnv.find((e) => e.name === 'GIT_AUTHOR_NAME')?.value).toBe('Ada Lovelace');
      expect(initEnv.find((e) => e.name === 'GIT_AUTHOR_EMAIL')?.value).toBe('ada@example.com');
      expect(initEnv.find((e) => e.name === 'GIT_COMMITTER_NAME')?.value).toBe('Ada Lovelace');
      expect(initEnv.find((e) => e.name === 'GIT_COMMITTER_EMAIL')?.value).toBe('ada@example.com');

      // The identity env is init-container only — the human's own commits in
      // the IDE must use their repo-local config, not the platform's env.
      const container = dep.spec?.template.spec?.containers?.find((c) => c.name === 'code-server');
      expect(container?.env?.find((e) => e.name === 'GIT_AUTHOR_NAME')).toBeUndefined();
      expect(container?.env?.find((e) => e.name === 'GIT_COMMITTER_EMAIL')).toBeUndefined();
    });

    it('enabled: author seeding is unset-only (config --get guard) and never overwrites a human identity', () => {
      const dep = renderIdeDeployment(
        makeProject({
          spec: {
            source: { git: { url: 'git@github.com:acme/repo.git', ref: 'main' } },
            codeServer: { enabled: true, humanFolder: { enabled: true } },
          },
        }),
      );
      const init = getInitContainer(dep);
      const cmd = init?.command?.[2] ?? '';
      // Every `config user.name/email` write must be guarded by a `--get`
      // check so a human's own git identity survives pod restarts.
      const nameWrites = cmd.split('\n').filter((l) => l.includes('config user.name '));
      expect(nameWrites).toHaveLength(1);
      expect(cmd).toContain('git -C "$HUMAN_DIR" config --get user.name >/dev/null 2>&1 || \\');
      const emailWrites = cmd.split('\n').filter((l) => l.includes('config user.email '));
      expect(emailWrites).toHaveLength(1);
      expect(cmd).toContain('git -C "$HUMAN_DIR" config --get user.email >/dev/null 2>&1 || \\');
    });
  });
});
