// pod-builder.ts — renders the Pod and Service for an Run.

import type { V1Pod, V1Service } from '@kubernetes/client-node';
import {
  type AgentDef,
  API_GROUP_VERSION,
  DEFAULT_RUNNER_ENGINE,
  DISPATCHER_CONTAINER,
  deriveEngine,
  type GitSource,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  OPENCODE_RUNNER_DEFAULTS,
  RUNNER_CONTAINER,
  type Run,
  type RunnerEngine,
  type RunnerImageSpec,
  type SidecarSpec,
  type SshHostKeyVerificationMode,
} from '@percussionist/api';
import { gitUrlHash } from '@percussionist/kube';
import {
  primaryAgentSystemPrompt,
  renderClaudeAgentFile,
  renderClaudeSettings,
} from './adapters/claude-config.js';
import {
  DISPATCHER_IMAGE,
  DISPATCHER_SERVICE_ACCOUNT,
  RUNNER_IMAGE_DEFAULT,
  WEB_AUTH_TOKEN,
  WEB_STATS_URL,
} from './config.js';

// ---------------------------------------------------------------------------
// Shared shell snippets for workspace-init init container

/**
 * Parent-baseline resolution snippet (shell).
 *
 * When creating a new worktree branch from `parentRef`, prefer the latest
 * fetched remote-tracking ref (`refs/remotes/origin/<parent>`) as the base,
 * falling back to the local ref (`<parent>`) when the remote-tracking ref
 * does not yet exist (e.g. first BUILD before parent is pushed).
 *
 * This avoids stale baselines caused by the mirror's refs/heads sync skipping
 * branches that have active worktree checkouts.
 */
function parentBaselineResolve(): string {
  return `  # Resolve parent branch baseline: prefer remote-tracking ref for freshness,
  # fall back to local ref if remote-tracking doesn't exist yet (first BUILD).
  _PARENT_REMOTE_REF="refs/remotes/origin/$GIT_PARENT_REF"
  _PARENT_BASE_REF="$GIT_PARENT_REF"
  if git -C "$MIRROR_DIR" rev-parse "$_PARENT_REMOTE_REF" >/dev/null 2>&1; then
    _PARENT_BASE_REF="$_PARENT_REMOTE_REF"
    echo "[workspace-init] using remote-tracking ref $_PARENT_REMOTE_REF as parent baseline for $GIT_REF"
  elif git -C "$MIRROR_DIR" rev-parse "refs/heads/$GIT_PARENT_REF" >/dev/null 2>&1; then
    echo "[workspace-init] falling back to local ref $GIT_PARENT_REF as parent baseline for $GIT_REF"
  else
    # Neither ref exists, so the worktree add below would fail on an unresolvable
    # baseline — as a bare "git worktree add" fatal, i.e. exit 128 with nothing
    # naming the missing branch. Diagnosing that took a mirror-by-mirror ref
    # comparison; say it outright instead.
    #
    # The way this happens in practice: the mirror path is derived from
    # source.git.url, so editing the URL (https -> ssh) points runs at a brand
    # new mirror cloned from the remote. Any branch that only ever existed in the
    # old mirror — because a push failed for want of credentials — is simply not
    # there.
    echo "[workspace-init] error: parent branch $GIT_PARENT_REF not found in mirror $MIRROR_DIR" >&2
    echo "[workspace-init] looked for refs/remotes/origin/$GIT_PARENT_REF and refs/heads/$GIT_PARENT_REF" >&2
    echo "[workspace-init] it is on neither the remote nor this mirror; if source.git.url changed, the branch may only exist in the mirror for the previous URL" >&2
    exit 1
  fi`;
}

/**
 * Re-sync the mirror's refs/heads/ from refs/remotes/origin/ so `git worktree
 * add` can resolve branches that are not currently checked out in a worktree.
 * Skipping HEAD avoids the symbolic-ref conflict that makes HEAD ambiguous.
 * Prunes stale worktree metadata first so a removed worktree never blocks the
 * ref sync. Shared verbatim by the worktreeReuse and freshWorktree modes.
 */
function renderRefSyncSnippet(): string[] {
  return [
    `  git -C "$MIRROR_DIR" worktree prune --expire=now 2>/dev/null || true`,
    '  # Re-sync refs/heads from remotes/origin',
    "  # Skip HEAD — it's a symbolic ref, not a real branch.",
    '  for _REMOTE_REF in $(git -C "$MIRROR_DIR" for-each-ref --format=\'%(refname)\' refs/remotes/origin/ 2>/dev/null || true); do',
    '    _BRANCH="${_REMOTE_REF#refs/remotes/origin/}"',
    '    [ "$_BRANCH" = "HEAD" ] && continue',
    '    if ! git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "branch refs/heads/$_BRANCH"; then',
    '      git -C "$MIRROR_DIR" update-ref "refs/heads/$_BRANCH" "$_REMOTE_REF" 2>/dev/null || true',
    '    fi',
    '  done',
  ];
}

/**
 * Reset the worktree to the tip of origin/<ref> so the run always starts from
 * the latest committed code, skipping when the remote-tracking branch does not
 * exist yet (e.g. a freshly created feature branch that has not been pushed).
 * Rendered exactly once per script, after the worktree is in place, so every
 * path (resume, force-add, normal-add, parent-baseline create) flows through
 * it — except the exit-1 error path, which must not reset.
 */
function renderResetToRemoteTip(): string[] {
  return [
    `if git -C "$WORKTREE_DIR" rev-parse "origin/$GIT_REF" >/dev/null 2>&1; then`,
    `  git -C "$WORKTREE_DIR" reset --hard "origin/$GIT_REF" && echo "[workspace-init] reset to origin/$GIT_REF"`,
    `else`,
    `  echo "[workspace-init] no remote tracking branch for $GIT_REF, skipping reset"`,
    `fi`,
  ];
}

/**
 * Add (or force-add) the run's worktree on the mirror: force-add when the
 * branch is already checked out elsewhere, normal-add otherwise, create from
 * the resolved parent baseline when the branch does not exist yet, and error
 * out (exit 1) when no parent baseline is available either. Shared verbatim by
 * the worktreeReuse and freshWorktree modes — the caller supplies the
 * mode-specific prologue.
 */
function renderAddWorktree(git: GitSource): string[] {
  return git.ref
    ? [
        ...renderRefSyncSnippet(),
        `  # Try normal add; if branch already checked out elsewhere (e.g. BUILD worktree during review),`,
        `  # force-add instead — detaches old worktree from the branch but preserves its files on disk.`,
        `  # Note: bare mirrors store branches as refs/heads/<name> — no origin/ prefix needed`,
        `  _BRANCH_LINE="branch refs/heads/$GIT_REF"`,
        `  if git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "$_BRANCH_LINE"; then`,
        `    echo "[workspace-init] branch $GIT_REF checked out elsewhere — force-adding worktree"`,
        `    git -C "$MIRROR_DIR" worktree add --force "$WORKTREE_DIR" "$GIT_REF"`,
        `    echo "[workspace-init] worktree force-added with branch $GIT_REF"`,
        `  elif git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR" "$GIT_REF" 2>/dev/null; then`,
        `    echo "[workspace-init] worktree added with branch $GIT_REF"`,
        ...(git.parentRef
          ? [
              `  else`,
              parentBaselineResolve(),
              `    # Create new branch from resolved parent baseline`,
              `    git -C "$MIRROR_DIR" worktree add -b "$GIT_REF" "$WORKTREE_DIR" "$_PARENT_BASE_REF"`,
              `    echo "[workspace-init] created new branch $GIT_REF from $_PARENT_BASE_REF"`,
            ]
          : [
              `  else`,
              `    echo "[workspace-init] error: failed to add worktree with branch $GIT_REF"`,
              `    exit 1`,
            ]),
        `  fi`,
      ]
    : [`  git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR"`];
}

// ---------------------------------------------------------------------------
// Naming helpers

export const serviceName = (run: Run) => run.metadata.name;
export const podName = (run: Run) => run.metadata.name;
export const agentsConfigMapName = (run: Run) => `${run.metadata.name}-agents`;

// ---------------------------------------------------------------------------
// Shared metadata helpers

const requireRunUid = (run: Run): string => {
  const uid = run.metadata.uid;
  if (!uid) throw new Error(`Run ${run.metadata.name} missing uid`);
  return uid;
};

const ownerRefsFor = (run: Run) => [
  {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    name: run.metadata.name,
    uid: requireRunUid(run),
    controller: true,
    blockOwnerDeletion: true,
  },
];

const commonLabels = (run: Run) => ({
  [LABELS.managedBy]: MANAGED_BY,
  [LABELS.runName]: run.metadata.name,
  ...(run.spec.project ? { [LABELS.projectName]: run.spec.project } : {}),
});

/**
 * Strip dangerous fields from a user-supplied sidecar securityContext unless the
 * cluster explicitly opts in. A privileged (or root, or escalation-allowed)
 * sidecar shares the run pod's network/PID namespace and is a trivial node-root
 * container-escape primitive — and run/project specs are editable from the web
 * dashboard. When `allowPrivileged` is false we drop `privileged`,
 * `allowPrivilegeEscalation`, and `runAsUser: 0`, keeping only benign fields.
 */
function sanitizeSidecarSecurityContext(
  sc: SidecarSpec['securityContext'],
  allowPrivileged: boolean,
  sidecarName: string,
): SidecarSpec['securityContext'] | undefined {
  if (!sc) return undefined;
  if (allowPrivileged) return sc;
  const { privileged, allowPrivilegeEscalation, runAsUser, ...safe } = sc;

  // Warn loudly: a stripped DinD sidecar fails at runtime in a way that gives
  // no hint the operator caused it (this is why self-dev's Docker sidecar needs
  // PERCUSSIONIST_ALLOW_PRIVILEGED_SIDECARS=true).
  const dropped = [
    privileged ? 'privileged' : undefined,
    allowPrivilegeEscalation ? 'allowPrivilegeEscalation' : undefined,
    runAsUser === 0 ? 'runAsUser: 0' : undefined,
  ].filter(Boolean);
  if (dropped.length > 0) {
    console.warn(
      `[operator ${new Date().toISOString()}] stripped ${dropped.join(', ')} from sidecar "${sidecarName}"; ` +
        'set PERCUSSIONIST_ALLOW_PRIVILEGED_SIDECARS=true on the operator to allow it',
    );
  }

  // Keep an explicit non-root runAsUser; drop a root (0) request.
  const cleaned = {
    ...safe,
    ...(runAsUser !== undefined && runAsUser !== 0 ? { runAsUser } : {}),
  };
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// Renderers

export function renderService(
  run: Run,
  runner: RunnerImageSpec = OPENCODE_RUNNER_DEFAULTS,
): V1Service {
  const containerPort = runner.port;
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName(run),
      namespace: run.metadata.namespace ?? '',
      labels: { ...commonLabels(run), [LABELS.component]: 'runner' },
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      type: 'ClusterIP',
      publishNotReadyAddresses: true,
      selector: { [LABELS.runName]: run.metadata.name },
      ports: [
        {
          name: 'http',
          port: containerPort,
          targetPort: 'http' as unknown as number,
        },
      ],
    },
  };
}

/** opencode's auth blob key, and the CRD-level default for `authSecret.key`. */
const OPENCODE_AUTH_SECRET_KEY = 'auth.json';

/**
 * Resolve which key of the auth Secret to mount.
 *
 * This is the `spec.image` trap again: the CRD defaults `authSecret.key` to
 * opencode's `auth.json`, so the field is never actually absent and the opencode
 * key would always win — including on a Secret that holds a raw subscription
 * token under `CLAUDE_CODE_OAUTH_TOKEN`. The pod then fails to start with
 * "couldn't find key auth.json in Secret", and any write that omits the field
 * (the dashboard's project editor, for one) silently reintroduces it.
 *
 * For a non-default engine, `auth.json` therefore cannot be meant literally: an
 * opencode auth blob carries nothing that engine can use. Fall back to the
 * engine's own auth env var, which is the key such a Secret is created under. A
 * genuinely custom key is still respected.
 */
export function resolveAuthSecretKey(
  key: string | undefined,
  engine: RunnerEngine,
  runner: RunnerImageSpec,
): string {
  if (engine === DEFAULT_RUNNER_ENGINE) return key ?? OPENCODE_AUTH_SECRET_KEY;
  return !key || key === OPENCODE_AUTH_SECRET_KEY ? runner.authEnvVar : key;
}

export function renderAgentsConfigMap(run: Run, agents: AgentDef[]): object {
  const data: Record<string, string> = {};
  // ClusterAgent content is written in opencode's agent-file format. The claude
  // engine mounts this same ConfigMap at ~/.claude/agents, where Claude Code
  // expects its own frontmatter and its own MCP tool names, so it has to be
  // translated rather than copied through.
  const forClaude = deriveEngine(run.spec) === 'claude';
  for (const a of agents) {
    data[`${a.name}.md`] = forClaude ? renderClaudeAgentFile(a) : a.content;
  }
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: agentsConfigMapName(run),
      namespace: run.metadata.namespace ?? '',
      labels: { ...commonLabels(run), [LABELS.component]: 'agents' },
      ownerReferences: ownerRefsFor(run),
    },
    data,
  };
}

export function renderPod(
  run: Run,
  resolvedAgents: AgentDef[],
  sidecars: SidecarSpec[] = [],
  runner: RunnerImageSpec = OPENCODE_RUNNER_DEFAULTS,
  dispatcherImage?: string,
  allowPrivilegedSidecars = false,
  /**
   * Per-run API key for reporting stats, minted by the reconciler.
   *
   * Falls back to the shared WEB_AUTH_TOKEN when absent (dev mode, or a cluster
   * still mid-migration) so this stays optional for existing call sites.
   */
  runApiKey?: string,
): V1Pod {
  const spec = run.spec;
  const containerPort = runner.port;

  // Validate project label is present (required for data PVC)
  const projectName = run.metadata.labels?.['percussionist.dev/project'];
  if (!projectName) {
    throw new Error(
      `Run ${run.metadata.namespace}/${run.metadata.name} missing required label: percussionist.dev/project`,
    );
  }

  const llmKeysSecret = spec.secrets?.llmKeysSecret;
  // Derived here rather than passed in so pod-builder and the reconciler cannot
  // disagree about which engine a run uses — a mismatch would pair one engine's
  // image with another's env and config.
  const engine = deriveEngine(spec);
  // `spec.image` carries a CRD-level default pointing at the opencode runner, so
  // it is never actually absent and would always shadow the engine's image. When
  // a non-default engine is requested the resolved runner image has to win, or
  // `engine: claude` silently runs the opencode runner. Per-run image overrides
  // for such an engine go through ClusterSettings.spec.runnerAdapter.image,
  // which resolveRunnerSpec has already layered into `runner.image`.
  const engineOverridesImage = engine !== DEFAULT_RUNNER_ENGINE;
  const image = engineOverridesImage
    ? (runner.image ?? spec.image ?? RUNNER_IMAGE_DEFAULT)
    : (spec.image ?? runner.image ?? RUNNER_IMAGE_DEFAULT);
  const git = spec.source?.git;
  const localGit = spec.source?.local === true;
  const sshSecret = git?.sshSecret
    ? { ...git.sshSecret, key: git.sshSecret.key ?? 'ssh-privatekey' }
    : undefined;
  const githubTokenSecret = git?.githubTokenSecret
    ? { ...git.githubTokenSecret, key: git.githubTokenSecret.key ?? 'token' }
    : undefined;
  const initScript = spec.initScript;
  const hasAgents = resolvedAgents.length > 0;
  const hasSidecars = sidecars.length > 0;

  // Data PVC configuration
  const dataPvcName = spec.data?.pvcName ?? `${projectName}-data`;
  const dataMountPath = spec.data?.mountPath ?? '/data';

  const initContainerResources = spec.resources ?? {
    requests: { cpu: '200m', memory: '512Mi' },
    limits: { cpu: '2', memory: '8Gi' },
  };

  // Derive Node.js heap size from the container memory limit (75% of limit).
  // Supports Mi and Gi suffixes; falls back to 2560 MB if unparseable.
  function heapMbFromLimit(limit: string | undefined): number {
    if (!limit) return 2560;
    const giMatch = limit.match(/^(\d+(?:\.\d+)?)Gi$/);
    if (giMatch) return Math.floor(parseFloat(giMatch[1] ?? '0') * 1024 * 0.75);
    const miMatch = limit.match(/^(\d+(?:\.\d+)?)Mi$/);
    if (miMatch) return Math.floor(parseFloat(miMatch[1] ?? '0') * 0.75);
    return 2560;
  }
  const nodeHeapMb = heapMbFromLimit(initContainerResources.limits?.memory);

  // Build the wait-for-sidecars prefix: for each sidecar port, loop until nc
  // succeeds. This runs inside the opencode container so all pods share the
  // same network namespace and localhost is available.
  const sidecarPorts = sidecars.flatMap((sc) => sc.ports ?? []);
  const waitScript =
    sidecarPorts.length > 0
      ? sidecarPorts.map((p) => `until nc -z 127.0.0.1 ${p}; do sleep 1; done`).join(' && ') +
        ' && '
      : '';

  const defaultAuthor = { name: 'Percussionist Agent', email: 'agent@percussionist.dev' };
  const author = git?.author ?? (localGit ? defaultAuthor : undefined);
  const gitAuthorEnv = author
    ? [
        { name: 'GIT_AUTHOR_NAME', value: author.name },
        { name: 'GIT_AUTHOR_EMAIL', value: author.email },
        { name: 'GIT_COMMITTER_NAME', value: author.name },
        { name: 'GIT_COMMITTER_EMAIL', value: author.email },
      ]
    : [];

  // ---------------------------------------------------------------------------
  // workspace-init init container
  //
  // Runs when the source is a remote git repo OR a local-only git workspace.
  //
  // Remote git (source.git):
  //   1. flock on the mirror dir to serialize concurrent fetches
  //   2. Clone --mirror if not present, otherwise git fetch --prune
  //   3. Add a worktree at /data/worktrees/{run-name}/ if not present,
  //      or resume the existing one (worktreeReuse=true, the default)
  //   4. Set the remote URL so the agent can push
  //   5. Run initScript if set
  //
  // Local git (source.local):
  //   1. git init /data/workspace/ if not already a git repo
  //   2. Run initScript if set
  //
  // The main container's workspace volume is a subPath mount backed by the
  // data PVC, pointing at the prepared directory.

  const runName = run.metadata.name;
  // Stable 8-char hash of the git URL used to name the bare mirror directory.
  // Computed at pod-render time so it is deterministic and embeddable in the
  // shell script without a runtime dependency on external tools.
  const urlHash = git?.url ? gitUrlHash(git.url) : '';

  const worktreeReuse = spec.gitCache?.worktreeReuse ?? true;

  // SSH host key verification configuration.
  // Default is "no" for backward compatibility with existing clusters.
  // When set to "strict" or "accept-new", the operator provisions a known_hosts
  // file from the run's known_hostsSecret (if provided) and configures SSH to
  // use it. This prevents man-in-the-middle attacks on git over SSH.
  const sshHostKeyVerification: SshHostKeyVerificationMode = git?.sshHostKeyVerification ?? 'no';
  const knownHostsSecret = git?.known_hostsSecret;
  const verifyHostKeys =
    sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new';

  // known_hosts gets its own mount directory and must NOT live under
  // /etc/git-ssh. That path is a read-only secret tmpfs, so a nested subPath
  // mount at /etc/git-ssh/known_hosts fails at container creation — runc cannot
  // create the target file inside a read-only volume, and the kubelet reports
  // `error mounting ... not a directory` (exit 128 in workspace-init).
  const knownHostsDir = '/etc/git-known-hosts';
  const knownHostsPath = `${knownHostsDir}/known_hosts`;
  const sshHostKeyOpts = verifyHostKeys
    ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=${knownHostsPath}`
    : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
  const knownHostsVolumeMount = verifyHostKeys
    ? [{ name: 'git-known-hosts', mountPath: knownHostsDir, readOnly: true }]
    : [];

  const initContainers =
    git || localGit
      ? [
          {
            name: 'workspace-init',
            image,
            imagePullPolicy: 'IfNotPresent' as const,
            command: ['/bin/sh', '-c'],
            args: [
              git
                ? // ── Remote git ──────────────────────────────────────────
                  [
                    'set -e',
                    ...(spec.runner?.packages?.length
                      ? [
                          '# Install runner packages declared in spec.runner.packages',
                          'if [ -n "${RUNNER_PACKAGES}" ]; then',
                          '  echo "[workspace-init] installing packages: $RUNNER_PACKAGES"',
                          '  apk update --quiet && apk add --no-cache $RUNNER_PACKAGES',
                          '  echo "[workspace-init] package installation complete"',
                          'fi',
                        ]
                      : []),
                    `MIRROR_DIR="${dataMountPath}/git-mirrors/${urlHash}"`,
                    `WORKTREE_DIR="${dataMountPath}/worktrees/${runName}"`,
                    `LOCK_FILE="${dataMountPath}/git-mirrors/${urlHash}.lock"`,
                    '',
                    '# SSH key setup',
                    'if [ -f /etc/git-ssh/id ]; then',
                    `  export GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o IdentitiesOnly=yes${sshHostKeyOpts}"`,
                    '  echo "[workspace-init] using ssh key from secret"',
                    'else',
                    `  export GIT_SSH_COMMAND="ssh${sshHostKeyOpts}"`,
                    'fi',
                    '',
                    '# GitHub token',
                    'if [ -f /etc/git-github/token ]; then',
                    '  GITHUB_TOKEN=$(cat /etc/git-github/token)',
                    '  export GITHUB_TOKEN',
                    '  echo "[workspace-init] GitHub token loaded"',
                    'fi',
                    '',
                    '# Ensure mirror directories exist',
                    `mkdir -p "${dataMountPath}/git-mirrors" "${dataMountPath}/worktrees"`,
                    '',
                    '# Update or create bare mirror (serialised with flock on lock file)',
                    `mkdir -p "$(dirname "$LOCK_FILE")"`,
                    '(',
                    '  flock -x 200',
                    '  if [ -d "$MIRROR_DIR" ]; then',
                    '    echo "[workspace-init] updating mirror $MIRROR_DIR"',
                    '    # Fetch into remote-tracking refs — never blocked by worktree checkouts',
                    '    git -C "$MIRROR_DIR" fetch origin \'+refs/heads/*:refs/remotes/origin/*\' --prune 2>&1 || echo "[workspace-init] fetch failed, using stale mirror"',
                    '    # Sync refs/heads/ from remotes/origin/ for branches NOT checked out in worktrees',
                    "    # Skip HEAD — it's a symbolic ref, not a real branch; syncing it creates",
                    "    # refs/heads/HEAD which conflicts with the symbolic HEAD (causes 'HEAD is ambiguous').",
                    '    for _REMOTE_REF in $(git -C "$MIRROR_DIR" for-each-ref --format=\'%(refname)\' refs/remotes/origin/ 2>/dev/null || true); do',
                    '      _BRANCH="${_REMOTE_REF#refs/remotes/origin/}"',
                    '      [ "$_BRANCH" = "HEAD" ] && continue',
                    '      if ! git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "branch refs/heads/$_BRANCH"; then',
                    '        git -C "$MIRROR_DIR" update-ref "refs/heads/$_BRANCH" "$_REMOTE_REF" 2>/dev/null || true',
                    '      fi',
                    '    done',
                    '  else',
                    `    echo "[workspace-init] cloning mirror from $GIT_URL"`,
                    `    git clone --mirror "$GIT_URL" "$MIRROR_DIR"`,
                    '  fi',
                    "  # Remove any refs/heads/HEAD synced by previous versions (causes 'HEAD is ambiguous')",
                    '  git -C "$MIRROR_DIR" update-ref -d refs/heads/HEAD 2>/dev/null || true',
                    "  # Set mirror HEAD to placeholder to avoid 'refname HEAD is ambiguous'",
                    '  # conflicts with worktree HEAD refs',
                    '  git -C "$MIRROR_DIR" symbolic-ref HEAD refs/heads/.mirror-placeholder 2>/dev/null || true',
                    '  # Prune worktree metadata for directories that no longer exist',
                    '  git -C "$MIRROR_DIR" worktree prune --expire=now 2>/dev/null || true',
                    '  # Repack loose objects to reduce inode pressure on the data PVC.',
                    '  git -C "$MIRROR_DIR" gc --auto 2>/dev/null || true',
                    ') 200>"$LOCK_FILE"',
                    '',
                    '# Set up worktree',
                    ...(worktreeReuse
                      ? [
                          `if [ -d "$WORKTREE_DIR/.git" ] || [ -f "$WORKTREE_DIR/.git" ]; then`,
                          `  echo "[workspace-init] resuming existing worktree $WORKTREE_DIR"`,
                          `  git -C "$WORKTREE_DIR" fetch --all --prune || echo "[workspace-init] fetch in worktree failed, continuing"`,
                          ...(git.ref
                            ? [
                                `  # Try to checkout ref; if it doesn't exist, create from parentRef (feature branching)`,
                                `  if git -C "$WORKTREE_DIR" checkout "$GIT_REF" 2>/dev/null; then`,
                                `    echo "[workspace-init] checked out existing branch $GIT_REF"`,
                                `  elif git -C "$WORKTREE_DIR" checkout -b "$GIT_REF" "origin/$GIT_REF" 2>/dev/null; then`,
                                `    echo "[workspace-init] checked out remote branch $GIT_REF"`,
                                ...(git.parentRef
                                  ? [
                                      `  elif git -C "$WORKTREE_DIR" checkout -b "$GIT_REF" "$GIT_PARENT_REF" 2>/dev/null; then`,
                                      `    echo "[workspace-init] created new branch $GIT_REF from $GIT_PARENT_REF"`,
                                    ]
                                  : []),
                                `  else`,
                                `    echo "[workspace-init] warning: could not checkout or create branch $GIT_REF"`,
                                `  fi`,
                              ]
                            : [
                                `  # No specific ref — reset to origin/HEAD to pick up latest remote commits.`,
                                `  _DEFAULT_BRANCH=$(git -C "$WORKTREE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)`,
                                `  if [ -n "$_DEFAULT_BRANCH" ] && git -C "$WORKTREE_DIR" rev-parse "origin/$_DEFAULT_BRANCH" >/dev/null 2>&1; then`,
                                `    git -C "$WORKTREE_DIR" reset --hard "origin/$_DEFAULT_BRANCH" && echo "[workspace-init] reset to origin/$_DEFAULT_BRANCH"`,
                                `  fi`,
                              ]),
                          `else`,
                          `  echo "[workspace-init] creating worktree $WORKTREE_DIR"`,
                          ...renderAddWorktree(git),
                          `fi`,
                        ]
                      : [
                          `# freshWorktree mode: always recreate`,
                          `if [ -d "$WORKTREE_DIR" ]; then`,
                          `  git -C "$MIRROR_DIR" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"`,
                          `fi`,
                          ...renderAddWorktree(git),
                        ]),
                    // The reset-to-remote-tip stanza is rendered exactly once per
                    // script, after the worktree is in place, so it covers every
                    // path: resumed worktrees (checkout above), force-adds, normal
                    // adds and parent-baseline creates alike. The exit-1 error
                    // path inside renderAddWorktree never reaches it.
                    ...(git.ref ? renderResetToRemoteTip() : []),
                    '',
                    '# Ensure remote URL points to real remote (not file://) so agent can push',
                    `git -C "$WORKTREE_DIR" remote set-url origin "$GIT_URL" 2>/dev/null || true`,
                    '# Unset mirror=true inherited from bare mirror so agent can push individual branches',
                    `git -C "$WORKTREE_DIR" config --local remote.origin.mirror false 2>/dev/null || true`,
                    '# Use standard fetch refspec so git fetch origin goes to refs/remotes/origin/* instead of refs/heads/* (avoids worktree conflicts)',
                    `git -C "$WORKTREE_DIR" config --local remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true`,
                    `echo "[workspace-init] HEAD=$(git -C "$WORKTREE_DIR" rev-parse HEAD)"`,
                    '',
                    ...(initScript
                      ? [
                          '# Run init script',
                          'if [ -n "${INIT_SCRIPT}" ]; then',
                          `  echo "[workspace-init] running init script"`,
                          '  cd "$WORKTREE_DIR"',
                          '  eval "${INIT_SCRIPT}"',
                          `  echo "[workspace-init] init script completed"`,
                          'fi',
                        ]
                      : []),
                  ].join('\n')
                : // ── Local git ──────────────────────────────────────────
                  [
                    'set -e',
                    ...(spec.runner?.packages?.length
                      ? [
                          '# Install runner packages declared in spec.runner.packages',
                          'if [ -n "${RUNNER_PACKAGES}" ]; then',
                          '  echo "[workspace-init] installing packages: $RUNNER_PACKAGES"',
                          '  apk update --quiet && apk add --no-cache $RUNNER_PACKAGES',
                          '  echo "[workspace-init] package installation complete"',
                          'fi',
                        ]
                      : []),
                    `WORKSPACE_DIR="${dataMountPath}/workspace"`,
                    `mkdir -p "$WORKSPACE_DIR"`,
                    `if [ ! -d "$WORKSPACE_DIR/.git" ]; then`,
                    `  echo "[workspace-init] initialising local git repo at $WORKSPACE_DIR"`,
                    `  git init "$WORKSPACE_DIR"`,
                    // `git init` names the first branch after init.defaultBranch,
                    // which is unset in the runner image and so falls back to
                    // "master". Merge runs target "main" (worker-builder.ts) and
                    // review runs compute their diff base against it, so leaving
                    // the default put local workspaces on a branch the rest of
                    // the platform does not look for: reviewers logged
                    // "fatal: Not a valid object name main" and silently fell
                    // back to a bare SHA. Point HEAD at main before the first
                    // commit — this form works regardless of git version,
                    // unlike `git init -b` (2.28+).
                    `  git -C "$WORKSPACE_DIR" symbolic-ref HEAD refs/heads/main`,
                    `  git -C "$WORKSPACE_DIR" commit --allow-empty -m "Initial commit"`,
                    `else`,
                    `  echo "[workspace-init] resuming existing local workspace at $WORKSPACE_DIR"`,
                    // Unlike the remote-git path, every local run shares this one
                    // directory and branch — there is no per-run worktree to
                    // isolate them. Two consequences, and only one of them can be
                    // addressed from here.
                    //
                    // A run that dies before committing leaves its edits in the
                    // tree, and because the dispatcher refuses complete_run on a
                    // dirty tree the next worker has to commit them to finish its
                    // own task; they then land on its branch attributed to it.
                    // Report that, loudly, so it is at least diagnosable.
                    //
                    // Do NOT clean the tree here. This ran `git stash push -u`
                    // for exactly that reason, on the assumption that a fresh pod
                    // means any uncommitted work belongs to a run that has already
                    // ended. That assumption is false: flow.maxParallel allows
                    // concurrent runs and they all share this directory, so the
                    // stash reverted a live worker's in-flight edits and its next
                    // commit came out empty. Observed once, and it costs a whole
                    // run's work.
                    //
                    // The real fix is per-run worktrees for local sources, the way
                    // the remote path already works, which is more than an init
                    // container should decide.
                    `  if [ -n "$(git -C "$WORKSPACE_DIR" status --porcelain)" ]; then`,
                    `    echo "[workspace-init] warning: workspace is dirty before ${runName} starts."`,
                    `    echo "[workspace-init] warning: another run is either still working here or died before committing."`,
                    `    echo "[workspace-init] warning: changes committed by this run may not be its own."`,
                    `    git -C "$WORKSPACE_DIR" status --short`,
                    `  fi`,
                    `fi`,
                    '',
                    ...(initScript
                      ? [
                          'if [ -n "${INIT_SCRIPT}" ]; then',
                          `  echo "[workspace-init] running init script"`,
                          `  cd "$WORKSPACE_DIR"`,
                          '  eval "${INIT_SCRIPT}"',
                          `  echo "[workspace-init] init script completed"`,
                          'fi',
                        ]
                      : []),
                  ].join('\n'),
            ],
            env: [
              ...(git
                ? [{ name: 'GIT_TERMINAL_PROMPT', value: '0' }, ...gitAuthorEnv]
                : gitAuthorEnv),
              // Pass git.url/ref/parentRef via env vars so hostile values (a ref
              // containing ', $(), or ;) cannot execute arbitrary shell when
              // interpolated into the sh -c scripts below. INIT_SCRIPT already
              // ships this way; git fields follow the same pattern.
              ...(git
                ? [
                    { name: 'GIT_URL', value: git.url },
                    ...(git.ref ? [{ name: 'GIT_REF', value: git.ref }] : []),
                    ...(git.parentRef ? [{ name: 'GIT_PARENT_REF', value: git.parentRef }] : []),
                  ]
                : []),
              ...(initScript ? [{ name: 'INIT_SCRIPT', value: initScript }] : []),
              // Cache env vars so init scripts (e.g. pnpm install) use the data PVC
              { name: 'PNPM_HOME', value: `${dataMountPath}/cache/pnpm` },
              { name: 'pnpm_config_store_dir', value: `${dataMountPath}/cache/pnpm-store` },
              { name: 'NPM_CONFIG_CACHE', value: `${dataMountPath}/cache/npm` },
              { name: 'BUN_INSTALL_CACHE_DIR', value: `${dataMountPath}/cache/bun` },
              { name: 'TURBO_CACHE_DIR', value: `${dataMountPath}/cache/turbo` },
              ...(spec.runner?.packages?.length
                ? [{ name: 'RUNNER_PACKAGES', value: spec.runner.packages?.join(' ') }]
                : []),
            ],
            volumeMounts: [
              { name: 'data', mountPath: dataMountPath },
              ...(sshSecret
                ? [{ name: 'git-ssh', mountPath: '/etc/git-ssh', readOnly: true }]
                : []),
              ...(githubTokenSecret
                ? [{ name: 'git-github', mountPath: '/etc/git-github', readOnly: true }]
                : []),
              // Mount known_hosts for SSH host key verification (read-only) as its
              // own directory — never nested under the read-only /etc/git-ssh
              // secret mount (see knownHostsDir above).
              ...knownHostsVolumeMount,
            ],
            resources: initContainerResources,
          },
        ]
      : undefined;

  const injectFiles = spec.injectFiles ?? [];

  // Determine the workspace backing:
  //   - remote git → /data/worktrees/{run-name}/ via PVC subPath
  //   - local git  → /data/workspace/ via PVC subPath
  //   - no source  → ephemeral emptyDir (current behaviour)
  const workspaceSubPath = git ? `worktrees/${runName}` : localGit ? 'workspace' : undefined;

  const volumes = [
    // Workspace volume: only needed as a separate entry when not backed by the data PVC.
    // When workspaceSubPath is set, /workspace is served via the data volume with subPath
    // (avoids two volumes pointing at the same PVC which confuses the kubelet attach loop).
    ...(workspaceSubPath ? [] : [{ name: 'workspace', emptyDir: {} }]),
    // Data PVC for caches, git mirrors, worktrees, and local workspace (RWX for parallel workers)
    { name: 'data', persistentVolumeClaim: { claimName: dataPvcName } },
    // Projected ServiceAccount token, mounted into the dispatcher container ONLY
    // (see automountServiceAccountToken: false above). Replicates the default
    // in-cluster token/ca.crt/namespace so @kubernetes/client-node still works,
    // while keeping the token out of the untrusted runner container.
    {
      name: 'kube-api-access',
      projected: {
        defaultMode: 0o420,
        sources: [
          { serviceAccountToken: { path: 'token', expirationSeconds: 3607 } },
          {
            configMap: {
              name: 'kube-root-ca.crt',
              items: [{ key: 'ca.crt', path: 'ca.crt' }],
            },
          },
          {
            downwardAPI: {
              items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }],
            },
          },
        ],
      },
    },
    ...(sshSecret
      ? [
          {
            name: 'git-ssh',
            secret: {
              secretName: sshSecret.name,
              items: [{ key: sshSecret.key, path: 'id' }],
              defaultMode: 0o400,
            },
          },
        ]
      : []),
    ...(githubTokenSecret
      ? [
          {
            name: 'git-github',
            secret: {
              secretName: githubTokenSecret.name,
              items: [{ key: githubTokenSecret.key, path: 'token' }],
              defaultMode: 0o400,
            },
          },
        ]
      : []),
    ...(verifyHostKeys
      ? knownHostsSecret
        ? [
            {
              name: 'git-known-hosts',
              secret: {
                secretName: knownHostsSecret.name,
                items: [{ key: knownHostsSecret.key ?? 'known_hosts', path: 'known_hosts' }],
              },
            },
          ]
        : [
            // No known_hostsSecret provided but verification requested — mount an
            // empty directory so SSH has a readable parent for UserKnownHostsFile.
            // A missing known_hosts file reads as empty: host keys are accepted on
            // first connect under accept-new, rejected under strict. This is a
            // safety net for clusters that haven't provisioned known hosts yet.
            { name: 'git-known-hosts', emptyDir: {} },
          ]
      : []),
    ...(hasAgents
      ? [{ name: 'agents-volume', configMap: { name: agentsConfigMapName(run) } }]
      : []),
    // One volume per injected file — Secret projected via subPath into /workspace.
    ...injectFiles.map((f, i) => ({
      name: `inject-file-${i}`,
      secret: {
        secretName: f.secretRef.name,
        items: [{ key: f.secretRef.key, path: f.filename }],
      },
    })),
  ];

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName(run),
      namespace: run.metadata.namespace ?? '',
      labels: { ...commonLabels(run), [LABELS.component]: 'runner' },
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      restartPolicy: 'Never',
      serviceAccountName: DISPATCHER_SERVICE_ACCOUNT,
      // Do NOT auto-mount the ServiceAccount token into every container. The
      // untrusted runner (opencode) container runs AI-generated code and must
      // not be able to read a Kubernetes API token. The token is projected into
      // the dispatcher container only (see the kube-api-access volume + mount).
      automountServiceAccountToken: false,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      tolerations: [
        {
          key: 'percussionist.dev/workload',
          operator: 'Equal',
          value: 'transient',
          effect: 'NoExecute',
        },
      ],
      // Fall back to the 1-hour default so a spec without timeoutSeconds still
      // gets a pod deadline (matches RUN_TIMEOUT_SECONDS below).
      activeDeadlineSeconds: spec.timeoutSeconds ?? 3600,
      ...(initContainers ? { initContainers } : {}),
      containers: [
        {
          name: RUNNER_CONTAINER,
          image,
          imagePullPolicy: 'IfNotPresent',
          workingDir: '/workspace',
          // This container executes untrusted, AI-generated code. Drop every
          // capability and block setuid escalation. It still runs as UID 0
          // (the opencode base image is root-only: HOME=/root, and the agent
          // config mounts land under /root/.config), but root without
          // capabilities cannot chown, mknod, or load modules.
          //
          // Deliberately NOT applied to the init container, which needs root
          // and capabilities for `apk add` when spec.runner.packages is set.
          // Ad-hoc `apk add` from inside the agent session no longer works —
          // use spec.runner.packages or the install_packages tool instead.
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          ...(hasSidecars
            ? {
                command: ['/bin/sh', '-c'],
                args: [
                  `${waitScript}exec ${(runner.command ?? [`opencode`, `serve`, `--hostname`, `0.0.0.0`, `--port`, String(containerPort)]).join(' ')}`,
                ],
              }
            : {
                command: runner.command ?? [
                  'opencode',
                  'serve',
                  '--hostname',
                  '0.0.0.0',
                  '--port',
                  String(containerPort),
                ],
              }),
          ports: [{ name: 'http', containerPort }],
          env: [
            { name: 'NODE_OPTIONS', value: `--max-old-space-size=${nodeHeapMb}` },
            { name: 'OPENCODE_PORT', value: String(containerPort) },
            // Package manager cache configuration
            { name: 'PNPM_HOME', value: `${dataMountPath}/cache/pnpm` },
            { name: 'pnpm_config_store_dir', value: `${dataMountPath}/cache/pnpm-store` },
            { name: 'NPM_CONFIG_CACHE', value: `${dataMountPath}/cache/npm` },
            { name: 'BUN_INSTALL_CACHE_DIR', value: `${dataMountPath}/cache/bun` },
            { name: 'TURBO_CACHE_DIR', value: `${dataMountPath}/cache/turbo` },
            sshSecret
              ? {
                  name: 'GIT_SSH_COMMAND',
                  value: `ssh -i /etc/git-ssh/id${sshHostKeyOpts}${verifyHostKeys ? '' : ' -o IdentitiesOnly=yes'}`,
                }
              : {
                  name: 'GIT_SSH_COMMAND',
                  value: `ssh${sshHostKeyOpts}`,
                },
            ...(spec.secrets?.authSecret
              ? [
                  {
                    name: runner.authEnvVar,
                    valueFrom: {
                      secretKeyRef: {
                        name: spec.secrets.authSecret.name,
                        key: resolveAuthSecretKey(spec.secrets.authSecret.key, engine, runner),
                      },
                    },
                  },
                ]
              : []),
            // Claude-engine configuration, derived from the resolved agents
            // rather than from the cluster-wide opencode ConfigMap (whose
            // contents are opencode's own schema and mean nothing to Claude Code).
            ...(engine === 'claude'
              ? [
                  {
                    name: runner.configEnvVar,
                    value: renderClaudeSettings(resolvedAgents, spec.agent),
                  },
                  // A `mode: primary` agent describes how the session itself
                  // should behave. Claude Code would only read a subagent file
                  // when something invokes it via the Task tool, so the primary
                  // agent's body has to arrive as a system-prompt append.
                  ...(() => {
                    const prompt = primaryAgentSystemPrompt(resolvedAgents, spec.agent);
                    return prompt ? [{ name: 'CLAUDE_APPEND_SYSTEM_PROMPT', value: prompt }] : [];
                  })(),
                ]
              : [
                  // Always inject the cluster-wide runner config (providers, models, etc.)
                  // from the well-known "opencode-config" configmap.  Optional so pods start
                  // cleanly even if the configmap hasn't been created.
                  {
                    name: runner.configEnvVar,
                    valueFrom: {
                      configMapKeyRef: {
                        name: 'opencode-config',
                        key: runner.configMapKey,
                        optional: true,
                      },
                    },
                  },
                ]),
            // Per-run override from spec.secrets.configMap (takes precedence).
            ...(spec.secrets?.configMap
              ? [
                  {
                    name: runner.configEnvVar,
                    valueFrom: {
                      configMapKeyRef: {
                        name: spec.secrets.configMap.name,
                        key: spec.secrets.configMap.key,
                      },
                    },
                  },
                ]
              : []),
            // Note: the MCP stanza for percussionist-dispatcher is included in
            // the cluster-wide opencode-config ConfigMap so it reaches every pod
            // without requiring duplicate env var entries here.
            ...gitAuthorEnv,
            ...(githubTokenSecret
              ? [
                  {
                    name: 'GITHUB_TOKEN',
                    valueFrom: {
                      secretKeyRef: {
                        name: githubTokenSecret.name,
                        key: githubTokenSecret.key,
                      },
                    },
                  },
                ]
              : []),
          ],
          envFrom: llmKeysSecret ? [{ secretRef: { name: llmKeysSecret, optional: true } }] : [],
          readinessProbe: {
            tcpSocket: { port: 'http' as unknown as number },
            initialDelaySeconds: 2,
            periodSeconds: 3,
            failureThreshold: 30,
          },
          resources: spec.resources ?? {
            requests: { cpu: '200m', memory: '512Mi' },
            limits: { cpu: '2', memory: '8Gi' },
          },
          volumeMounts: [
            // /workspace: use subPath on the data volume when backed by PVC,
            // otherwise use the dedicated emptyDir workspace volume.
            workspaceSubPath
              ? { name: 'data', mountPath: '/workspace', subPath: workspaceSubPath }
              : { name: 'workspace', mountPath: '/workspace' },
            // Data volume for package manager caches, git mirrors, worktrees
            { name: 'data', mountPath: dataMountPath },
            ...(sshSecret ? [{ name: 'git-ssh', mountPath: '/etc/git-ssh', readOnly: true }] : []),
            ...(githubTokenSecret
              ? [{ name: 'git-github', mountPath: '/etc/git-github', readOnly: true }]
              : []),
            // Mount known_hosts for SSH host key verification (read-only) as its
            // own directory — never nested under the read-only /etc/git-ssh
            // secret mount (see knownHostsDir above).
            ...knownHostsVolumeMount,
            ...(hasAgents
              ? [
                  {
                    name: 'agents-volume',
                    mountPath: `${runner.configMountPath}/${runner.agentsDirRelative}`,
                  },
                ]
              : []),
            // Inject files into /workspace/<filename> via subPath mounts.
            ...injectFiles.map((f, i) => ({
              name: `inject-file-${i}`,
              mountPath: `/workspace/${f.filename}`,
              subPath: f.filename,
              readOnly: true,
            })),
          ],
        },
        {
          name: DISPATCHER_CONTAINER,
          image: dispatcherImage ?? DISPATCHER_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          // The dispatcher holds the ServiceAccount token, so it is the most
          // valuable container in the pod to compromise. It only makes HTTP
          // calls and writes the session snapshot — no capabilities needed.
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'RUN_NAME', value: run.metadata.name },
            { name: 'RUN_NAMESPACE', value: run.metadata.namespace ?? '' },
            { name: 'RUN_UID', value: run.metadata.uid ?? '' },
            {
              name: runner.baseUrlEnvVar,
              value: `http://127.0.0.1:${containerPort}`,
            },
            { name: 'WEB_STATS_URL', value: WEB_STATS_URL },
            // Passed as a literal rather than a secretKeyRef on purpose: a
            // secretKeyRef resolves in the RUN pod's namespace, which is not
            // necessarily the operator's (PERCUSSIONIST_NAMESPACE vs
            // PERCUSSIONIST_SELF_NAMESPACE; e2e runs in per-suite namespaces).
            // A missing secret there would silently yield an empty token and
            // drop stats reporting.
            //
            // The value is readable via `get pods` and by the agent itself, so
            // it is a per-run API key scoped to stats:write and expiring shortly
            // after this run's timeout — stealing it buys the ability to report
            // stats for a run that is already over. The shared WEB_AUTH_TOKEN is
            // only used as a fallback when key minting is unavailable.
            { name: 'WEB_AUTH_TOKEN', value: runApiKey ?? WEB_AUTH_TOKEN },
            ...(spec.task && !spec.interactive ? [{ name: 'RUN_TASK', value: spec.task }] : []),
            ...(spec.interactive ? [{ name: 'RUN_INTERACTIVE', value: '1' }] : []),
            ...(spec.model ? [{ name: 'RUN_MODEL', value: spec.model }] : []),
            ...(spec.agent ? [{ name: 'RUN_AGENT', value: spec.agent }] : []),
            ...(spec.facilitation
              ? [
                  {
                    name: 'RUN_CONTEXT',
                    value: spec.facilitation.successReview ? 'review-facilitator' : 'facilitator',
                  },
                ]
              : []),
            ...(spec.runContext ? [{ name: 'RUN_CONTEXT', value: spec.runContext }] : []),
            { name: 'RUN_PROJECT', value: spec.project },
            ...(spec.boardTask ? [{ name: 'RUN_BOARD_TASK', value: spec.boardTask }] : []),
            { name: 'RUN_TIMEOUT_SECONDS', value: String(spec.timeoutSeconds ?? 3600) },
          ],
          // The ServiceAccount token lives here (and only here — see
          // automountServiceAccountToken: false) so the dispatcher can patch the
          // Run status while the runner container has no cluster credentials.
          volumeMounts: [
            {
              name: 'kube-api-access',
              mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
              readOnly: true,
            },
          ],
          resources: {
            requests: { cpu: '50m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
        // Project-level sidecar containers (e.g. test databases).
        // They start alongside opencode; opencode waits for their ports.
        ...sidecars.map((sc) => {
          const securityContext = sanitizeSidecarSecurityContext(
            sc.securityContext,
            allowPrivilegedSidecars,
            sc.name,
          );
          return {
            name: sc.name,
            image: sc.image,
            imagePullPolicy: 'IfNotPresent' as const,
            ...(sc.env ? { env: sc.env } : {}),
            ...(sc.ports ? { ports: sc.ports.map((p) => ({ containerPort: p })) } : {}),
            ...(securityContext ? { securityContext } : {}),
          };
        }),
      ],
      volumes,
    },
  };
}
