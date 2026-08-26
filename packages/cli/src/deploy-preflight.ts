// `beatctl deploy` — platform preflight (task 3).
//
// Verifies / enables the platform-specific prerequisites before TLS setup:
//   - microk8s: addons (dns rbac hostpath-storage ingress); or, when the
//     `microk8s` CLI is absent (LXD-VM topology), verify the effects via
//     kubectl and fail with the exact enable command to run on the host.
//   - minikube: `minikube addons enable traefik`, after disabling the legacy
//     nginx `ingress` addon (they cannot coexist); or verify the running
//     controller when the CLI is absent.
//   - generic: no-op (no ingress/storage assumptions).
//
// Never shells out to `sudo microk8s` / `sudo minikube` implicitly. RBAC
// enablement is not externally verifiable — it is warned about best-effort,
// never silently skipped.
//
// This module is intentionally dependency-free except for `fatal` from kube.ts
// and the types from deploy-platform.ts, to avoid an import cycle with
// deploy.ts (which imports this module). Helper functions are duplicated from
// deploy.ts / deploy-platform.ts on purpose for that reason.

import { spawn, spawnSync } from 'node:child_process';
import type { PlatformProfile } from './deploy-platform.js';
import { fatal } from './kube.js';

// ---------------------------------------------------------------------------
// Local external-CLI helpers (mirrors deploy.ts / deploy-platform.ts; keeps
// this module free of a deploy.ts <-> deploy-preflight.ts import cycle).

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

/** True when the `microk8s` CLI is reachable on PATH (never implicitly sudo'd). */
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

/** True when the `minikube` CLI is reachable on PATH (never implicitly sudo'd). */
function minikubeOnPath(): boolean {
  const r = spawnSync('sh', ['-c', 'command -v minikube'], { stdio: 'ignore' });
  return (r.status ?? 1) === 0;
}

/** Run a `minikube` subcommand. Never implicitly prefixes `sudo`. */
function runMinikube(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('minikube', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`minikube ${args.join(' ')} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// microk8s

/** True when CoreDNS is deployed and its Deployment reports Available. */
function corednsAvailable(): boolean {
  try {
    const status = kubectlOutput([
      '-n',
      'kube-system',
      'get',
      'deploy',
      'coredns',
      '-o',
      'jsonpath={.status.conditions[?(@.type=="Available")].status}',
    ]);
    return status.trim() === 'True';
  } catch {
    return false;
  }
}

/**
 * microk8s without the CLI on PATH (LXD-VM topology): verify the addon effects
 * via kubectl. RBAC enablement is not externally verifiable → warned
 * best-effort, never a silent skip. Anything else missing is a fatal error
 * carrying the exact `microk8s enable …` command to run on the host.
 */
async function verifyMicroK8sPrereqs(): Promise<void> {
  const missing: string[] = [];

  try {
    kubectlOutput(['get', 'storageclass', 'microk8s-hostpath', '-o', 'name']);
  } catch {
    missing.push('StorageClass "microk8s-hostpath" (hostpath-storage addon)');
  }

  try {
    kubectlOutput(['get', 'deploy', 'traefik', '-n', 'ingress', '-o', 'name']);
  } catch {
    missing.push('Deployment "traefik" in namespace "ingress" (ingress addon)');
  }

  if (!corednsAvailable()) {
    missing.push('CoreDNS not Available (dns addon)');
  }

  if (missing.length > 0) {
    fatal(
      'microk8s prerequisites missing',
      new Error(
        'The microk8s CLI is not on PATH (LXD-VM topology), so beatctl cannot enable\n' +
          'addons for you. On the host running MicroK8s, run exactly:\n\n' +
          '    microk8s enable dns rbac hostpath-storage ingress\n\n' +
          'Missing prerequisites:\n' +
          missing.map((m) => `  - ${m}`).join('\n'),
      ),
    );
  }

  // RBAC cannot be confirmed from inside the cluster — warn, never skip silently.
  console.warn(
    'beatctl: warning: RBAC enablement is not externally verifiable from inside the cluster.\n' +
      '  If RBAC is not enabled, Percussionist ServiceAccounts/RoleBindings are inert under\n' +
      '  the default AlwaysAllow mode. Enable it on the host if needed:\n' +
      '    microk8s enable rbac',
  );
}

/**
 * Ensure microk8s prerequisites.
 *   - CLI present: `microk8s status --wait-ready` →
 *     `microk8s enable dns rbac hostpath-storage ingress` →
 *     `microk8s status --wait-ready` (addons are idempotent).
 *   - CLI absent: verify effects via kubectl; fail with the host command.
 */
export async function ensureMicroK8sPrereqs(): Promise<void> {
  if (microk8sOnPath()) {
    console.log(
      'beatctl: microk8s CLI found — ensuring addons (dns rbac hostpath-storage ingress)...',
    );
    await runMicrok8s(['status', '--wait-ready']);
    await runMicrok8s(['enable', 'dns', 'rbac', 'hostpath-storage', 'ingress']);
    await runMicrok8s(['status', '--wait-ready']);
    return;
  }

  await verifyMicroK8sPrereqs();
}

// ---------------------------------------------------------------------------
// minikube

/** minikube without the CLI: verify the traefik controller + IngressClass. */
async function verifyMinikubePrereqs(): Promise<void> {
  const missing: string[] = [];

  try {
    kubectlOutput(['get', 'deploy', 'traefik', '-n', 'kube-system', '-o', 'name']);
  } catch {
    missing.push('Deployment "traefik" in namespace "kube-system"');
  }

  try {
    kubectlOutput(['get', 'ingressclass', 'traefik', '-o', 'name']);
  } catch {
    missing.push('IngressClass "traefik"');
  }

  if (missing.length > 0) {
    fatal(
      'minikube prerequisites missing',
      new Error(
        'The minikube CLI is not on PATH, so beatctl cannot enable addons for you.\n' +
          'On the host running minikube, run exactly:\n\n' +
          '    minikube addons disable ingress\n' +
          '    minikube addons enable traefik\n\n' +
          'Missing prerequisites:\n' +
          missing.map((m) => `  - ${m}`).join('\n'),
      ),
    );
  }
}

/**
 * Ensure minikube prerequisites: enable the traefik addon, first disabling the
 * legacy nginx `ingress` addon (they cannot coexist because both bind 80/443).
 * `disable ingress` is idempotent (a no-op when already disabled), so it is run
 * unconditionally and best-effort. With no CLI, verify the running controller
 * and fail with the host command.
 */
export async function ensureMinikubePrereqs(): Promise<void> {
  if (minikubeOnPath()) {
    // Best-effort: disable the legacy nginx "ingress" addon so traefik can bind
    // 80/443. Disabling an already-disabled addon is a no-op.
    try {
      console.log(
        'beatctl: disabling minikube nginx "ingress" addon (cannot coexist with traefik)...',
      );
      await runMinikube(['addons', 'disable', 'ingress']);
    } catch {
      /* best-effort; enable traefik below surfaces a real conflict if any */
    }
    console.log('beatctl: enabling minikube traefik addon...');
    await runMinikube(['addons', 'enable', 'traefik']);
    return;
  }

  await verifyMinikubePrereqs();
}

// ---------------------------------------------------------------------------
// generic

/**
 * Nothing to do for the generic platform: it makes no ingress / storage /
 * addon assumptions (the LXD + Tailscale topology, real clusters, etc.).
 */
export async function ensureGenericPrereqs(): Promise<void> {
  /* no-op */
}

// ---------------------------------------------------------------------------
// dispatch

/**
 * Run the platform preflight for the resolved profile. Called from `runDeploy()`
 * before TLS setup so the Traefik controller (and its ports / IngressClass) is
 * present when `detectTraefikController()` probes it afterwards.
 */
export async function ensurePlatformPrereqs(profile: PlatformProfile): Promise<void> {
  switch (profile.name) {
    case 'microk8s':
      await ensureMicroK8sPrereqs();
      break;
    case 'minikube':
      await ensureMinikubePrereqs();
      break;
    case 'generic':
      await ensureGenericPrereqs();
      break;
  }
}
