// code-server.ts — Renders Deployment, Service, and Ingress for per-project code-server instances.
//
// Code-server provides interactive VS Code access to the project's data PVC,
// allowing operators to browse worktrees, git mirrors, and caches.
//
// URL mechanism:
//   - The operator creates an Ingress (hostname only — K8s Ingress rules do not
//     include ports) and a ClusterIP Service (port 8080) for internal routing when
//     PERCUSSIONIST_INGRESS_BASE_URL is configured.
//   - The web UI computes external links using ClusterSettings.spec.codeServerUrlTemplate
//     (template with {project}, may include port). This template is authoritative
//     for the sidebar and board header links shown to users.
//   - Both can coexist: the Ingress provides the actual route, the template
//     tells the UI where the route is reachable from the browser.

import type {
  V1Container,
  V1Deployment,
  V1EnvVar,
  V1Ingress,
  V1Service,
} from '@kubernetes/client-node';
import {
  API_GROUP_VERSION,
  CODE_SERVER_DEFAULT_IMAGE,
  CODE_SERVER_PORT,
  KIND_PROJECT,
  LABELS,
  MANAGED_BY,
  type Project,
  type SshHostKeyVerificationMode,
} from '@percussionist/api';
import { INGRESS_ANNOTATIONS, INGRESS_BASE_URL, INGRESS_CLASS } from './config.js';

// ---------------------------------------------------------------------------
// Naming helpers

export function ideDeploymentName(project: Project): string {
  return `ide-${project.metadata.name}`;
}

export function ideServiceName(project: Project): string {
  return `ide-${project.metadata.name}`;
}

// ---------------------------------------------------------------------------
// Condition check

/**
 * Returns true if code-server should be reconciled for this project.
 * Requires codeServer.enabled AND (source.git OR source.local) for a data PVC.
 */
export function shouldReconcileCodeServer(project: Project): boolean {
  const spec = project.spec;
  if (!spec.codeServer?.enabled) return false;
  // Requires source.git or source.local for a data PVC to mount
  return !!(spec.source?.git || spec.source?.local);
}

// ---------------------------------------------------------------------------
// Resource renderers

/**
 * Renders a Deployment for code-server.
 *
 * An init container writes default config files to the project's data PVC on
 * first start so that code-server starts with a themed, pre-configured VS Code
 * environment.  The init container shares the same image and volume mount as
 * the main container.
 *
 * Injected files on the PVC (first-run only — customisations survive restarts):
 *   - .code-server-config/config.yaml           — code-server server config
 *   - .code-server-vscode/User/settings.json    — VS Code user settings
 *   - .code-server-vscode/.gitconfig            — git safe.directory (scoped to code-server)
 */
export function renderIdeDeployment(project: Project): V1Deployment {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';
  const spec = project.spec;

  const image = spec.codeServer?.image ?? CODE_SERVER_DEFAULT_IMAGE;
  const pvcName = spec.data?.pvcName ?? `${name}-data`;
  const mountPath = spec.data?.mountPath ?? '/data';

  // Default resources if not specified
  const resources = spec.codeServer?.resources ?? {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { memory: '512Mi' },
  };

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'code-server',
  };

  // Paths for config files on the shared data PVC
  const configDir = `${mountPath}/.code-server-config`;
  const vscodeDataDir = `${mountPath}/.code-server-vscode`;

  // Packages to install in the init container.
  const codeServerPackages = spec.codeServer?.packages;

  const git = spec.source?.git;

  // ── Human folder resolution ──────────────────────────────────────────────
  // Opt-in persistent folder on the data PVC (default name `code`) cloned from
  // the project repo so a human opening code-server lands in a usable repo
  // instead of the raw PVC root. Branch resolves humanFolder.branch →
  // spec.source.git.ref → unset (clone default HEAD). URL resolves
  // humanFolder.remoteUrl → spec.source.git.url → unset (local bootstrap).
  const humanFolder = spec.codeServer?.humanFolder;
  const humanFolderEnabled = humanFolder?.enabled === true;
  const humanFolderName = humanFolder?.name ?? 'code';
  const humanDir = humanFolderEnabled ? `${mountPath}/${humanFolderName}` : undefined;
  const humanFolderBranch = humanFolderEnabled ? (humanFolder?.branch ?? git?.ref) : undefined;
  const humanFolderRemoteUrl = humanFolderEnabled
    ? (humanFolder?.remoteUrl ?? git?.url)
    : undefined;
  const humanFolderAuthor = git?.author ?? {
    name: 'Percussionist Agent',
    email: 'agent@percussionist.dev',
  };

  // ── SSH auth for the human-folder clone ──────────────────────────────────
  // Mirrors pod-builder.ts. The deploy key is mounted into the init container
  // ONLY — the main code-server container runs with `auth: none` (config.yaml),
  // so exposing the project's deploy key to the no-auth IDE would be a
  // privilege escalation.
  const sshSecret = git?.sshSecret
    ? { ...git.sshSecret, key: git.sshSecret.key ?? 'ssh-privatekey' }
    : undefined;
  const sshHostKeyVerification: SshHostKeyVerificationMode = git?.sshHostKeyVerification ?? 'no';
  const knownHostsSecret = git?.known_hostsSecret;
  const verifyHostKeys =
    sshHostKeyVerification === 'strict' || sshHostKeyVerification === 'accept-new';
  // known_hosts gets its own mount directory and must NOT live under
  // /etc/git-ssh (read-only secret tmpfs — see pod-builder.ts).
  const knownHostsDir = '/etc/git-known-hosts';
  const knownHostsPath = `${knownHostsDir}/known_hosts`;
  const sshHostKeyOpts = verifyHostKeys
    ? ` -o StrictHostKeyChecking=${sshHostKeyVerification} -o UserKnownHostsFile=${knownHostsPath}`
    : ' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';

  // Human-folder init block: idempotently clone/refresh the persistent folder
  // on the data PVC. Runs under `set -e`, so every fallible git op is guarded
  // with `|| true` and a clone/fetch failure falls back to the `git init`
  // bootstrap — the pod must always come up. URL/branch/author arrive via env
  // (HUMAN_FOLDER_*) so shell metacharacters in the spec can never break the
  // script. Rendered only when enabled; empty otherwise so the disabled
  // Deployment stays byte-identical to the pre-humanFolder behaviour.
  const humanFolderScript = humanFolderEnabled
    ? `
# ── Human folder: persistent repo clone on the data PVC ─────────────────
HUMAN_DIR="${humanDir}"
mkdir -p "$HUMAN_DIR"
# The bootstrap empty commit below needs an author identity: it comes from the
# GIT_AUTHOR_*/GIT_COMMITTER_* env vars on this container (same pattern as the
# workspace-init container in pod-builder.ts), so it succeeds even before the
# repo-local user.name/user.email seeding at the end of this block.
if [ ! -d "$HUMAN_DIR/.git" ]; then
  if [ -n "\${HUMAN_FOLDER_REMOTE_URL}" ]; then
    echo "[code-server-init] cloning \${HUMAN_FOLDER_REMOTE_URL} into $HUMAN_DIR"
    if git clone "\${HUMAN_FOLDER_REMOTE_URL}" "$HUMAN_DIR" 2>&1; then
      if [ -n "\${HUMAN_FOLDER_BRANCH}" ]; then
        if ! git -C "$HUMAN_DIR" checkout "\${HUMAN_FOLDER_BRANCH}" 2>/dev/null; then
          echo "[code-server-init] creating local branch \${HUMAN_FOLDER_BRANCH} from origin/\${HUMAN_FOLDER_BRANCH}"
          git -C "$HUMAN_DIR" checkout -b "\${HUMAN_FOLDER_BRANCH}" "origin/\${HUMAN_FOLDER_BRANCH}" 2>&1 || \\
            echo "[code-server-init] could not checkout \${HUMAN_FOLDER_BRANCH}; staying on clone default HEAD"
        fi
      fi
    else
      echo "[code-server-init] clone failed; bootstrapping empty git repo at $HUMAN_DIR"
      git init "$HUMAN_DIR" 2>&1 || true
      git -C "$HUMAN_DIR" symbolic-ref HEAD "refs/heads/\${HUMAN_FOLDER_BRANCH:-main}" 2>&1 || true
      git -C "$HUMAN_DIR" commit --allow-empty -m "Initial commit" 2>&1 || true
    fi
  else
    echo "[code-server-init] no remote URL; bootstrapping empty git repo at $HUMAN_DIR"
    git init "$HUMAN_DIR" 2>&1 || true
    git -C "$HUMAN_DIR" symbolic-ref HEAD "refs/heads/\${HUMAN_FOLDER_BRANCH:-main}" 2>&1 || true
    git -C "$HUMAN_DIR" commit --allow-empty -m "Initial commit" 2>&1 || true
  fi
else
  # Refresh an existing human folder (pod restart): ensure origin points at the
  # remote, fetch, checkout the resolved branch, then ff-only pull. Local human
  # changes are never deleted.
  echo "[code-server-init] refreshing existing human folder $HUMAN_DIR"
  if [ -n "\${HUMAN_FOLDER_REMOTE_URL}" ]; then
    git -C "$HUMAN_DIR" remote set-url origin "\${HUMAN_FOLDER_REMOTE_URL}" 2>/dev/null || \\
      git -C "$HUMAN_DIR" remote add origin "\${HUMAN_FOLDER_REMOTE_URL}" 2>/dev/null || true
    git -C "$HUMAN_DIR" fetch origin 2>&1 || echo "[code-server-init] fetch failed; keeping local state"
    if [ -n "\${HUMAN_FOLDER_BRANCH}" ]; then
      if ! git -C "$HUMAN_DIR" checkout "\${HUMAN_FOLDER_BRANCH}" 2>/dev/null; then
        git -C "$HUMAN_DIR" checkout -b "\${HUMAN_FOLDER_BRANCH}" "origin/\${HUMAN_FOLDER_BRANCH}" 2>&1 || true
      fi
      git -C "$HUMAN_DIR" pull --ff-only origin "\${HUMAN_FOLDER_BRANCH}" 2>&1 || \\
        echo "[code-server-init] pull failed; keeping local changes"
    fi
  fi
fi
# Best-effort author seeding so the human's first commit works without
# configuring git (spec.source.git.author with fallback defaults). Seed only
# when unset — a human who sets their own name/email in the folder must keep
# it across pod restarts. The bootstrap commit above already has an identity
# via the GIT_AUTHOR_*/GIT_COMMITTER_* env vars on this container; this
# repo-local config is for the human's own commits in the IDE.
if [ -n "\${HUMAN_FOLDER_AUTHOR_NAME}" ]; then
  git -C "$HUMAN_DIR" config --get user.name >/dev/null 2>&1 || \\
    git -C "$HUMAN_DIR" config user.name "\${HUMAN_FOLDER_AUTHOR_NAME}" 2>/dev/null || true
fi
if [ -n "\${HUMAN_FOLDER_AUTHOR_EMAIL}" ]; then
  git -C "$HUMAN_DIR" config --get user.email >/dev/null 2>&1 || \\
    git -C "$HUMAN_DIR" config user.email "\${HUMAN_FOLDER_AUTHOR_EMAIL}" 2>/dev/null || true
fi
`
    : '';

  // Init container command: seed default config files to the PVC (first-run only).
  // Once the user customises any file via the editor, pod restarts preserve their changes
  // because the `[ -f ... ] ||` guard skips overwrite.
  const initScript = `
set -e
mkdir -p "${configDir}" "${vscodeDataDir}/User"

# Install extra packages (per-project via spec.codeServer.packages)
if [ -n "\${CODE_SERVER_PACKAGES}" ]; then
  echo "[code-server-init] installing packages: $CODE_SERVER_PACKAGES"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq --no-install-recommends $CODE_SERVER_PACKAGES
  elif command -v apk >/dev/null 2>&1; then
    apk update --quiet && apk add --no-cache $CODE_SERVER_PACKAGES
  fi
fi

[ -f "${configDir}/config.yaml" ] || cat > "${configDir}/config.yaml" << 'CODECD'
bind-addr: 0.0.0.0:8080
auth: none
disable-telemetry: true
disable-update-check: true
disable-workspace-trust: true
ignore-last-opened: true
disable-getting-started-override: true
app-name: "Percussionist"
CODECD

[ -f "${vscodeDataDir}/User/settings.json" ] || cat > "${vscodeDataDir}/User/settings.json" << 'VSCTX'
{
  "workbench.colorTheme": "Default Dark+",
  "workbench.colorCustomizations": {
    "[Default Dark+]": {
      "editor.background": "#111317",
      "editor.foreground": "#e2e2e8",
      "editorLineNumber.foreground": "#514537",
      "editorLineNumber.activeForeground": "#e8a852",
      "editorCursor.foreground": "#e8a852",
      "editor.selectionBackground": "#37393e",
      "editor.selectionHighlightBackground": "#514537",
      "editor.wordHighlightBackground": "#514537",
      "editor.wordHighlightStrongBackground": "#9e8e7e",
      "editor.findMatchBackground": "#845400",
      "editor.findMatchHighlightBackground": "#633e00",
      "editorBracketMatch.background": "#514537",
      "editorBracketMatch.border": "#e8a852",
      "editorIndentGuide.background": "#1e2024",
      "editorIndentGuide.activeBackground": "#37393e",
      "editorWhitespace.foreground": "#333539",
      "editorRuler.foreground": "#514537",
      "editorWidget.background": "#1e2024",
      "editorWidget.border": "#514537",
      "editorHoverWidget.background": "#1e2024",
      "editorHoverWidget.border": "#514537",
      "editorSuggestWidget.background": "#1e2024",
      "editorSuggestWidget.border": "#514537",
      "editorSuggestWidget.selectedBackground": "#282a2e",
      "editorGutter.background": "#111317",
      "editorGutter.modifiedBackground": "#e8a852",
      "editorGutter.addedBackground": "#58ea8a",
      "editorGutter.deletedBackground": "#ffb4ab",

      "activityBar.background": "#1a1c20",
      "activityBar.foreground": "#e2e2e8",
      "activityBar.inactiveForeground": "#9e8e7e",
      "activityBar.border": "#514537",
      "activityBarBadge.background": "#e8a852",
      "activityBarBadge.foreground": "#462a00",

      "sideBar.background": "#1a1c20",
      "sideBar.foreground": "#e2e2e8",
      "sideBar.border": "#514537",
      "sideBarTitle.foreground": "#e2e2e8",
      "sideBarSectionHeader.background": "#1e2024",
      "sideBarSectionHeader.foreground": "#e2e2e8",

      "titleBar.activeBackground": "#1a1c20",
      "titleBar.activeForeground": "#e2e2e8",
      "titleBar.border": "#514537",

      "statusBar.background": "#1a1c20",
      "statusBar.foreground": "#e2e2e8",
      "statusBar.border": "#514537",
      "statusBarItem.hoverBackground": "#282a2e",
      "statusBarItem.remoteBackground": "#e8a852",
      "statusBarItem.remoteForeground": "#462a00",

      "panel.background": "#111317",
      "panel.border": "#514537",
      "panelTitle.activeForeground": "#e8a852",
      "panelTitle.inactiveForeground": "#9e8e7e",
      "panelTitle.border": "#514537",

      "terminal.background": "#111317",
      "terminal.foreground": "#e2e2e8",
      "terminalCursor.foreground": "#e8a852",
      "terminal.ansiBlack": "#111317",
      "terminal.ansiRed": "#ffb4ab",
      "terminal.ansiGreen": "#58ea8a",
      "terminal.ansiYellow": "#ffc67d",
      "terminal.ansiBlue": "#58c4dd",
      "terminal.ansiMagenta": "#c8c5cb",
      "terminal.ansiCyan": "#e8a852",
      "terminal.ansiWhite": "#e2e2e8",
      "terminal.ansiBrightBlack": "#9e8e7e",
      "terminal.ansiBrightRed": "#ffb4ab",
      "terminal.ansiBrightGreen": "#58ea8a",
      "terminal.ansiBrightYellow": "#ffc67d",
      "terminal.ansiBrightBlue": "#58c4dd",
      "terminal.ansiBrightMagenta": "#c8c5cb",
      "terminal.ansiBrightCyan": "#e8a852",
      "terminal.ansiBrightWhite": "#e2e2e8",

      "input.background": "#111317",
      "input.foreground": "#e2e2e8",
      "input.border": "#514537",
      "input.placeholderForeground": "#9e8e7e",
      "inputOption.activeBackground": "#e8a852",
      "inputOption.activeForeground": "#462a00",
      "inputValidation.errorBackground": "#93000a",
      "inputValidation.errorBorder": "#ffb4ab",

      "button.background": "#e8a852",
      "button.foreground": "#462a00",
      "button.hoverBackground": "#ffc67d",
      "button.secondaryBackground": "#282a2e",
      "button.secondaryForeground": "#e2e2e8",
      "button.secondaryHoverBackground": "#333539",

      "tab.activeBackground": "#1e2024",
      "tab.activeForeground": "#e2e2e8",
      "tab.inactiveBackground": "#1a1c20",
      "tab.inactiveForeground": "#9e8e7e",
      "tab.border": "#514537",
      "tab.activeBorderTop": "#e8a852",
      "tab.hoverBackground": "#282a2e",

      "list.activeSelectionBackground": "#282a2e",
      "list.activeSelectionForeground": "#e2e2e8",
      "list.inactiveSelectionBackground": "#282a2e",
      "list.inactiveSelectionForeground": "#e2e2e8",
      "list.hoverBackground": "#1a1c20",
      "list.highlightForeground": "#e8a852",
      "list.focusHighlightForeground": "#e8a852",
      "list.dropBackground": "#37393e",

      "scrollbar.shadow": "#0c0e12",
      "scrollbarSlider.background": "#514537",
      "scrollbarSlider.hoverBackground": "#9e8e7e",
      "scrollbarSlider.activeBackground": "#9e8e7e",

      "badge.background": "#e8a852",
      "badge.foreground": "#462a00",

      "notificationCenterHeader.background": "#1a1c20",
      "notificationCenter.border": "#514537",
      "notifications.background": "#1e2024",
      "notifications.border": "#514537",
      "notificationLink.foreground": "#e8a852",

      "pickerGroup.foreground": "#e8a852",
      "pickerGroup.border": "#514537",
      "quickInput.background": "#1e2024",
      "quickInput.foreground": "#e2e2e8",
      "menubar.selectionBackground": "#282a2e",
      "menu.background": "#1e2024",
      "menu.foreground": "#e2e2e8",
      "menu.selectionBackground": "#282a2e",
      "menu.separatorBackground": "#514537",

      "diffEditor.insertedTextBackground": "rgba(88, 234, 138, 0.06)",
      "diffEditor.removedTextBackground": "rgba(255, 180, 171, 0.06)",

      "focusBorder": "#e8a852",
      "descriptionForeground": "#d5c4b2",
      "errorForeground": "#ffb4ab",

      "peekView.border": "#e8a852",
      "peekViewEditor.background": "#111317",
      "peekViewResult.background": "#111317",
      "peekViewResult.selectionBackground": "#282a2e",
      "peekViewTitle.background": "#1e2024",

      "settings.headerForeground": "#e2e2e8",
      "settings.modifiedItemIndicator": "#e8a852",
      "settings.dropdownBackground": "#111317",
      "settings.dropdownBorder": "#514537",
      "settings.checkboxBackground": "#111317",
      "settings.checkboxBorder": "#514537",

      "debugToolBar.background": "#1e2024",
      "debugIcon.startForeground": "#58ea8a",
      "debugIcon.stopForeground": "#ffb4ab"
    }
  },
  "editor.fontFamily": "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
  "editor.fontLigatures": true,
  "editor.fontSize": 14,
  "editor.lineHeight": 24,
  "editor.smoothScrolling": true,
  "editor.cursorBlinking": "smooth",
  "editor.cursorSmoothCaretAnimation": "on",
  "editor.bracketPairColorization.enabled": true,
  "editor.guides.bracketPairs": true,
  "editor.tabSize": 2,
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 1000,
  "workbench.startupEditor": "none",
  "workbench.sideBar.location": "left",
  "window.titleBarStyle": "custom",
  "window.menuBarVisibility": "toggle",
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.fontFamily": "'JetBrains Mono', 'Fira Code', monospace",
  "terminal.integrated.fontLigatures": true,
  "terminal.integrated.cursorBlinking": true,
  "extensions.autoUpdate": false,
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "workbench.enableExperiments": false,
  "files.exclude": {
    "**/.git": false
  }
}
VSCTX

# git config — scoped to this project's code-server only, not shared with runner pods
[ -f "${vscodeDataDir}/.gitconfig" ] || cat > "${vscodeDataDir}/.gitconfig" << 'GITCFG'
[safe]
	directory = *
GITCFG
${humanFolderScript}`;

  const initEnv: V1EnvVar[] = [];
  if (codeServerPackages && codeServerPackages.length > 0) {
    initEnv.push({ name: 'CODE_SERVER_PACKAGES', value: codeServerPackages.join(' ') });
  }
  if (humanFolderEnabled) {
    // URL/branch/author are passed via env so shell metacharacters in the spec
    // can never break the init script; GIT_TERMINAL_PROMPT=0 ensures a missing
    // key never hangs the pod on an auth prompt.
    if (humanFolderRemoteUrl) {
      initEnv.push({ name: 'HUMAN_FOLDER_REMOTE_URL', value: humanFolderRemoteUrl });
    }
    if (humanFolderBranch) {
      initEnv.push({ name: 'HUMAN_FOLDER_BRANCH', value: humanFolderBranch });
    }
    initEnv.push({ name: 'HUMAN_FOLDER_AUTHOR_NAME', value: humanFolderAuthor.name });
    initEnv.push({ name: 'HUMAN_FOLDER_AUTHOR_EMAIL', value: humanFolderAuthor.email });
    // Author identity for git operations the init script performs itself (the
    // git-init bootstrap's empty initial commit) — same env pattern as the
    // workspace-init container in pod-builder.ts. These apply only to this
    // container's git invocations; the main code-server container does not get
    // them, so the human's own commits use the repo-local config seeded by the
    // script (unset-only).
    initEnv.push({ name: 'GIT_AUTHOR_NAME', value: humanFolderAuthor.name });
    initEnv.push({ name: 'GIT_AUTHOR_EMAIL', value: humanFolderAuthor.email });
    initEnv.push({ name: 'GIT_COMMITTER_NAME', value: humanFolderAuthor.name });
    initEnv.push({ name: 'GIT_COMMITTER_EMAIL', value: humanFolderAuthor.email });
    initEnv.push({ name: 'GIT_TERMINAL_PROMPT', value: '0' });
    if (sshSecret) {
      initEnv.push({
        name: 'GIT_SSH_COMMAND',
        value: `ssh -i /etc/git-ssh/id${sshHostKeyOpts} -o IdentitiesOnly=yes`,
      });
    }
  }

  const initContainer: V1Container = {
    name: 'code-server-init',
    image,
    command: ['/bin/sh', '-c', initScript],
    env: initEnv.length > 0 ? initEnv : undefined,
    volumeMounts: [
      { name: 'data', mountPath },
      // The deploy key is mounted in the init container only — never in the
      // main code-server container (auth: none IDE must not expose the key).
      ...(humanFolderEnabled && sshSecret
        ? [{ name: 'git-ssh', mountPath: '/etc/git-ssh', readOnly: true }]
        : []),
      ...(humanFolderEnabled && sshSecret && verifyHostKeys
        ? [{ name: 'git-known-hosts', mountPath: knownHostsDir, readOnly: true }]
        : []),
    ],
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { memory: '128Mi' },
    },
    securityContext: { runAsUser: 0 },
  };

  const gitConfigEnv: V1EnvVar = {
    name: 'GIT_CONFIG_GLOBAL',
    value: `${vscodeDataDir}/.gitconfig`,
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: ideDeploymentName(project),
      namespace: ns,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name,
          uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          [LABELS.projectName]: name,
          'percussionist.dev/component': 'code-server',
        },
      },
      template: {
        metadata: {
          labels,
        },
        spec: {
          initContainers: [initContainer],
          containers: [
            {
              name: 'code-server',
              image,
              securityContext: { runAsUser: 0 },
              args: [
                '--config',
                `${configDir}/config.yaml`,
                '--user-data-dir',
                vscodeDataDir,
                // Last positional arg is the folder code-server opens: the
                // human folder when enabled, otherwise the PVC mount root.
                humanDir ?? mountPath,
              ],
              env: [gitConfigEnv],
              ports: [
                {
                  containerPort: CODE_SERVER_PORT,
                  name: 'http',
                  protocol: 'TCP',
                },
              ],
              resources,
              volumeMounts: [
                {
                  name: 'data',
                  mountPath,
                },
              ],
              // Readiness probe to ensure code-server is up before routing traffic
              readinessProbe: {
                httpGet: {
                  path: '/healthz',
                  port: CODE_SERVER_PORT,
                },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            },
          ],
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: {
                claimName: pvcName,
              },
            },
            // git-ssh: deploy key for the human-folder clone (init container
            // only — the main code-server container never sees the key).
            ...(humanFolderEnabled && sshSecret
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
            ...(humanFolderEnabled && sshSecret && verifyHostKeys
              ? knownHostsSecret
                ? [
                    {
                      name: 'git-known-hosts',
                      secret: {
                        secretName: knownHostsSecret.name,
                        items: [
                          { key: knownHostsSecret.key ?? 'known_hosts', path: 'known_hosts' },
                        ],
                      },
                    },
                  ]
                : [
                    // No known_hostsSecret provided but verification requested —
                    // mount an empty directory so SSH has a readable parent for
                    // UserKnownHostsFile (same safety net as pod-builder).
                    { name: 'git-known-hosts', emptyDir: {} },
                  ]
              : []),
          ],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Ingress

export function ideIngressName(project: Project): string {
  return `ide-${project.metadata.name}`;
}

export function ideURLFor(project: Project, baseUrl: string = INGRESS_BASE_URL): string {
  const url = new URL(baseUrl);
  // Keep the base URL's scheme (https when the ingress is TLS-terminated) so
  // the surfaced link is actually reachable — a hardcoded http:// pointed at an
  // https-only ingress and produced a broken link (A15).
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://ide-${project.metadata.name}.${url.host}`;
}

/**
 * Renders an Ingress for code-server when INGRESS_BASE_URL is configured.
 */
export function renderIdeIngress(project: Project, baseUrl: string = INGRESS_BASE_URL): V1Ingress {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';
  const host = new URL(baseUrl).hostname;
  const csHost = `ide-${name}.${host}`;

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'code-server',
  };

  const ingress: V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ideIngressName(project),
      namespace: ns,
      labels,
      annotations: { ...INGRESS_ANNOTATIONS },
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name,
          uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      rules: [
        {
          host: csHost,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: ideServiceName(project),
                    port: { number: CODE_SERVER_PORT },
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

// ---------------------------------------------------------------------------
// Service

/**
 * Renders a ClusterIP Service for code-server.
 */
export function renderIdeService(project: Project): V1Service {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'code-server',
  };

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: ideServiceName(project),
      namespace: ns,
      labels,
      ownerReferences: [
        {
          apiVersion: API_GROUP_VERSION,
          kind: KIND_PROJECT,
          name,
          uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        [LABELS.projectName]: name,
        'percussionist.dev/component': 'code-server',
      },
      ports: [
        {
          port: CODE_SERVER_PORT,
          targetPort: CODE_SERVER_PORT,
          name: 'http',
          protocol: 'TCP',
        },
      ],
    },
  };
}
