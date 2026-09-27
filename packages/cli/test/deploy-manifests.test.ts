// deploy-manifests.test.ts — the substitutions `beatctl deploy` makes to
// k8s/deploy/operator.yaml and k8s/deploy/web.yaml before applying them.
//
// The real manifests are read from the repo rather than fixtured, so a change to
// their shape that breaks the regexes fails here instead of at deploy time on
// someone's cluster. Every case parses the patched output with the `yaml` parser
// and asserts on the resulting objects: string-inclusion assertions cannot see
// an indentation slip that silently moves an env entry or an Ingress rule out of
// its parent block.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import {
  patchedOperatorManifest,
  patchedPostgresManifest,
  patchedWebManifest,
} from '../src/deploy-manifests.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const OPERATOR = readFileSync(path.join(REPO_ROOT, 'k8s/deploy/operator.yaml'), 'utf8');
const WEB = readFileSync(path.join(REPO_ROOT, 'k8s/deploy/web.yaml'), 'utf8');
const POSTGRES = readFileSync(path.join(REPO_ROOT, 'k8s/deploy/postgres.yaml'), 'utf8');

/** The bundled database StatefulSet's first volumeClaimTemplates spec. */
function postgresClaimSpec(manifest: string): Record<string, unknown> {
  for (const doc of parseAllDocuments(manifest)) {
    const obj = doc.toJS() as {
      kind?: string;
      spec?: { volumeClaimTemplates?: Array<{ spec?: Record<string, unknown> }> };
    };
    if (obj?.kind === 'StatefulSet') {
      const template = obj.spec?.volumeClaimTemplates?.[0];
      if (!template) throw new Error('StatefulSet has no volumeClaimTemplates');
      return template.spec ?? {};
    }
  }
  throw new Error('no StatefulSet in the database manifest');
}

interface EnvEntry {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

/** Parse a multi-doc manifest, asserting it is valid YAML, and return the docs. */
function parseDocs(yaml: string): any[] {
  const docs = parseAllDocuments(yaml);
  const errors = docs.flatMap((d) => d.errors.map((e) => e.message));
  expect(errors).toEqual([]);
  return docs.map((d) => d.toJS());
}

function containerEnv(yaml: string, component: string): EnvEntry[] {
  const dep = parseDocs(yaml).find(
    (d) =>
      d?.kind === 'Deployment' &&
      d?.metadata?.labels?.['app.kubernetes.io/component'] === component,
  );
  expect(dep, `no ${component} Deployment found`).toBeDefined();
  return dep.spec.template.spec.containers[0].env as EnvEntry[];
}

function envValue(env: EnvEntry[], name: string): string | undefined {
  return env.find((e) => e.name === name)?.value;
}

function ingressSpec(yaml: string): any {
  const ing = parseDocs(yaml).find((d) => d?.kind === 'Ingress');
  expect(ing).toBeDefined();
  return ing.spec;
}

describe('patchedOperatorManifest — against the checked-in manifest', () => {
  it('substitutes base URL, storage class and ingress class', () => {
    const env = containerEnv(
      patchedOperatorManifest(OPERATOR, {
        baseUrl: 'https://10.0.0.5.nip.io:30443',
        storageClass: 'microk8s-hostpath',
        ingressClass: 'public',
      }),
      'operator',
    );

    expect(envValue(env, 'PERCUSSIONIST_INGRESS_BASE_URL')).toBe('https://10.0.0.5.nip.io:30443');
    expect(envValue(env, 'DEFAULT_STORAGE_CLASS')).toBe('microk8s-hostpath');
    expect(envValue(env, 'PERCUSSIONIST_INGRESS_CLASS')).toBe('public');
  });

  it('inserts PERCUSSIONIST_INGRESS_TLS_SECRET without disturbing the env list', () => {
    const env = containerEnv(
      patchedOperatorManifest(OPERATOR, {
        baseUrl: 'https://192.168.49.2.nip.io',
        ingressClass: 'traefik',
        tlsSecret: 'percussionist-tls-wildcard',
      }),
      'operator',
    );

    expect(envValue(env, 'PERCUSSIONIST_INGRESS_TLS_SECRET')).toBe('percussionist-tls-wildcard');
    // The anchor entry and the entries after it must survive the insertion.
    expect(envValue(env, 'PERCUSSIONIST_INGRESS_CLASS')).toBe('traefik');
    expect(env.find((e) => e.name === 'PERCUSSIONIST_SELF_NAMESPACE')?.valueFrom).toBeDefined();
    expect(env.find((e) => e.name === 'WEB_AUTH_TOKEN')?.valueFrom).toBeDefined();
  });

  it('is idempotent — re-patching replaces the TLS entry in place', () => {
    const once = patchedOperatorManifest(OPERATOR, { tlsSecret: 'first' });
    const twice = patchedOperatorManifest(once, { tlsSecret: 'second' });
    const env = containerEnv(twice, 'operator');

    expect(env.filter((e) => e.name === 'PERCUSSIONIST_INGRESS_TLS_SECRET')).toHaveLength(1);
    expect(envValue(env, 'PERCUSSIONIST_INGRESS_TLS_SECRET')).toBe('second');
  });

  it('leaves the manifest untouched when nothing is requested', () => {
    expect(patchedOperatorManifest(OPERATOR, {})).toBe(OPERATOR);
  });

  it('warns and applies unmodified when a name is absent (no throw)', () => {
    const out = patchedOperatorManifest('kind: Deployment\n', { storageClass: 'longhorn' });
    expect(out).toBe('kind: Deployment\n');
  });
});

describe('patchedWebManifest — against the checked-in manifest', () => {
  it('substitutes host, ingress class and WEB_BASE_URL', () => {
    const out = patchedWebManifest(WEB, {
      host: 'app.pcs.example.com',
      ingressClass: 'public',
      webBaseUrl: 'http://app.pcs.example.com',
    });
    const spec = ingressSpec(out);

    expect(spec.ingressClassName).toBe('public');
    expect(spec.rules[0].host).toBe('app.pcs.example.com');
    // Patching the host must not lift the rule out of `spec.rules`.
    expect(spec.rules[0].http.paths[0].backend.service.name).toBe('percussionist-web');
    expect(spec.tls).toBeUndefined();
    expect(envValue(containerEnv(out, 'web'), 'WEB_BASE_URL')).toBe('http://app.pcs.example.com');
  });

  it('keeps WEB_BASE_URL and the Ingress host on the same origin (checkDashboard)', () => {
    const out = patchedWebManifest(WEB, {
      host: 'app.10.0.0.5.nip.io',
      webBaseUrl: 'https://app.10.0.0.5.nip.io',
      tlsSecret: 'percussionist-tls-wildcard',
    });
    const webBaseUrl = envValue(containerEnv(out, 'web'), 'WEB_BASE_URL') ?? '';

    expect(new URL(webBaseUrl).hostname).toBe(ingressSpec(out).rules[0].host);
  });

  it('adds a spec.tls block for the requested secret', () => {
    const spec = ingressSpec(
      patchedWebManifest(WEB, {
        host: 'app.192.168.49.2.nip.io',
        tlsSecret: 'percussionist-tls-wildcard',
      }),
    );

    expect(spec.tls).toEqual([
      { hosts: ['app.192.168.49.2.nip.io'], secretName: 'percussionist-tls-wildcard' },
    ]);
  });

  it('falls back to the manifest host when only a TLS secret is given', () => {
    const spec = ingressSpec(patchedWebManifest(WEB, { tlsSecret: 'wildcard' }));

    expect(spec.tls).toEqual([{ hosts: [spec.rules[0].host], secretName: 'wildcard' }]);
  });

  it('is idempotent — re-patching keeps a single spec.tls block', () => {
    const once = patchedWebManifest(WEB, { host: 'app.a.test', tlsSecret: 'first' });
    const spec = ingressSpec(patchedWebManifest(once, { host: 'app.b.test', tlsSecret: 'second' }));

    expect(spec.tls).toEqual([{ hosts: ['app.b.test'], secretName: 'second' }]);
    expect(spec.rules[0].host).toBe('app.b.test');
    expect(spec.rules[0].http.paths[0].path).toBe('/');
  });

  it('leaves the manifest untouched when nothing is requested', () => {
    expect(patchedWebManifest(WEB, {})).toBe(WEB);
  });
});

// ---------------------------------------------------------------------------
// postgres.yaml — the StorageClass override
//
// `--database-storage-class` has to land in the manifest, not in a
// `kubectl patch`: spec.volumeClaimTemplates is immutable, so a patch is
// rejected by the API server on every existing StatefulSet.

describe('patchedPostgresManifest', () => {
  it('ships without a storageClassName so the cluster default applies', () => {
    expect(postgresClaimSpec(POSTGRES).storageClassName).toBeUndefined();
  });

  it('sets the requested class on the claim template', () => {
    const spec = postgresClaimSpec(patchedPostgresManifest(POSTGRES, { storageClass: 'longhorn' }));
    expect(spec.storageClassName).toBe('longhorn');
  });

  it('is idempotent — re-patching replaces rather than duplicating', () => {
    const once = patchedPostgresManifest(POSTGRES, { storageClass: 'longhorn' });
    const twice = patchedPostgresManifest(once, { storageClass: 'ceph' });
    const spec = postgresClaimSpec(twice);
    expect(spec.storageClassName).toBe('ceph');
    expect(twice.match(/storageClassName/g)).toHaveLength(1);
  });

  it('leaves the manifest untouched when no class is requested', () => {
    expect(patchedPostgresManifest(POSTGRES, {})).toBe(POSTGRES);
    expect(patchedPostgresManifest(POSTGRES, { storageClass: '  ' })).toBe(POSTGRES);
  });

  it('keeps the Service document intact alongside the patched StatefulSet', () => {
    const docs = parseAllDocuments(patchedPostgresManifest(POSTGRES, { storageClass: 'longhorn' }));
    const kinds = docs.map((d) => d.get('kind'));
    expect(kinds).toEqual(['Service', 'StatefulSet']);
    const service = docs.find((d) => d.get('kind') === 'Service');
    expect(service?.getIn(['spec', 'ports', 0, 'port'])).toBe(5432);
  });

  it('warns instead of silently no-oping when there is no claim template', () => {
    const noClaims = 'kind: StatefulSet\nmetadata:\n  name: x\nspec:\n  replicas: 1\n';
    expect(patchedPostgresManifest(noClaims, { storageClass: 'longhorn' })).toBe(noClaims);
  });
});
