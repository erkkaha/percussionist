// `beatctl deploy` — install/remove cluster-side percussionist resources.
//
// Unified deploy entrypoint for CRDs + operator + web + manager controller.
//
// TLS setup (always attempted):
//   1. Detect the cluster node's InternalIP.
//   2. Generate a self-signed wildcard cert for *.<ip>.nip.io using openssl.
//   3. Store it as Secret percussionist-tls-wildcard in ingress-nginx namespace.
//   4. Patch ingress-nginx-controller to use it as the default SSL certificate.
//   5. Pin the HTTPS NodePort to 30443.
//   6. Substitute https://<ip>.nip.io:30443 into the operator manifest before
//      applying so per-run webURLs are HTTPS from the start.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeployPlatform } from './deploy-platform.js';
import { resolvePlatform } from './deploy-platform.js';
import { patchFluxManifest, tagFromVersion } from './gitops-manifest.js';
import { DEFAULT_NAMESPACE, fatal } from './kube.js';

export interface DeployOpts {
  namespace?: string;
  repoRoot?: string;
  down?: boolean;
  wait?: boolean;
  /** Hand the control plane to Flux instead of applying manifests directly. */
  gitops?: boolean;
  /** Release tag to pin under --gitops (default: this checkout's version). */
  release?: string;
  // --- platform layer (task 1; consumed by TLS/preflight in tasks 2-3) ---
  /** Target platform; `auto` (default) detects from the live cluster. */
  platform?: DeployPlatform;
  /** Override the base domain (default: <node-ip>.nip.io). */
  domain?: string;
  /** Override the ingress HTTP port (NodePort pin target on microk8s). */
  httpPort?: number;
  /** Override the ingress HTTPS port (NodePort pin target on microk8s). */
  httpsPort?: number;
  /** Override DEFAULT_STORAGE_CLASS. */
  storageClass?: string;
  /** Override the IngressClass. */
  ingressClass?: string;
  /** Skip TLS setup entirely (implied by `--platform generic`). */
  skipTls?: boolean;
  /** TLS Secret name as <ns>/<name>. */
  tlsSecret?: string;
}

// ---------------------------------------------------------------------------
// kubectl helpers

function runKubectl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) {
        resolve();
        return;
      }
      reject(new Error(`kubectl ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/** Run kubectl and return stdout as a string. Throws on non-zero exit. */
function kubectlOutput(args: string[]): string {
  const result = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const msg = (result.stderr ?? '').trim() || `exit code ${String(result.status)}`;
    throw new Error(`kubectl ${args.join(' ')}: ${msg}`);
  }
  return (result.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// Repo root detection

function resolveManifest(repoRoot: string, rel: string): string {
  const full = path.resolve(repoRoot, rel);
  if (!existsSync(full)) throw new Error(`missing manifest: ${full}`);
  return full;
}

function looksLikeRepoRoot(dir: string): boolean {
  return (
    existsSync(path.join(dir, 'k8s', 'crds', 'run.yaml')) &&
    existsSync(path.join(dir, 'k8s', 'deploy', 'operator.yaml'))
  );
}

function findRepoRoot(hint?: string): string {
  const candidates = [
    hint,
    process.env.PERCUSSIONIST_REPO_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter((v): v is string => Boolean(v));

  for (const c of candidates) {
    let dir = path.resolve(c);
    for (let i = 0; i < 6; i += 1) {
      if (looksLikeRepoRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error('could not locate repo root with k8s/crds and k8s/deploy (pass --repo-root)');
}

// ---------------------------------------------------------------------------
// TLS setup

/** Detect the first node's InternalIP — works on minikube, k3s, EKS, etc. */
function detectNodeIP(): string {
  const ip = kubectlOutput([
    'get',
    'nodes',
    '-o',
    "jsonpath={.items[0].status.addresses[?(@.type=='InternalIP')].address}",
  ]);
  if (!ip) throw new Error('could not detect node InternalIP from cluster');
  return ip;
}

/** Check whether the existing TLS secret cert is valid for at least 30 days. */
function existingCertIsValid(): boolean {
  try {
    const b64 = kubectlOutput([
      'get',
      'secret',
      'percussionist-tls-wildcard',
      '-n',
      'ingress-nginx',
      '-o',
      'jsonpath={.data.tls\\.crt}',
    ]);
    if (!b64) return false;
    const pem = Buffer.from(b64, 'base64').toString('utf8');
    // Write pem to a temp file and check expiry (30 days = 2592000 s).
    const tmp = path.join(tmpdir(), `percussionist-cert-check-${Date.now()}.pem`);
    writeFileSync(tmp, pem);
    try {
      const r = spawnSync('openssl', ['x509', '-noout', '-checkend', '2592000', '-in', tmp], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return (r.status ?? 1) === 0;
    } finally {
      try {
        rmSync(tmp);
      } catch {
        /* ignore */
      }
    }
  } catch {
    return false; // secret doesn't exist yet
  }
}

/** Generate a self-signed wildcard cert for *.<ip>.nip.io in a temp dir. */
function generateCert(ip: string, dir: string): { cert: string; key: string } {
  const certPath = path.join(dir, 'tls.crt');
  const keyPath = path.join(dir, 'tls.key');
  const domain = `*.${ip}.nip.io`;

  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '825',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      `/CN=${domain}`,
      '-addext',
      `subjectAltName=DNS:${domain},DNS:${ip}.nip.io`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`openssl cert generation failed: ${(result.stderr ?? '').toString().trim()}`);
  }

  return { cert: certPath, key: keyPath };
}

/** Apply the TLS Secret to the ingress-nginx namespace (idempotent). */
async function applyTlsSecret(cert: string, key: string): Promise<void> {
  // Use --dry-run=client -o yaml | kubectl apply -f - for idempotency.
  return new Promise((resolve, reject) => {
    const create = spawn(
      'kubectl',
      [
        'create',
        'secret',
        'tls',
        'percussionist-tls-wildcard',
        '-n',
        'ingress-nginx',
        `--cert=${cert}`,
        `--key=${key}`,
        '--dry-run=client',
        '-o',
        'yaml',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const apply = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    create.stdout.pipe(apply.stdin);

    create.on('error', reject);
    apply.on('error', reject);
    apply.on('exit', (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`kubectl apply tls secret exited with code ${code}`));
    });
  });
}

/** Patch ingress-nginx-controller to use our cert as the default SSL cert. */
async function patchIngressNginxDefaultCert(): Promise<void> {
  const flag = '--default-ssl-certificate=ingress-nginx/percussionist-tls-wildcard';

  // Read current args.
  let currentArgs: string[];
  try {
    const raw = kubectlOutput([
      'get',
      'deploy',
      'ingress-nginx-controller',
      '-n',
      'ingress-nginx',
      '-o',
      'jsonpath={.spec.template.spec.containers[0].args}',
    ]);
    currentArgs = JSON.parse(raw) as string[];
  } catch {
    throw new Error(
      'beatctl: ingress-nginx-controller not found\n' +
        '  Enable it first: minikube addons enable ingress',
    );
  }

  if (currentArgs.includes(flag)) {
    console.log('beatctl: ingress-nginx default SSL cert already configured');
    return;
  }

  await runKubectl([
    'patch',
    'deploy',
    'ingress-nginx-controller',
    '-n',
    'ingress-nginx',
    '--type=json',
    `-p=[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"${flag}"}]`,
  ]);
}

/** Pin the ingress-nginx HTTPS NodePort to 30443. */
async function pinHttpsNodePort(): Promise<void> {
  const current = kubectlOutput([
    'get',
    'svc',
    'ingress-nginx-controller',
    '-n',
    'ingress-nginx',
    '-o',
    "jsonpath={.spec.ports[?(@.name=='https')].nodePort}",
  ]);

  if (current === '30443') {
    console.log('beatctl: ingress-nginx HTTPS NodePort already pinned to 30443');
    return;
  }

  console.log(`beatctl: pinning ingress-nginx HTTPS NodePort to 30443 (was ${current || 'unset'})`);

  // Find the index of the https port entry in the ports array.
  const portsJson = kubectlOutput([
    'get',
    'svc',
    'ingress-nginx-controller',
    '-n',
    'ingress-nginx',
    '-o',
    'jsonpath={.spec.ports}',
  ]);
  const ports = JSON.parse(portsJson) as Array<{ name: string }>;
  const httpsIdx = ports.findIndex((p) => p.name === 'https');
  if (httpsIdx === -1)
    throw new Error('could not find https port on ingress-nginx-controller Service');

  await runKubectl([
    'patch',
    'svc',
    'ingress-nginx-controller',
    '-n',
    'ingress-nginx',
    '--type=json',
    `-p=[{"op":"replace","path":"/spec/ports/${httpsIdx}/nodePort","value":30443}]`,
  ]);
}

/**
 * Full TLS setup:
 *   - detect node IP
 *   - generate cert (skip if existing cert is still valid)
 *   - apply Secret
 *   - patch ingress-nginx default cert
 *   - pin HTTPS NodePort to 30443
 *   - wait for ingress-nginx rollout
 *
 * Returns the node IP so the caller can build the base URL.
 */
async function setupTls(): Promise<string> {
  console.log('beatctl: detecting node IP...');
  const ip = detectNodeIP();
  console.log(`beatctl: node IP: ${ip}`);

  if (existingCertIsValid()) {
    console.log('beatctl: existing TLS cert is still valid (30+ days), skipping generation');
  } else {
    console.log(`beatctl: generating self-signed wildcard cert for *.${ip}.nip.io...`);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'percussionist-tls-'));
    try {
      const { cert, key } = generateCert(ip, tmpDir);
      console.log('beatctl: applying TLS Secret to ingress-nginx namespace...');
      await applyTlsSecret(cert, key);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }

  await patchIngressNginxDefaultCert();
  await pinHttpsNodePort();

  console.log('beatctl: waiting for ingress-nginx rollout...');
  await runKubectl([
    'rollout',
    'status',
    'deploy/ingress-nginx-controller',
    '-n',
    'ingress-nginx',
    '--timeout=90s',
  ]);

  return ip;
}

// ---------------------------------------------------------------------------
// Operator manifest patching

/**
 * Read operator.yaml, substitute the PERCUSSIONIST_INGRESS_BASE_URL value
 * with https://<ip>.nip.io:30443, write to a temp file and return its path.
 * Caller is responsible for deleting the temp file.
 */
function patchedOperatorManifest(operatorYaml: string, ip: string): string {
  const original = readFileSync(operatorYaml, 'utf8');
  const httpsUrl = `https://${ip}.nip.io:30443`;

  // Replace the value line that sets PERCUSSIONIST_INGRESS_BASE_URL.
  // Matches any existing http:// or https:// value so re-runs are idempotent.
  const patched = original.replace(
    /^(\s+value:\s+)https?:\/\/[^\s]+nip\.io[^\n]*/m,
    `$1${httpsUrl}`,
  );

  if (patched === original) {
    // Regex didn't match — the manifest may use a different domain.
    // Fall back to a broader replace of whatever value follows the env var name.
    const fallback = original.replace(
      /(name:\s+PERCUSSIONIST_INGRESS_BASE_URL\n\s+value:\s+)[^\n]*/,
      `$1${httpsUrl}`,
    );
    if (fallback === original) {
      console.warn(
        'beatctl: warning: could not patch PERCUSSIONIST_INGRESS_BASE_URL in operator.yaml ' +
          '— you may need to update it manually to: ' +
          httpsUrl,
      );
      return operatorYaml; // apply unmodified
    }
    const tmp = path.join(tmpdir(), `percussionist-operator-${Date.now()}.yaml`);
    writeFileSync(tmp, fallback);
    return tmp;
  }

  const tmp = path.join(tmpdir(), `percussionist-operator-${Date.now()}.yaml`);
  writeFileSync(tmp, patched);
  return tmp;
}

// ---------------------------------------------------------------------------
// GitOps mode

/** The Flux CRD whose presence means kustomize-controller is installed. */
const FLUX_KUSTOMIZATION_CRD = 'kustomizations.kustomize.toolkit.fluxcd.io';

function fluxControllersPresent(): boolean {
  try {
    kubectlOutput(['get', 'crd', FLUX_KUSTOMIZATION_CRD, '-o', 'name']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the two Flux controllers this needs — source and kustomize.
 *
 * Deliberately not the full Flux suite: helm, notification, image-reflector
 * and image-automation are unused here, and image-automation in particular
 * wants write access to a git repo. Two controllers is the whole footprint.
 *
 * Requires the `flux` CLI. Rather than curl an install manifest from the
 * network on the user's behalf, this fails with the exact command to run —
 * installing a second control plane into someone's cluster should be their
 * explicit act.
 */
async function installFluxControllers(): Promise<void> {
  const probe = spawnSync('flux', ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    throw new Error(
      'flux CLI not found on PATH, and the Flux controllers are not installed in this cluster.\n' +
        '  Install the CLI (https://fluxcd.io/flux/installation/) and re-run, or install the\n' +
        '  controllers yourself:\n' +
        '    flux install --components=source-controller,kustomize-controller',
    );
  }

  console.log('beatctl: installing Flux source-controller and kustomize-controller...');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'flux',
      ['install', '--components=source-controller,kustomize-controller'],
      {
        stdio: 'inherit',
      },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      (code ?? 1) === 0 ? resolve() : reject(new Error(`flux install exited with code ${code}`)),
    );
  });
}

/** Read the version of this checkout, used as the default pin. */
function checkoutVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (!pkg.version) throw new Error('no version field in package.json');
  return pkg.version;
}

/**
 * Apply the Flux bootstrap: an OCIRepository pinned to one release tag, plus
 * the two Kustomizations that apply CRDs and then the control plane.
 *
 * After this, upgrades are a change to `.spec.ref.tag` — which is what the
 * dashboard's Upgrade button does once it sees the source exists.
 */
async function applyGitopsBootstrap(
  repoRoot: string,
  nodeIP: string,
  version: string,
  wait: boolean,
): Promise<void> {
  const manifestPath = resolveManifest(repoRoot, 'k8s/flux/percussionist.yaml');
  const patched = patchFluxManifest(readFileSync(manifestPath, 'utf8'), {
    tag: tagFromVersion(version),
    ingressBaseUrl: `https://${nodeIP}.nip.io:30443`,
  });

  const tmp = path.join(tmpdir(), `percussionist-flux-${Date.now()}.yaml`);
  writeFileSync(tmp, patched);
  try {
    console.log(`beatctl: pinning percussionist to ${tagFromVersion(version)}`);
    await runKubectl(['apply', '-f', tmp]);

    if (wait) {
      // The CRD Kustomization is waited on separately: it is the one whose
      // failure would otherwise show up later as fields silently vanishing
      // from Projects and Runs.
      console.log('beatctl: waiting for Flux to apply the CRDs...');
      await runKubectl([
        '-n',
        'flux-system',
        'wait',
        '--for=condition=Ready',
        'kustomization/percussionist-crds',
        '--timeout=300s',
      ]);
      console.log('beatctl: waiting for Flux to roll out the control plane...');
      await runKubectl([
        '-n',
        'flux-system',
        'wait',
        '--for=condition=Ready',
        'kustomization/percussionist',
        '--timeout=600s',
      ]);
    }
  } finally {
    try {
      rmSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove the Flux bootstrap.
 *
 * Runs before the rest of --down, and is not conditional on --gitops: tearing
 * down the Deployments while a Kustomization still points at them means Flux
 * re-applies everything within its reconcile interval, and the delete looks
 * like it silently failed.
 */
async function deleteGitopsBootstrap(): Promise<void> {
  if (!fluxControllersPresent()) return;

  const targets = [
    'kustomization/percussionist',
    'kustomization/percussionist-crds',
    'ocirepository/percussionist',
  ];
  let announced = false;
  for (const target of targets) {
    try {
      const found = kubectlOutput(['-n', 'flux-system', 'get', target, '-o', 'name']);
      if (!found) continue;
    } catch {
      continue; // not present
    }
    if (!announced) {
      console.log('beatctl: removing Flux bootstrap so it cannot re-apply what we delete...');
      announced = true;
    }
    await runKubectl(['-n', 'flux-system', 'delete', target, '--ignore-not-found']);
  }
}

// ---------------------------------------------------------------------------
// Main entry point

export async function runDeploy(opts: DeployOpts): Promise<void> {
  const ns = opts.namespace ?? DEFAULT_NAMESPACE;
  const repoRoot = findRepoRoot(opts.repoRoot);

  const manifests = {
    runCrd: resolveManifest(repoRoot, 'k8s/crds/run.yaml'),
    projectCrd: resolveManifest(repoRoot, 'k8s/crds/project.yaml'),
    taskCrd: resolveManifest(repoRoot, 'k8s/crds/task.yaml'),
    clusterAgentCrd: resolveManifest(repoRoot, 'k8s/crds/clusteragent.yaml'),
    clusterSettingsCrd: resolveManifest(repoRoot, 'k8s/crds/clustersettings.yaml'),
    operator: resolveManifest(repoRoot, 'k8s/deploy/operator.yaml'),
    // The manager mounts this ConfigMap (agent-skills volume) and reads
    // OPENCODE_CONFIG_CONTENT from it with optional: false, so it must be
    // applied before the manager Deployment or the pod hangs in
    // ContainerCreating with "configmap agent-config not found".
    agentConfig: resolveManifest(repoRoot, 'k8s/deploy/agent-config.yaml'),
    managerController: resolveManifest(repoRoot, 'k8s/deploy/manager-controller.yaml'),
    web: resolveManifest(repoRoot, 'k8s/deploy/web.yaml'),
    networkPolicy: resolveManifest(repoRoot, 'k8s/deploy/networkpolicy.yaml'),
  };

  if (opts.down) {
    try {
      await deleteGitopsBootstrap();
      console.log('beatctl: deleting web + operator + manager deployments/RBAC...');
      await runKubectl([
        'delete',
        '-f',
        manifests.networkPolicy,
        '--ignore-not-found',
        '--wait=false',
      ]);
      await runKubectl(['delete', '-f', manifests.web, '--ignore-not-found', '--wait=false']);
      await runKubectl([
        'delete',
        '-f',
        manifests.managerController,
        '--ignore-not-found',
        '--wait=false',
      ]);
      await runKubectl(['delete', '-f', manifests.operator, '--ignore-not-found', '--wait=false']);
      await runKubectl([
        'delete',
        '-f',
        manifests.agentConfig,
        '--ignore-not-found',
        '--wait=false',
      ]);

      console.log('beatctl: deleting CRDs...');
      await runKubectl([
        'delete',
        '-f',
        manifests.clusterAgentCrd,
        '--ignore-not-found',
        '--wait=false',
      ]);
      await runKubectl([
        'delete',
        '-f',
        manifests.clusterSettingsCrd,
        '--ignore-not-found',
        '--wait=false',
      ]);
      await runKubectl(['delete', '-f', manifests.taskCrd, '--ignore-not-found', '--wait=false']);
      await runKubectl([
        'delete',
        '-f',
        manifests.projectCrd,
        '--ignore-not-found',
        '--wait=false',
      ]);
      await runKubectl(['delete', '-f', manifests.runCrd, '--ignore-not-found', '--wait=false']);
      console.log('beatctl: deploy --down complete');
      return;
    } catch (e) {
      fatal('deploy --down failed', e);
    }
  }

  // --- platform layer (task 1) ----------------------------------------------
  // Resolve the target platform and always print it. Auto-detection is advisory
  // only; `--platform` overrides. TLS + preflight wiring is tasks 2-3, so for
  // this slice we only resolve + print and leave clear integration points.
  const profile = await resolvePlatform(opts.platform);
  const platformLabel =
    opts.platform && opts.platform !== 'auto'
      ? `${profile.name} (explicit)`
      : `${profile.name} (auto-detected)`;
  console.log(`beatctl: deploy platform: ${platformLabel}`);

  // Integration points for tasks 2-3 (left intentionally unwired in this slice):
  //   - preflight:  ensurePlatformPrereqs(profile)   // addons, RBAC, storage
  //   - controller: const ctrl = await detectTraefikController(profile);
  //                 // feeds port/URL + TLS decisions; fail on nginx mismatch
  //   - TLS setup:  profile-driven replacement of setupTls() below
  //   - URL build:  baseUrl(profile, domain, httpPort, httpsPort)
  // `baseUrl`, `platformProfile` and `detectTraefikController` are exported from
  // deploy-platform.ts so the next slices can use them directly.

  // TLS setup — always attempted; fails clearly if ingress-nginx is absent.
  // TODO(task 2): replace this with profile-driven TLS wiring.
  let nodeIP: string;
  try {
    nodeIP = await setupTls();
  } catch (e) {
    fatal('TLS setup failed', e);
  }

  const ingressBaseUrl = `https://${nodeIP}.nip.io:30443`;
  console.log(`beatctl: ingress base URL: ${ingressBaseUrl}`);

  // GitOps mode hands everything below to Flux: it applies the same CRDs and
  // manifests from the published artifact for the pinned tag, in the same
  // order, and keeps doing so. The direct path stays for installs that would
  // rather not run a second control plane.
  if (opts.gitops) {
    try {
      if (!fluxControllersPresent()) {
        await installFluxControllers();
      } else {
        console.log('beatctl: Flux controllers already installed');
      }

      const version = opts.release ?? checkoutVersion(repoRoot);
      await applyGitopsBootstrap(repoRoot, nodeIP, version, opts.wait !== false);
    } catch (e) {
      fatal('GitOps deploy failed', e);
    }

    console.log('beatctl: deploy complete (GitOps)');
    console.log('');
    console.log('================================================================');
    console.log(`  Dashboard:  https://app.${nodeIP}.nip.io:30443/`);
    console.log(`  Runs:       https://<run-name>.${nodeIP}.nip.io:30443/`);
    console.log('  Note: accept the self-signed cert on first visit');
    console.log('');
    console.log('  Upgrades now include CRDs. Use the dashboard Settings page,');
    console.log('  or pin a version directly:');
    console.log('    kubectl -n flux-system patch ocirepository percussionist \\');
    console.log('      --type=merge -p \'{"spec":{"ref":{"tag":"vX.Y.Z"}}}\'');
    console.log('================================================================');
    return;
  }

  // Write a patched copy of operator.yaml with the correct HTTPS base URL.
  const patchedOperator = patchedOperatorManifest(manifests.operator, nodeIP);
  const operatorIsTemp = patchedOperator !== manifests.operator;

  try {
    console.log('beatctl: applying CRDs...');
    await runKubectl(['apply', '-f', manifests.runCrd]);
    await runKubectl(['apply', '-f', manifests.projectCrd]);
    await runKubectl(['apply', '-f', manifests.taskCrd]);
    await runKubectl(['apply', '-f', manifests.clusterAgentCrd]);
    await runKubectl(['apply', '-f', manifests.clusterSettingsCrd]);

    console.log('beatctl: waiting for CRDs to establish...');
    await runKubectl([
      'wait',
      '--for=condition=Established',
      'crd/runs.percussionist.dev',
      '--timeout=30s',
    ]);
    await runKubectl([
      'wait',
      '--for=condition=Established',
      'crd/projects.percussionist.dev',
      '--timeout=30s',
    ]);
    await runKubectl([
      'wait',
      '--for=condition=Established',
      'crd/tasks.percussionist.dev',
      '--timeout=30s',
    ]);
    await runKubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusteragents.percussionist.dev',
      '--timeout=30s',
    ]);

    console.log('beatctl: applying operator, manager controller and web manifests...');
    await runKubectl(['apply', '-f', patchedOperator]);
    await runKubectl(['apply', '-f', manifests.agentConfig]);
    await runKubectl(['apply', '-f', manifests.managerController]);
    await runKubectl(['apply', '-f', manifests.web]);
    await runKubectl(['apply', '-f', manifests.networkPolicy]);

    if (opts.wait !== false) {
      console.log(`beatctl: waiting for rollouts in namespace ${ns}...`);
      await runKubectl([
        '-n',
        ns,
        'rollout',
        'status',
        'deploy/percussionist-operator',
        '--timeout=120s',
      ]);
      await runKubectl([
        '-n',
        ns,
        'rollout',
        'status',
        'deploy/percussionist-manager',
        '--timeout=120s',
      ]);
      await runKubectl([
        '-n',
        ns,
        'rollout',
        'status',
        'deploy/percussionist-web',
        '--timeout=120s',
      ]);
    }

    console.log('beatctl: deploy complete');
    console.log('');
    console.log('================================================================');
    console.log(`  Dashboard:  https://app.${nodeIP}.nip.io:30443/`);
    console.log(`  Runs:       https://<run-name>.${nodeIP}.nip.io:30443/`);
    console.log('  Note: accept the self-signed cert on first visit');
    console.log('================================================================');
  } finally {
    if (operatorIsTemp) {
      try {
        rmSync(patchedOperator);
      } catch {
        /* ignore */
      }
    }
  }
}
