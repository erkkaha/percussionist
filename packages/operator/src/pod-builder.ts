// pod-builder.ts — renders the Pod, Service, and Ingress for an Run.

import type { V1Ingress, V1Pod, V1Service } from '@kubernetes/client-node';
import {
  type AgentDef,
  API_GROUP_VERSION,
  DISPATCHER_CONTAINER,
  KIND_RUN,
  LABELS,
  MANAGED_BY,
  OPENCODE_RUNNER_DEFAULTS,
  RUNNER_CONTAINER,
  type Run,
  type RunnerImageSpec,
  type SidecarSpec,
  type SshHostKeyVerificationMode,
} from '@percussionist/api';
import { gitUrlHash } from '@percussionist/kube';
import {
  DISPATCHER_IMAGE,
  DISPATCHER_SERVICE_ACCOUNT,
  EXPOSE_WEB_DEFAULT,
  INGRESS_ANNOTATIONS,
  INGRESS_BASE_URL,
  INGRESS_CLASS,
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
function parentBaselineResolve(git: { ref?: string; parentRef?: string }): string {
  const ref = git.ref;
  if (!ref) throw new Error('git.ref is required');
  const parentRef = git.parentRef;
  if (!parentRef) throw new Error('git.parentRef is required');
  return `  # Resolve parent branch baseline: prefer remote-tracking ref for freshness,
  # fall back to local ref if remote-tracking doesn't exist yet (first BUILD).
  _PARENT_REMOTE_REF="refs/remotes/origin/${parentRef}"
  _PARENT_BASE_REF="${parentRef}"
  if git -C "$MIRROR_DIR" rev-parse "$_PARENT_REMOTE_REF" >/dev/null 2>&1; then
    _PARENT_BASE_REF="$_PARENT_REMOTE_REF"
    echo "[workspace-init] using remote-tracking ref $_PARENT_REMOTE_REF as parent baseline for ${ref}"
  else
    echo "[workspace-init] falling back to local ref ${parentRef} as parent baseline for ${ref}"
  fi`;
}

// ---------------------------------------------------------------------------
// Naming helpers

export const serviceName = (run: Run) => run.metadata.name;
export const podName = (run: Run) => run.metadata.name;
export const ingressName = (run: Run) => run.metadata.name;
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

// ---------------------------------------------------------------------------
// Ingress helpers

export function shouldCreateIngress(run: Run): boolean {
  if (!INGRESS_BASE_URL) return false;
  const exposeWeb = run.spec?.expose?.web;
  return exposeWeb === undefined ? EXPOSE_WEB_DEFAULT : exposeWeb;
}

export function webURLFor(run: Run): string {
  const url = new URL(INGRESS_BASE_URL);
  url.hostname = `${run.metadata.name}.${url.hostname}`;
  url.pathname = '/';
  return url.toString();
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

export function renderIngress(
  run: Run,
  runner: RunnerImageSpec = OPENCODE_RUNNER_DEFAULTS,
): V1Ingress {
  const containerPort = runner.port;
  const host = new URL(INGRESS_BASE_URL).hostname;
  const runHost = `${run.metadata.name}.${host}`;
  const ingress: V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ingressName(run),
      namespace: run.metadata.namespace ?? '',
      labels: { ...commonLabels(run), [LABELS.component]: 'opencode-web' },
      annotations: { ...INGRESS_ANNOTATIONS },
      ownerReferences: ownerRefsFor(run),
    },
    spec: {
      rules: [
        {
          host: runHost,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: serviceName(run),
                    port: { number: containerPort },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
  if (INGRESS_CLASS && ingress.spec) ingress.spec.ingressClassName = INGRESS_CLASS;
  return ingress;
}

export function renderAgentsConfigMap(run: Run, agents: AgentDef[]): object {
  const data: Record<string, string> = {};
  for (const a of agents) {
    data[`${a.name}.md`] = a.content;
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
  const image = spec.image ?? runner.image ?? RUNNER_IMAGE_DEFAULT;
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
                    `  export GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o IdentitiesOnly=yes${sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new' ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=/etc/git-ssh/known_hosts` : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'}"`,
                    '  echo "[workspace-init] using ssh key from secret"',
                    'else',
                    `  export GIT_SSH_COMMAND="ssh${sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new' ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=/etc/git-ssh/known_hosts` : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'}"`,
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
                    `    echo "[workspace-init] cloning mirror from ${git.url}"`,
                    `    git clone --mirror "${git.url}" "$MIRROR_DIR"`,
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
                                `  if git -C "$WORKTREE_DIR" checkout "${git.ref}" 2>/dev/null; then`,
                                `    echo "[workspace-init] checked out existing branch ${git.ref}"`,
                                `  elif git -C "$WORKTREE_DIR" checkout -b "${git.ref}" "origin/${git.ref}" 2>/dev/null; then`,
                                `    echo "[workspace-init] checked out remote branch ${git.ref}"`,
                                ...(git.parentRef
                                  ? [
                                      `  elif git -C "$WORKTREE_DIR" checkout -b "${git.ref}" "${git.parentRef}" 2>/dev/null; then`,
                                      `    echo "[workspace-init] created new branch ${git.ref} from ${git.parentRef}"`,
                                    ]
                                  : []),
                                `  else`,
                                `    echo "[workspace-init] warning: could not checkout or create branch ${git.ref}"`,
                                `  fi`,
                                `  # Reset to remote tip so the worktree always starts with the latest committed code.`,
                                `  # Uses origin/<ref> if available (worktree fetch sets up remote tracking),`,
                                `  # otherwise falls back to the mirror's ref directly.`,
                                `  if git -C "$WORKTREE_DIR" rev-parse "origin/${git.ref}" >/dev/null 2>&1; then`,
                                `    git -C "$WORKTREE_DIR" reset --hard "origin/${git.ref}" && echo "[workspace-init] reset to origin/${git.ref}"`,
                                `  else`,
                                `    echo "[workspace-init] no remote tracking branch for ${git.ref}, skipping reset"`,
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
                          ...(git.ref
                            ? [
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
                                `  # Try normal add; if branch already checked out elsewhere (e.g. BUILD worktree during review),`,
                                `  # force-add instead — detaches old worktree from the branch but preserves its files on disk.`,
                                `  # Note: bare mirrors store branches as refs/heads/<name> — no origin/ prefix needed`,
                                `  _BRANCH_LINE="branch refs/heads/${git.ref}"`,
                                `  if git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "$_BRANCH_LINE"; then`,
                                `    echo "[workspace-init] branch ${git.ref} checked out elsewhere — force-adding worktree"`,
                                `    git -C "$MIRROR_DIR" worktree add --force "$WORKTREE_DIR" "${git.ref}"`,
                                `    echo "[workspace-init] worktree force-added with branch ${git.ref}"`,
                                `  elif git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR" "${git.ref}" 2>/dev/null; then`,
                                `    echo "[workspace-init] worktree added with branch ${git.ref}"`,
                                ...(git.parentRef
                                  ? [
                                      `  else`,
                                      parentBaselineResolve(git),
                                      `    # Create new branch from resolved parent baseline`,
                                      `    git -C "$MIRROR_DIR" worktree add -b "${git.ref}" "$WORKTREE_DIR" "$_PARENT_BASE_REF"`,
                                      `    echo "[workspace-init] created new branch ${git.ref} from $_PARENT_BASE_REF"`,
                                    ]
                                  : [
                                      `  else`,
                                      `    echo "[workspace-init] error: failed to add worktree with branch ${git.ref}"`,
                                      `    exit 1`,
                                    ]),
                                `  fi`,
                              ]
                            : [`  git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR"`]),
                          `fi`,
                        ]
                      : [
                          `# freshWorktree mode: always recreate`,
                          `if [ -d "$WORKTREE_DIR" ]; then`,
                          `  git -C "$MIRROR_DIR" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"`,
                          `fi`,
                          ...(git.ref
                            ? [
                                `git -C "$MIRROR_DIR" worktree prune --expire=now 2>/dev/null || true`,
                                '# Re-sync refs/heads from remotes/origin',
                                "# Skip HEAD — it's a symbolic ref, not a real branch.",
                                'for _REMOTE_REF in $(git -C "$MIRROR_DIR" for-each-ref --format=\'%(refname)\' refs/remotes/origin/ 2>/dev/null || true); do',
                                '  _BRANCH="${_REMOTE_REF#refs/remotes/origin/}"',
                                '  [ "$_BRANCH" = "HEAD" ] && continue',
                                '  if ! git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "branch refs/heads/$_BRANCH"; then',
                                '    git -C "$MIRROR_DIR" update-ref "refs/heads/$_BRANCH" "$_REMOTE_REF" 2>/dev/null || true',
                                '  fi',
                                'done',
                                `# Try normal add; if branch already checked out elsewhere (e.g. BUILD worktree during review),`,
                                `# force-add instead — detaches old worktree from the branch but preserves its files on disk.`,
                                `# Note: bare mirrors store branches as refs/heads/<name> — no origin/ prefix needed`,
                                `_BRANCH_LINE="branch refs/heads/${git.ref}"`,
                                `if git -C "$MIRROR_DIR" worktree list --porcelain 2>/dev/null | grep -qF "$_BRANCH_LINE"; then`,
                                `  echo "[workspace-init] branch ${git.ref} checked out elsewhere — force-adding worktree"`,
                                `  git -C "$MIRROR_DIR" worktree add --force "$WORKTREE_DIR" "${git.ref}"`,
                                `  echo "[workspace-init] worktree force-added with branch ${git.ref}"`,
                                `elif git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR" "${git.ref}" 2>/dev/null; then`,
                                `  echo "[workspace-init] worktree added with branch ${git.ref}"`,
                                ...(git.parentRef
                                  ? [
                                      `else`,
                                      parentBaselineResolve(git),
                                      `  # Create new branch from resolved parent baseline`,
                                      `  git -C "$MIRROR_DIR" worktree add -b "${git.ref}" "$WORKTREE_DIR" "$_PARENT_BASE_REF"`,
                                      `  echo "[workspace-init] created new branch ${git.ref} from $_PARENT_BASE_REF"`,
                                    ]
                                  : [
                                      `else`,
                                      `  echo "[workspace-init] error: failed to add worktree with branch ${git.ref}"`,
                                      `  exit 1`,
                                    ]),
                                `fi`,
                              ]
                            : [`git -C "$MIRROR_DIR" worktree add "$WORKTREE_DIR"`]),
                        ]),
                    '',
                    '# Ensure remote URL points to real remote (not file://) so agent can push',
                    `git -C "$WORKTREE_DIR" remote set-url origin "${git.url}" 2>/dev/null || true`,
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
                    `  git -C "$WORKSPACE_DIR" commit --allow-empty -m "Initial commit"`,
                    `else`,
                    `  echo "[workspace-init] resuming existing local workspace at $WORKSPACE_DIR"`,
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
              // Mount known_hosts for SSH host key verification (read-only).
              // When sshHostKeyVerification is strict/accept-new and a known_hostsSecret
              // is provided, this mounts the secret as /etc/git-ssh/known_hosts.
              ...(sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new'
                ? [
                    {
                      name: 'git-known-hosts',
                      mountPath: '/etc/git-ssh/known_hosts',
                      subPath: 'known_hosts',
                      readOnly: true,
                    },
                  ]
                : []),
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
    ...(sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new'
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
            // No known_hostsSecret provided but strict mode requested — create an empty
            // file so SSH doesn't fail on missing file. Host keys will be accepted via
            // accept-new (first connect) or rejected (strict). This is a safety net for
            // clusters that haven't provisioned known hosts yet.
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
      tolerations: [
        {
          key: 'percussionist.dev/workload',
          operator: 'Equal',
          value: 'transient',
          effect: 'NoExecute',
        },
      ],
      activeDeadlineSeconds: spec.timeoutSeconds,
      ...(initContainers ? { initContainers } : {}),
      containers: [
        {
          name: RUNNER_CONTAINER,
          image,
          imagePullPolicy: 'IfNotPresent',
          workingDir: '/workspace',
          ...(hasSidecars
            ? {
                command: ['/bin/sh', '-c'],
                args: [
                  `${waitScript}exec ${(runner.command ?? [`opencode`, `web`, `--hostname`, `0.0.0.0`, `--port`, String(containerPort)]).join(' ')}`,
                ],
              }
            : {
                command: runner.command ?? [
                  'opencode',
                  'web',
                  '--hostname',
                  '0.0.0.0',
                  '--port',
                  String(containerPort),
                ],
              }),
          ports: [{ name: 'http', containerPort }],
          env: [
            { name: 'NODE_OPTIONS', value: `--max-old-space-size=${nodeHeapMb}` },
            // Package manager cache configuration
            { name: 'PNPM_HOME', value: `${dataMountPath}/cache/pnpm` },
            { name: 'pnpm_config_store_dir', value: `${dataMountPath}/cache/pnpm-store` },
            { name: 'NPM_CONFIG_CACHE', value: `${dataMountPath}/cache/npm` },
            { name: 'BUN_INSTALL_CACHE_DIR', value: `${dataMountPath}/cache/bun` },
            { name: 'TURBO_CACHE_DIR', value: `${dataMountPath}/cache/turbo` },
            sshSecret
              ? {
                  name: 'GIT_SSH_COMMAND',
                  value: `ssh -i /etc/git-ssh/id${sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new' ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=/etc/git-ssh/known_hosts` : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'}${sshHostKeyVerification !== 'strict' && sshHostKeyVerification !== 'accept-new' ? ' -o IdentitiesOnly=yes' : ''}`,
                }
              : {
                  name: 'GIT_SSH_COMMAND',
                  value: `ssh${sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new' ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=/etc/git-ssh/known_hosts` : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'}`,
                },
            ...(spec.secrets?.authSecret
              ? [
                  {
                    name: runner.authEnvVar,
                    valueFrom: {
                      secretKeyRef: {
                        name: spec.secrets.authSecret.name,
                        key: spec.secrets.authSecret.key ?? 'auth.json',
                      },
                    },
                  },
                ]
              : []),
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
            // Mount known_hosts for SSH host key verification (read-only).
            // When sshHostKeyVerification is strict/accept-new and a known_hostsSecret
            // is provided, this mounts the secret as /etc/git-ssh/known_hosts.
            ...(sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new'
              ? [
                  {
                    name: 'git-known-hosts',
                    mountPath: '/etc/git-ssh/known_hosts',
                    subPath: 'known_hosts',
                    readOnly: true,
                  },
                ]
              : []),
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
          env: [
            { name: 'RUN_NAME', value: run.metadata.name },
            { name: 'RUN_NAMESPACE', value: run.metadata.namespace ?? '' },
            { name: 'RUN_UID', value: run.metadata.uid ?? '' },
            {
              name: runner.baseUrlEnvVar,
              value: `http://127.0.0.1:${containerPort}`,
            },
            { name: 'WEB_STATS_URL', value: WEB_STATS_URL },
            { name: 'WEB_AUTH_TOKEN', value: WEB_AUTH_TOKEN },
            ...(spec.task && !spec.interactive ? [{ name: 'RUN_TASK', value: spec.task }] : []),
            ...(spec.interactive ? [{ name: 'RUN_INTERACTIVE', value: '1' }] : []),
            ...(spec.model ? [{ name: 'RUN_MODEL', value: spec.model }] : []),
            ...(spec.agent ? [{ name: 'RUN_AGENT', value: spec.agent }] : []),
            { name: 'RUN_PROJECT', value: spec.project },
            ...(spec.boardTask ? [{ name: 'RUN_BOARD_TASK', value: spec.boardTask }] : []),
            { name: 'RUN_TIMEOUT_SECONDS', value: String(spec.timeoutSeconds ?? 3600) },
          ],
          resources: {
            requests: { cpu: '50m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
        // Project-level sidecar containers (e.g. test databases).
        // They start alongside opencode; opencode waits for their ports.
        ...sidecars.map((sc) => ({
          name: sc.name,
          image: sc.image,
          imagePullPolicy: 'IfNotPresent' as const,
          ...(sc.env ? { env: sc.env } : {}),
          ...(sc.ports ? { ports: sc.ports.map((p) => ({ containerPort: p })) } : {}),
          ...(sc.securityContext ? { securityContext: sc.securityContext } : {}),
        })),
      ],
      volumes,
    },
  };
}
