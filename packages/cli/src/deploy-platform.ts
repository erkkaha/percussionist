// `beatctl deploy` — platform layer.
//
// Profiles + auto-detection for the native MicroK8s / minikube (Traefik-only)
// deploy. This is the foundational module that the TLS/ingress (task 2),
// preflight (task 3) and manifest-patching (task 4) slices consume.
//
// No nginx code paths live here or anywhere in the deploy: a cluster whose only
// ingress controller is nginx is reported by the caller (task 2-3) with an
// actionable Traefik-migration command. This module only ever reasons about the
// Traefik controller.

import { spawnSync } from 'node:child_process';

export type DeployPlatform = 'auto' | 'minikube' | 'microk8s' | 'generic';

/** Concrete (non-`auto`) platform identifier. */
export type ResolvedPlatform = Exclude<DeployPlatform, 'auto'>;

export type TlsMechanism = 'addon-default-cert' | 'per-ingress' | 'none';

/**
 * A platform profile captures every fact `beatctl deploy` needs to drive TLS,
 * manifest patching, port/URL building and preflight for one target topology.
 * All controller names are `traefik` — Traefik is the only supported ingress.
 */
export interface PlatformProfile {
  name: ResolvedPlatform;
  ingressNamespace: string;
  controllerDeployment: 'traefik';
  controllerService: 'traefik';
  ingressClass: string;
  storageClass: string;
  /** Default HTTP port (overridden by live Service detection on microk8s). */
  httpPort: number;
  /** Default HTTPS port (overridden by live Service detection on microk8s). */
  httpsPort: number;
  /** Builds the wildcard domain from a node IP, e.g. `1.2.3.4.nip.io`. */
  defaultDomain(ip: string): string;
  tlsMechanism: TlsMechanism;
  /** Human-facing addon-enable command for preflight hints. */
  addonEnableHint: string;
}

/**
 * Resolved facts about the Traefik controller in the profile's namespace.
 * `detectTraefikController` populates this; the caller (tasks 2-3) uses it to
 * pick ports, build the dashboard URL, and to decide whether the cluster is
 * Traefik-shaped at all (vs an nginx-only cluster that must error out).
 */
export interface TraefikControllerInfo {
  found: boolean;
  serviceType?: 'NodePort' | 'LoadBalancer' | 'ClusterIP';
  httpNodePort?: number;
  httpsNodePort?: number;
  /** In-cluster Service port (LoadBalancer/hostPort use these). */
  httpPort?: number;
  httpsPort?: number;
  ingressClassExists: boolean;
}

// ---------------------------------------------------------------------------
// kubectl helper (local copy — deploy.ts owns the canonical one; keeping this
// module dependency-free avoids a deploy.ts <-> deploy-platform.ts import cycle).

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
// Profiles

/**
 * Return the concrete profile for a resolved platform. `auto` is not a valid
 * argument — call `resolvePlatform()` first to turn `auto` into a profile.
 */
export function platformProfile(platform: ResolvedPlatform): PlatformProfile {
  switch (platform) {
    case 'minikube':
      return {
        name: 'minikube',
        ingressNamespace: 'kube-system',
        controllerDeployment: 'traefik',
        controllerService: 'traefik',
        ingressClass: 'traefik',
        storageClass: 'standard',
        httpPort: 80,
        httpsPort: 443,
        defaultDomain: (ip) => `${ip}.nip.io`,
        tlsMechanism: 'per-ingress',
        addonEnableHint: 'minikube addons enable traefik',
      };
    case 'microk8s':
      return {
        name: 'microk8s',
        ingressNamespace: 'ingress',
        controllerDeployment: 'traefik',
        controllerService: 'traefik',
        // `public` is MicroK8s 1.35+'s documented default Traefik IngressClass
        // (backward compatible with the old NGINX routing). `traefik` and the
        // legacy `nginx` class also exist on the addon.
        ingressClass: 'public',
        storageClass: 'microk8s-hostpath',
        // HTTP/HTTPS ports are detected at deploy time from the Service.
        httpPort: 80,
        httpsPort: 443,
        defaultDomain: (ip) => `${ip}.nip.io`,
        tlsMechanism: 'addon-default-cert',
        addonEnableHint: 'microk8s enable dns rbac hostpath-storage ingress',
      };
    case 'generic':
      return {
        name: 'generic',
        ingressNamespace: '',
        controllerDeployment: 'traefik',
        controllerService: 'traefik',
        ingressClass: '',
        storageClass: '',
        httpPort: 80,
        httpsPort: 443,
        defaultDomain: (ip) => `${ip}.nip.io`,
        tlsMechanism: 'none',
        addonEnableHint: '',
      };
  }
}

// ---------------------------------------------------------------------------
// URL building

/**
 * Build the ingress base URL from resolved facts.
 *
 * - `secure` defaults to `profile.tlsMechanism !== 'none'` (https unless the
 *   platform opts out of TLS).
 * - Standard ports (80/http, 443/https) are elided from the URL; non-standard
 *   ports (e.g. a pinned microk8s NodePort 30443) are rendered as a suffix.
 *
 * This is what makes `auto` on minikube+traefik emit `https://<ip>.nip.io`
 * (no `:30443` suffix) while microk8s NodePort installs keep the port.
 */
export function baseUrl(
  profile: PlatformProfile,
  domain: string,
  httpPort: number = profile.httpPort,
  httpsPort: number = profile.httpsPort,
  secure: boolean = profile.tlsMechanism !== 'none',
): string {
  if (secure) {
    const portSuffix = httpsPort !== 443 ? `:${httpsPort}` : '';
    return `https://${domain}${portSuffix}`;
  }
  const portSuffix = httpPort !== 80 ? `:${httpPort}` : '';
  return `http://${domain}${portSuffix}`;
}

// ---------------------------------------------------------------------------
// Auto-detection

/**
 * Resolve the deploy platform.
 *
 * Detection order (advisory only — `--platform` always overrides and the
 * resolved value is always printed by the caller; detection never gates
 * destructive actions):
 *   1. kubeconfig current-context name: contains `microk8s` → microk8s,
 *      `minikube` → minikube (authoritative even before addons are enabled).
 *   2. cluster probes: `microk8s-hostpath` StorageClass exists, or a node has
 *      the `node.kubernetes.io/microk8s-controlplane` label → microk8s; node
 *      names start with `minikube` → minikube.
 *   3. else `generic`.
 *
 * Every probe is wrapped so a missing cluster / missing kubectl degrades
 * gracefully to `generic` instead of throwing.
 */
export async function resolvePlatform(explicit: DeployPlatform = 'auto'): Promise<PlatformProfile> {
  if (explicit !== 'auto') {
    return platformProfile(explicit);
  }

  // 1. kubeconfig context name.
  try {
    const ctx = kubectlOutput(['config', 'current-context']).toLowerCase();
    if (ctx.includes('microk8s')) return platformProfile('microk8s');
    if (ctx.includes('minikube')) return platformProfile('minikube');
  } catch {
    /* no current-context; fall through to probes */
  }

  // 2a. microk8s-hostpath StorageClass exists.
  try {
    kubectlOutput(['get', 'storageclass', 'microk8s-hostpath', '-o', 'name']);
    return platformProfile('microk8s');
  } catch {
    /* not microk8s storage */
  }

  // 2b. a node carries the microk8s control-plane label.
  try {
    const labeled = kubectlOutput([
      'get',
      'nodes',
      '-l',
      'node.kubernetes.io/microk8s-controlplane',
      '-o',
      'name',
    ]);
    if (labeled) return platformProfile('microk8s');
  } catch {
    /* no labeled node */
  }

  // 2c. node names start with `minikube`.
  try {
    const names = kubectlOutput(['get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}']);
    if (names.split(/\s+/).some((n) => n.startsWith('minikube'))) {
      return platformProfile('minikube');
    }
  } catch {
    /* no nodes / unreachable */
  }

  // 3. give up on auto-detection.
  return platformProfile('generic');
}

// ---------------------------------------------------------------------------
// Traefik controller probe

/**
 * Probe the profile's namespace for the `traefik` Deployment + Service, read the
 * Service type and (Node)Ports, and confirm the IngressClass exists.
 *
 * Returns `found: false` for the `generic` profile (no namespace to probe) or
 * when no Traefik controller is present. The caller (tasks 2-3) uses this to:
 *   - pick the real HTTP/HTTPS ports for the dashboard URL,
 *   - drive the TLS mechanism (per-ingress vs addon-default-cert),
 *   - detect a nginx-only cluster (found=false while a known nginx controller
 *     exists elsewhere) and fail with the migration command.
 */
export async function detectTraefikController(
  profile: PlatformProfile,
): Promise<TraefikControllerInfo> {
  const info: TraefikControllerInfo = { found: false, ingressClassExists: false };
  const ns = profile.ingressNamespace;
  if (!ns) return info; // generic: nothing to probe

  // IngressClass presence.
  try {
    kubectlOutput(['get', 'ingressclass', profile.ingressClass, '-o', 'name']);
    info.ingressClassExists = true;
  } catch {
    info.ingressClassExists = false;
  }

  // Deployment presence.
  let hasDeployment = false;
  try {
    kubectlOutput(['get', 'deploy', profile.controllerDeployment, '-n', ns, '-o', 'name']);
    hasDeployment = true;
  } catch {
    hasDeployment = false;
  }

  // Service presence + type/ports.
  let svcRaw = '';
  try {
    svcRaw = kubectlOutput(['get', 'svc', profile.controllerService, '-n', ns, '-o', 'json']);
  } catch {
    svcRaw = '';
  }

  if (hasDeployment && svcRaw) {
    info.found = true;
    try {
      const svc = JSON.parse(svcRaw) as {
        spec?: {
          type?: string;
          ports?: Array<{ name?: string; port?: number; nodePort?: number }>;
        };
      };
      const type = svc.spec?.type;
      if (type === 'NodePort' || type === 'LoadBalancer' || type === 'ClusterIP') {
        info.serviceType = type;
      }
      for (const p of svc.spec?.ports ?? []) {
        const name = p.name ?? '';
        if (name === 'web' || name === 'http') {
          info.httpPort = p.port;
          info.httpNodePort = p.nodePort;
        } else if (name === 'websecure' || name === 'https') {
          info.httpsPort = p.port;
          info.httpsNodePort = p.nodePort;
        }
      }
    } catch {
      /* leave ports unset if the Service JSON is unparsable */
    }
  }

  return info;
}
