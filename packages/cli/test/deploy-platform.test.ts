// deploy-platform.test.ts — the platform layer in `beatctl deploy`.
//
// `resolvePlatform` (auto-detection) and `detectTraefikController` (Traefik probe)
// both take an injectable `runKubectl` argument (default: the real kubectl), so
// every detection branch is exercised here with stubbed probe output — no cluster
// required. The pure helpers (`platformProfile`, `baseUrl`, the decision-6 nginx
// predicates) need no injection at all.

import { describe, expect, it } from 'bun:test';
import {
  baseUrl,
  detectTraefikController,
  hasNginxController,
  nginxMigrationCommand,
  nginxMismatchError,
  platformProfile,
  resolvePlatform,
} from '../src/deploy-platform.js';

/** A fake kubectl: returns the mapped stdout for a known arg key, else throws. */
function fakeKubectl(map: Record<string, string>): (args: string[]) => string {
  return (args: string[]) => {
    const key = args.join(' ');
    const value = map[key];
    if (value === undefined) throw new Error(`kubectl ${key}: not found`);
    return value;
  };
}

describe('platformProfile — resolution (minikube/microk8s/generic)', () => {
  it('minikube: kube-system/traefik, class traefik, storageClass standard, per-ingress TLS', () => {
    const p = platformProfile('minikube');
    expect(p.name).toBe('minikube');
    expect(p.ingressNamespace).toBe('kube-system');
    expect(p.controllerDeployment).toBe('traefik');
    expect(p.controllerService).toBe('traefik');
    expect(p.ingressClass).toBe('traefik');
    expect(p.storageClass).toBe('standard');
    expect(p.tlsMechanism).toBe('per-ingress');
    expect(p.defaultDomain('1.2.3.4')).toBe('1.2.3.4.nip.io');
  });

  it('microk8s: ingress namespace, class public, storageClass microk8s-hostpath, addon-default-cert', () => {
    const p = platformProfile('microk8s');
    expect(p.name).toBe('microk8s');
    expect(p.ingressNamespace).toBe('ingress');
    expect(p.ingressClass).toBe('public');
    expect(p.storageClass).toBe('microk8s-hostpath');
    expect(p.tlsMechanism).toBe('addon-default-cert');
  });

  it('generic: no namespace/class/port assumptions and TLS none', () => {
    const p = platformProfile('generic');
    expect(p.name).toBe('generic');
    expect(p.ingressNamespace).toBe('');
    expect(p.ingressClass).toBe('');
    expect(p.storageClass).toBe('');
    expect(p.tlsMechanism).toBe('none');
  });
});

describe('baseUrl — domain / port / scheme handling', () => {
  it('minikube secure default elides the standard 443 port', () => {
    const p = platformProfile('minikube');
    expect(baseUrl(p, '1.2.3.4.nip.io')).toBe('https://1.2.3.4.nip.io');
  });

  it('minikube insecure renders http with no port suffix', () => {
    const p = platformProfile('minikube');
    expect(baseUrl(p, '1.2.3.4.nip.io', undefined, undefined, false)).toBe('http://1.2.3.4.nip.io');
  });

  it('non-standard HTTPS port is rendered as a suffix (microk8s NodePort pin)', () => {
    const p = platformProfile('microk8s');
    expect(baseUrl(p, '1.2.3.4.nip.io', undefined, 30443)).toBe('https://1.2.3.4.nip.io:30443');
  });

  it('non-standard HTTP port is rendered as a suffix', () => {
    const p = platformProfile('minikube');
    expect(baseUrl(p, 'h.example.com', 8080, 8443, false)).toBe('http://h.example.com:8080');
  });

  it('honours a custom domain', () => {
    const p = platformProfile('minikube');
    expect(baseUrl(p, 'pcs.example.com')).toBe('https://pcs.example.com');
  });

  it('generic profile (tlsMechanism none) defaults to plain http', () => {
    const p = platformProfile('generic');
    expect(baseUrl(p, '1.2.3.4.nip.io')).toBe('http://1.2.3.4.nip.io');
  });
});

describe('resolvePlatform — auto-detection', () => {
  it('context name containing microk8s wins (authoritative, no probes)', async () => {
    const kubectl = fakeKubectl({ 'config current-context': 'microk8s-vm' });
    expect((await resolvePlatform('auto', kubectl)).name).toBe('microk8s');
  });

  it('context name containing minikube wins', async () => {
    const kubectl = fakeKubectl({ 'config current-context': 'minikube' });
    expect((await resolvePlatform('auto', kubectl)).name).toBe('minikube');
  });

  it('StorageClass probe hit (microk8s-hostpath) resolves microk8s without a context', async () => {
    const kubectl = fakeKubectl({
      'get storageclass microk8s-hostpath -o name': 'storageclass.storage.k8s.io/microk8s-hostpath',
    });
    expect((await resolvePlatform('auto', kubectl)).name).toBe('microk8s');
  });

  it('node-label hit (microk8s-controlplane) resolves microk8s', async () => {
    const kubectl = fakeKubectl({
      'get nodes -l node.kubernetes.io/microk8s-controlplane -o name': 'node/minikube-vm',
    });
    expect((await resolvePlatform('auto', kubectl)).name).toBe('microk8s');
  });

  it('node-name starting with minikube* resolves minikube', async () => {
    const kubectl = fakeKubectl({
      'get nodes -o jsonpath={.items[*].metadata.name}': 'minikube minikube-m02',
    });
    expect((await resolvePlatform('auto', kubectl)).name).toBe('minikube');
  });

  it('falls back to generic when no probe matches', async () => {
    const kubectl = fakeKubectl({}); // every call throws → not found
    expect((await resolvePlatform('auto', kubectl)).name).toBe('generic');
  });

  it('explicit platform overrides detection entirely (no kubectl calls)', async () => {
    // A kubectl that would throw if called — resolves without invoking it.
    const kubectl = () => {
      throw new Error('kubectl should not be called for an explicit platform');
    };
    expect((await resolvePlatform('microk8s', kubectl)).name).toBe('microk8s');
    expect((await resolvePlatform('generic', kubectl)).name).toBe('generic');
  });
});

describe('detectTraefikController — stubbed probe output', () => {
  const nodePortSvc = JSON.stringify({
    spec: {
      type: 'NodePort',
      ports: [
        { name: 'web', port: 80, nodePort: 30080 },
        { name: 'websecure', port: 443, nodePort: 30443 },
      ],
    },
  });

  it('reports found + ports + ingress class when all probes succeed', async () => {
    const kubectl = fakeKubectl({
      'get ingressclass traefik -o name': 'ingressclass.traefik',
      'get deploy traefik -n kube-system -o name': 'deployment.apps/traefik',
      'get svc traefik -n kube-system -o json': nodePortSvc,
    });
    const info = await detectTraefikController(platformProfile('minikube'), kubectl);
    expect(info.found).toBe(true);
    expect(info.ingressClassExists).toBe(true);
    expect(info.serviceType).toBe('NodePort');
    expect(info.httpPort).toBe(80);
    expect(info.httpsPort).toBe(443);
    expect(info.httpNodePort).toBe(30080);
    expect(info.httpsNodePort).toBe(30443);
  });

  it('found is true even when the IngressClass is absent (deploy + svc present)', async () => {
    const kubectl = fakeKubectl({
      'get deploy traefik -n kube-system -o name': 'deployment.apps/traefik',
      'get svc traefik -n kube-system -o json': nodePortSvc,
    });
    const info = await detectTraefikController(platformProfile('minikube'), kubectl);
    expect(info.found).toBe(true);
    expect(info.ingressClassExists).toBe(false);
  });

  it('found is false when the Service is missing', async () => {
    const kubectl = fakeKubectl({
      'get ingressclass traefik -o name': 'ingressclass.traefik',
      'get deploy traefik -n kube-system -o name': 'deployment.apps/traefik',
    });
    const info = await detectTraefikController(platformProfile('minikube'), kubectl);
    expect(info.found).toBe(false);
  });

  it('generic profile probes nothing and returns found:false', async () => {
    const kubectl = () => {
      throw new Error('kubectl should not be called for the generic profile');
    };
    const info = await detectTraefikController(platformProfile('generic'), kubectl);
    expect(info.found).toBe(false);
    expect(info.ingressClassExists).toBe(false);
  });
});

describe('decision 6 — nginx mismatch (no nginx support)', () => {
  it('hasNginxController flags a running nginx deployment', () => {
    expect(hasNginxController(['ingress-nginx-controller'])).toBe(true);
    expect(hasNginxController(['nginx'])).toBe(true);
  });

  it('hasNginxController ignores Traefik-only installs and empty lists', () => {
    expect(hasNginxController(['traefik'])).toBe(false);
    expect(hasNginxController([])).toBe(false);
    // A name containing "nginx" but also "traefik" must not be flagged (legacy class).
    expect(hasNginxController(['traefik-nginx-legacy'])).toBe(false);
  });

  it('nginxMigrationCommand is platform-specific', () => {
    expect(nginxMigrationCommand(platformProfile('minikube'))).toBe(
      'minikube addons disable ingress && minikube addons enable traefik',
    );
    expect(nginxMigrationCommand(platformProfile('microk8s'))).toContain('microk8s enable ingress');
    expect(nginxMigrationCommand(platformProfile('generic'))).toBe(
      'beatctl deploy --platform generic --skip-tls --ingress-class nginx --domain <host>',
    );
  });

  it('nginxMismatchError carries the migration command and the HTTP-only escape hatch', () => {
    const msg = nginxMismatchError(platformProfile('minikube'));
    expect(msg).toContain('only supports Traefik');
    expect(msg).toContain('minikube addons disable ingress && minikube addons enable traefik');
    expect(msg).toContain('beatctl deploy --platform generic --skip-tls');
  });
});
