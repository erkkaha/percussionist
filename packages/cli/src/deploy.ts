// `beatctl deploy` — install/remove cluster-side percussionist resources.
//
// Unified deploy entrypoint for CRDs + operator + web + manager controller.
//
// TLS setup is platform-profile driven (see deploy-platform.ts). Traefik is the
// only supported ingress controller; the platform profile decides the TLS
// mechanism:
//   - microk8s:  the addon ships Traefik; the wildcard cert Secret is wired as
//                the controller's *default* certificate (via the documented
//                `microk8s enable ingress --default-ssl-certificate` mechanism).
//   - minikube:  the traefik addon is configured per-Ingress (web Ingress gets
//                `spec.tls`), so no controller default-cert wiring is needed.
//   - generic / --skip-tls: the whole TLS block is skipped; the deploy patches
//                with the http base URL and prints a "TLS not configured" note.
//
// A cluster whose only ingress controller is nginx is reported with an
// actionable Traefik-migration command — no nginx controller is ever patched,
// configured, or pinned.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeployPlatform, PlatformProfile, TraefikControllerInfo } from './deploy-platform.js';
import { baseUrl, detectTraefikController, resolvePlatform } from './deploy-platform.js';
import { ensurePlatformPrereqs } from './deploy-preflight.js';
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
// kubectl / external CLI helpers

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

/** Apply a YAML document piped on stdin. Throws on non-zero exit. */
function kubectlApplyYaml(yaml: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`kubectl apply exited with code ${code}`));
    });
    child.stdin.write(yaml);
    child.stdin.end();
  });
}

/** True when the `microk8s` CLI is reachable on PATH. */
function microk8sOnPath(): boolean {
  const r = spawnSync('sh', ['-c', 'command -v microk8s'], { stdio: 'ignore' });
  return (r.status ?? 1) === 0;
}

/** Run a `microk8s` subcommand. Never implicitly prefixes `sudo`. */
function runMicrok8s(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('microk8s', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`microk8s ${args.join(' ')} exited with code ${code}`));
    });
  });
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
// TLS setup (platform-profile driven; zero nginx code paths)

/** Resolved facts from one TLS setup pass. */
interface TlsResult {
  nodeIP: string;
  domain: string;
  baseUrl: string;
  secure: boolean;
}

/** Split a "<ns>/<name>" secret ref into parts (ns optional). */
function splitSecretRef(ref: string): { namespace: string; name: string } {
  const idx = ref.indexOf('/');
  if (idx === -1) return { namespace: '', name: ref };
  return { namespace: ref.slice(0, idx), name: ref.slice(idx + 1) };
}

/** Resolve the TLS Secret namespace/name for a profile + flags. */
function resolveTlsSecret(
  opts: DeployOpts,
  profile: PlatformProfile,
  ns: string,
): { namespace: string; name: string } {
  if (opts.tlsSecret) {
    const { namespace, name } = splitSecretRef(opts.tlsSecret);
    return { namespace: namespace || ns, name: name || 'percussionist-tls-wildcard' };
  }
  if (profile.tlsMechanism === 'addon-default-cert') {
    // microk8s: the controller reads the default cert from its own namespace.
    return { namespace: profile.ingressNamespace, name: 'percussionist-tls-wildcard' };
  }
  // per-ingress (minikube) / generic: secret lives in the deploy namespace
  // alongside the web Ingress that references it.
  return { namespace: ns, name: 'percussionist-tls-wildcard' };
}

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
function existingCertIsValid(secretNamespace: string, secretName: string): boolean {
  try {
    const b64 = kubectlOutput([
      'get',
      'secret',
      secretName,
      '-n',
      secretNamespace,
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

/** Generate a self-signed wildcard cert for *.<domain> in a temp dir. */
function generateCert(domain: string, dir: string): { cert: string; key: string } {
  const certPath = path.join(dir, 'tls.crt');
  const keyPath = path.join(dir, 'tls.key');

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
      `/CN=*.${domain}`,
      '-addext',
      `subjectAltName=DNS:*.${domain},DNS:${domain}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`openssl cert generation failed: ${(result.stderr ?? '').toString().trim()}`);
  }

  return { cert: certPath, key: keyPath };
}

/** Apply the TLS Secret to a namespace (idempotent). */
async function applyTlsSecret(
  secretNamespace: string,
  secretName: string,
  cert: string,
  key: string,
): Promise<void> {
  // Use --dry-run=client -o yaml | kubectl apply -f - for idempotency.
  return new Promise((resolve, reject) => {
    const create = spawn(
      'kubectl',
      [
        'create',
        'secret',
        'tls',
        secretName,
        '-n',
        secretNamespace,
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

/**
 * Pin the controller HTTPS Service NodePort to the requested target (default
 * 30443, the microk8s convention). Only meaningful when the Service type is
 * NodePort — LoadBalancer / hostPort topologies expose the in-cluster port
 * (80/443) and need no pinning.
 *
 * Returns true when a patch was actually applied (so the caller can wait for
 * the controller rollout).
 */
async function pinHttpsNodePort(
  profile: PlatformProfile,
  controller: TraefikControllerInfo,
  httpsPortOverride?: number,
): Promise<boolean> {
  if (!controller.found || controller.serviceType !== 'NodePort') {
    return false;
  }

  const ns = profile.ingressNamespace;
  const svc = profile.controllerService;
  const target = httpsPortOverride ?? 30443;

  const current = kubectlOutput([
    'get',
    'svc',
    svc,
    '-n',
    ns,
    '-o',
    "jsonpath={.spec.ports[?(@.name=='websecure' || @.name=='https')].nodePort}",
  ]);

  if (current === String(target)) {
    console.log(`beatctl: ${profile.name} HTTPS NodePort already pinned to ${target}`);
    return false;
  }

  console.log(
    `beatctl: pinning ${profile.name} HTTPS NodePort to ${target} (was ${current || 'unset'})`,
  );

  // Find the index of the https port entry in the ports array.
  const portsJson = kubectlOutput(['get', 'svc', svc, '-n', ns, '-o', 'jsonpath={.spec.ports}']);
  const ports = JSON.parse(portsJson) as Array<{ name: string }>;
  const httpsIdx = ports.findIndex((p) => p.name === 'websecure' || p.name === 'https');
  if (httpsIdx === -1) throw new Error(`could not find https port on ${ns}/${svc} Service`);

  await runKubectl([
    'patch',
    'svc',
    svc,
    '-n',
    ns,
    '--type=json',
    `-p=[{"op":"replace","path":"/spec/ports/${httpsIdx}/nodePort","value":${target}}]`,
  ]);
  return true;
}

/**
 * Wire the wildcard cert Secret as the controller's default certificate.
 * Dispatches on the profile's TLS mechanism:
 *   - microk8s (`addon-default-cert`): the documented `microk8s enable ingress
 *     --default-ssl-certificate <ns>/<secret>` when the CLI is present, else a
 *     best-effort Traefik TLSStore (see configureTraefikDefaultCertBestEffort).
 *   - minikube (`per-ingress`): no controller action — the web Ingress carries
 *     `spec.tls` and Traefik honors it.
 *   - generic / --skip-tls (`none`): nothing to do.
 */
async function configureDefaultCert(profile: PlatformProfile, secretRef: string): Promise<void> {
  if (profile.tlsMechanism === 'per-ingress') {
    return; // minikube: per-Ingress TLS covers it.
  }
  if (profile.tlsMechanism === 'none') {
    return; // generic / --skip-tls: no controller wiring.
  }

  // microk8s addon-default-cert
  if (microk8sOnPath()) {
    console.log(
      `beatctl: wiring default TLS cert via "microk8s enable ingress --default-ssl-certificate ${secretRef}"`,
    );
    await runMicrok8s(['enable', 'ingress', `--default-ssl-certificate=${secretRef}`]);
  } else {
    await configureTraefikDefaultCertBestEffort(secretRef);
  }
}

/**
 * Best-effort default-cert wiring when the `microk8s` CLI is absent (e.g. the
 * LXD-VM topology). Applies a Traefik `TLSStore` named `default` in the
 * controller namespace, which is the controller-native way to set a cluster
 * default certificate without patching the Deployment.
 *
 * This path is intentionally best-effort: the exact flag/arg shape varies by
 * Traefik version and is verified live on a real cluster. Any failure degrades
 * to a clear warning that tells the user the exact command to run.
 */
async function configureTraefikDefaultCertBestEffort(secretRef: string): Promise<void> {
  const { namespace, name } = splitSecretRef(secretRef);
  const tlsStore = [
    'apiVersion: traefik.io/v1alpha1',
    'kind: TLSStore',
    'metadata:',
    '  name: default',
    `  namespace: ${namespace}`,
    'spec:',
    '  defaultCertificate:',
    `    secretName: ${name}`,
  ].join('\n');

  try {
    console.log('beatctl: wiring default TLS cert via Traefik TLSStore (best-effort)...');
    await kubectlApplyYaml(tlsStore);
  } catch {
    console.warn(
      'beatctl: warning: could not configure the Traefik default certificate automatically.\n' +
        '  The wildcard cert Secret was installed; wire it manually, e.g.:\n' +
        `    microk8s enable ingress --default-ssl-certificate ${secretRef}\n` +
        '  (or apply a Traefik TLSStore referencing the secret).',
    );
  }
}

/**
 * Build the ingress base URL and the dashboard URL from resolved facts.
 *
 * Port selection:
 *   - NodePort services use the (possibly pinned) node ports.
 *   - LoadBalancer / hostPort services use the in-cluster ports.
 *   - `--http-port` / `--https-port` overrides win in both cases.
 *   - Standard ports (80/http, 443/https) are elided from the URL.
 */
function resolveIngressBaseUrl(
  profile: PlatformProfile,
  controller: TraefikControllerInfo,
  domain: string,
  opts: DeployOpts,
): { baseUrl: string; secure: boolean } {
  const secure = profile.tlsMechanism !== 'none' && !opts.skipTls;
  let httpPort = opts.httpPort ?? profile.httpPort;
  let httpsPort = opts.httpsPort ?? profile.httpsPort;

  if (controller.found) {
    if (controller.serviceType === 'NodePort') {
      if (controller.httpsNodePort) httpsPort = opts.httpsPort ?? controller.httpsNodePort;
      if (controller.httpNodePort) httpPort = opts.httpPort ?? controller.httpNodePort;
    } else {
      if (controller.httpsPort) httpsPort = opts.httpsPort ?? controller.httpsPort;
      if (controller.httpPort) httpPort = opts.httpPort ?? controller.httpPort;
    }
  }

  return {
    baseUrl: baseUrl(profile, domain, httpPort, httpsPort, secure),
    secure,
  };
}

/**
 * Full TLS setup for a Traefik-shaped platform:
 *   - detect node IP
 *   - generate cert (skip if existing cert is still valid) with SAN *.<domain>
 *   - apply the Secret
 *   - configure the controller default cert (profile dispatch)
 *   - pin the HTTPS NodePort when the Service is NodePort
 *   - wait for the controller rollout (microk8s addon path)
 *
 * Returns the resolved base URL facts so the caller can patch manifests and
 * print the dashboard URL.
 */
async function setupTls(
  profile: PlatformProfile,
  controller: TraefikControllerInfo,
  opts: DeployOpts,
  ns: string,
): Promise<TlsResult> {
  console.log('beatctl: detecting node IP...');
  const ip = detectNodeIP();
  console.log(`beatctl: node IP: ${ip}`);

  const domain = opts.domain ?? profile.defaultDomain(ip);
  const secret = resolveTlsSecret(opts, profile, ns);
  const secretRef = `${secret.namespace}/${secret.name}`;

  if (existingCertIsValid(secret.namespace, secret.name)) {
    console.log('beatctl: existing TLS cert is still valid (30+ days), skipping generation');
  } else {
    console.log(`beatctl: generating self-signed wildcard cert for *.${domain}...`);
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'percussionist-tls-'));
    try {
      const { cert, key } = generateCert(domain, tmpDir);
      console.log(`beatctl: applying TLS Secret to ${secret.namespace} namespace...`);
      await applyTlsSecret(secret.namespace, secret.name, cert, key);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }

  await configureDefaultCert(profile, secretRef);

  const pinned = await pinHttpsNodePort(profile, controller, opts.httpsPort);

  if (profile.tlsMechanism === 'addon-default-cert' && (controller.found || pinned)) {
    console.log('beatctl: waiting for ingress controller rollout...');
    await runKubectl([
      'rollout',
      'status',
      `deploy/${profile.controllerDeployment}`,
      '-n',
      profile.ingressNamespace,
      '--timeout=90s',
    ]);
  }

  const { baseUrl: resolvedBaseUrl, secure } = resolveIngressBaseUrl(
    profile,
    controller,
    domain,
    opts,
  );
  return { nodeIP: ip, domain, baseUrl: resolvedBaseUrl, secure };
}

/** Create a namespace if missing; ignore an already-exists error. */
async function ensureNamespace(ns: string): Promise<void> {
  try {
    kubectlOutput(['get', 'namespace', ns, '-o', 'name']);
    return; // already exists
  } catch {
    /* create it */
  }
  console.log(`beatctl: creating namespace ${ns}...`);
  await runKubectl(['create', 'namespace', ns]);
}

// ---------------------------------------------------------------------------
// Ingress-backend mismatch (the "no nginx support" boundary)

/**
 * Detect a *running* nginx ingress controller by scanning deployment names
 * across all namespaces for "nginx". We key on the running Deployment rather
 * than the IngressClass: MicroK8s 1.35+ Traefik ships a legacy `nginx`
 * IngressClass (no deployment) alongside Traefik, so a class-based check would
 * falsely flag a healthy Traefik install.
 *
 * Only the bare "nginx" token is used (the hyphenated ingress namespace name is
 * deliberately never written here), and nothing here ever patches, configures,
 * or pins the controller — a hit only drives an actionable migration error.
 */
async function detectNginxController(): Promise<boolean> {
  try {
    const raw = kubectlOutput(['get', 'deploy', '-A', '-o', 'jsonpath={.items[*].metadata.name}']);
    return raw
      .split(/\s+/)
      .some((n) => n.toLowerCase().includes('nginx') && !n.toLowerCase().includes('traefik'));
  } catch {
    return false;
  }
}

/** The migration command shown when an nginx controller is detected. */
function nginxFailCommand(profile: PlatformProfile): string {
  switch (profile.name) {
    case 'minikube':
      return 'minikube addons disable ingress && minikube addons enable traefik';
    case 'microk8s':
      return 'upgrade MicroK8s to >= 1.35, then: microk8s enable ingress (ships Traefik)';
    default:
      return 'beatctl deploy --platform generic --skip-tls --ingress-class nginx --domain <host>';
  }
}

/**
 * Fail (actionable error) if an nginx controller is present while we are about
 * to configure TLS. nginx is only permitted for an explicit HTTP-only install
 * (`--skip-tls` / generic), which opts out of TLS entirely.
 */
async function assertTraefikBackend(profile: PlatformProfile, opts: DeployOpts): Promise<void> {
  if (opts.skipTls || profile.tlsMechanism === 'none') return; // nginx allowed for HTTP-only

  if (await detectNginxController()) {
    const cmd = nginxFailCommand(profile);
    fatal(
      'ingress backend mismatch',
      new Error(
        'detected an nginx ingress controller, but beatctl deploy only supports Traefik.\n\n' +
          'Migrate to Traefik:\n' +
          `  ${cmd}\n\n` +
          'Or run an HTTP-only install:\n' +
          '  beatctl deploy --platform generic --skip-tls --ingress-class <name> --domain <host>',
      ),
    );
  }
}

/** Best-effort TLS Secret removal on teardown (addons are never disabled). */
async function deleteTlsSecretOnTeardown(
  profile: PlatformProfile,
  opts: DeployOpts,
  ns: string,
): Promise<void> {
  const secret = resolveTlsSecret(opts, profile, ns);
  if (!secret.namespace) return;
  try {
    await runKubectl([
      'delete',
      'secret',
      secret.name,
      '-n',
      secret.namespace,
      '--ignore-not-found',
    ]);
  } catch {
    /* best-effort */
  }
}

/** Build the dashboard URL (`app.<domain>`) from the ingress base URL. */
function dashboardUrl(base: string, domain: string): string {
  if (!domain) return `${base}/`;
  try {
    const u = new URL(base);
    u.hostname = `app.${domain}`;
    return `${u.toString().replace(/\/$/, '')}/`;
  } catch {
    return `${base}/`;
  }
}

// ---------------------------------------------------------------------------
// Operator manifest patching

/**
 * Read operator.yaml, substitute the PERCUSSIONIST_INGRESS_BASE_URL value with
 * the ingress base URL, write to a temp file and return its path. Caller is
 * responsible for deleting the temp file.
 *
 * The replacement matches the env name/value pair, so it is platform-agnostic
 * (nip.io, custom domains, with or without a NodePort suffix).
 */
function patchedOperatorManifest(operatorYaml: string, ingressBaseUrl: string): string {
  const original = readFileSync(operatorYaml, 'utf8');

  const patched = original.replace(
    /(name:\s+PERCUSSIONIST_INGRESS_BASE_URL\n\s+value:\s+)[^\n]*/,
    `$1${ingressBaseUrl}`,
  );

  if (patched === original) {
    console.warn(
      'beatctl: warning: could not patch PERCUSSIONIST_INGRESS_BASE_URL in operator.yaml ' +
        '— you may need to update it manually to: ' +
        ingressBaseUrl,
    );
    return operatorYaml; // apply unmodified
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
  ingressBaseUrl: string,
  version: string,
  wait: boolean,
): Promise<void> {
  const manifestPath = resolveManifest(repoRoot, 'k8s/flux/percussionist.yaml');
  const patched = patchFluxManifest(readFileSync(manifestPath, 'utf8'), {
    tag: tagFromVersion(version),
    ingressBaseUrl,
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

  // --- platform layer (task 1) ----------------------------------------------
  // Resolve the target platform and always print it. Auto-detection is advisory
  // only; `--platform` overrides. TLS + preflight wiring consumes it below.
  const profile = await resolvePlatform(opts.platform);
  const platformLabel =
    opts.platform && opts.platform !== 'auto'
      ? `${profile.name} (explicit)`
      : `${profile.name} (auto-detected)`;
  console.log(`beatctl: deploy platform: ${platformLabel}`);

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
      // Best-effort TLS Secret removal (addons are never disabled on teardown).
      await deleteTlsSecretOnTeardown(profile, opts, ns);
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

  // Ensure the deploy namespace exists before applying anything.
  await ensureNamespace(ns);

  // Preflight (task 3) — addons, RBAC, storage, Traefik presence per platform.
  // Runs before TLS setup so the Traefik controller is present when
  // detectTraefikController() probes it below (ports + IngressClass).
  try {
    await ensurePlatformPrereqs(profile);
  } catch (e) {
    fatal('platform preflight failed', e);
  }

  // --- TLS setup (profile-driven; zero nginx paths) -------------------------
  const controller = await detectTraefikController(profile);
  await assertTraefikBackend(profile, opts);

  const tlsEnabled = !opts.skipTls && profile.tlsMechanism !== 'none';
  let tls: TlsResult | null = null;
  if (!tlsEnabled) {
    console.log('beatctl: TLS not configured (--skip-tls or generic platform)');
  } else {
    try {
      tls = await setupTls(profile, controller, opts, ns);
    } catch (e) {
      fatal('TLS setup failed', e);
    }
  }

  // Resolve the dashboard domain + ingress base URL from detected facts.
  const nodeIP =
    tls?.nodeIP ??
    (() => {
      try {
        return detectNodeIP();
      } catch {
        return '';
      }
    })();
  const domain = opts.domain ?? (nodeIP ? profile.defaultDomain(nodeIP) : '');
  const ingressBaseUrl =
    tls?.baseUrl ?? resolveIngressBaseUrl(profile, controller, domain, opts).baseUrl;
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
      await applyGitopsBootstrap(repoRoot, ingressBaseUrl, version, opts.wait !== false);
    } catch (e) {
      fatal('GitOps deploy failed', e);
    }

    console.log('beatctl: deploy complete (GitOps)');
    console.log('');
    console.log('================================================================');
    console.log(`  Dashboard:  ${dashboardUrl(ingressBaseUrl, domain)}`);
    console.log('  Note: accept the self-signed cert on first visit');
    console.log('');
    console.log('  Upgrades now include CRDs. Use the dashboard Settings page,');
    console.log('  or pin a version directly:');
    console.log('    kubectl -n flux-system patch ocirepository percussionist \\');
    console.log('      --type=merge -p \'{"spec":{"ref":{"tag":"vX.Y.Z"}}}\'');
    console.log('================================================================');
    return;
  }

  // Write a patched copy of operator.yaml with the correct ingress base URL.
  const patchedOperator = patchedOperatorManifest(manifests.operator, ingressBaseUrl);
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
    console.log(`  Dashboard:  ${dashboardUrl(ingressBaseUrl, domain)}`);
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
