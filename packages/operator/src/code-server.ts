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
} from '@percussionist/api';
import { INGRESS_ANNOTATIONS, INGRESS_BASE_URL, INGRESS_CLASS } from './config.js';

// ---------------------------------------------------------------------------
// Naming helpers

export function codeServerDeploymentName(project: Project): string {
  return `code-server-${project.metadata.name}`;
}

export function codeServerServiceName(project: Project): string {
  return `code-server-${project.metadata.name}`;
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
export function renderCodeServerDeployment(project: Project): V1Deployment {
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

  // Init container command: seed default config files to the PVC (first-run only).
  // Once the user customises any file via the editor, pod restarts preserve their changes
  // because the `[ -f ... ] ||` guard skips overwrite.
  const initScript = `
set -e
mkdir -p "${configDir}" "${vscodeDataDir}/User"

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
`;

  const initContainer: V1Container = {
    name: 'code-server-init',
    image,
    command: ['/bin/sh', '-c', initScript],
    volumeMounts: [{ name: 'data', mountPath }],
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { memory: '128Mi' },
    },
  };

  const gitConfigEnv: V1EnvVar = {
    name: 'GIT_CONFIG_GLOBAL',
    value: `${vscodeDataDir}/.gitconfig`,
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: codeServerDeploymentName(project),
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
          securityContext: {
            fsGroup: 1000,
          },
          initContainers: [initContainer],
          containers: [
            {
              name: 'code-server',
              image,
              args: [
                '--config',
                `${configDir}/config.yaml`,
                '--user-data-dir',
                vscodeDataDir,
                mountPath,
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
          ],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Ingress

export function codeServerIngressName(project: Project): string {
  return `code-server-${project.metadata.name}`;
}

export function codeServerURLFor(project: Project): string {
  const url = new URL(INGRESS_BASE_URL);
  return `http://code-server-${project.metadata.name}.${url.host}`;
}

/**
 * Renders an Ingress for code-server when INGRESS_BASE_URL is configured.
 */
export function renderCodeServerIngress(project: Project): V1Ingress {
  const name = project.metadata.name ?? '';
  const ns = project.metadata.namespace ?? '';
  const uid = project.metadata.uid ?? '';
  const host = new URL(INGRESS_BASE_URL).hostname;
  const csHost = `code-server-${name}.${host}`;

  const labels = {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.projectName]: name,
    'percussionist.dev/component': 'code-server',
  };

  const ingress: V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: codeServerIngressName(project),
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
                    name: codeServerServiceName(project),
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
export function renderCodeServerService(project: Project): V1Service {
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
      name: codeServerServiceName(project),
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
