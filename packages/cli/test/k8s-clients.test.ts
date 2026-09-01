// k8s-clients.test.ts — doctorClients() and its pure builder (C24).
//
// Every doctor test injects stub clients; this file is the one place the real
// construction runs: buildDoctorClients turns a single KubeConfig into the
// seven API clients the doctor audits, and doctorClients() builds them once and
// caches the result. Construction only parses the kubeconfig (no network), so a
// minimal in-memory kubeconfig drives it deterministically in CI.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ApiextensionsV1Api,
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  StorageV1Api,
} from '@kubernetes/client-node';
import { buildDoctorClients, doctorClients } from '../src/k8s-clients.ts';

const FAKE_KUBECONFIG = `
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://127.0.0.1:6443
  name: test-cluster
contexts:
- context:
    cluster: test-cluster
    user: test-user
  name: test-context
current-context: test-context
users:
- name: test-user
  user:
    token: test-token
`;

/** Each doctor client is the generated class for its resource area. */
const CLIENT_CLASSES: Array<
  [keyof ReturnType<typeof buildDoctorClients>, new (...args: never[]) => object]
> = [
  ['core', CoreV1Api],
  ['apps', AppsV1Api],
  ['custom', CustomObjectsApi],
  ['apiextensions', ApiextensionsV1Api],
  ['rbac', RbacAuthorizationV1Api],
  ['networking', NetworkingV1Api],
  ['storage', StorageV1Api],
];

/** A representative method that only exists on the correct generated class. */
const CLIENT_METHOD: Record<string, string> = {
  core: 'readNamespacedPod',
  apps: 'readNamespacedDeployment',
  custom: 'getNamespacedCustomObject',
  apiextensions: 'readCustomResourceDefinition',
  rbac: 'readNamespacedRole',
  networking: 'readNamespacedIngress',
  storage: 'readStorageClass',
};

function expectCompleteClientSet(clients: ReturnType<typeof buildDoctorClients>) {
  expect(Object.keys(clients).sort()).toEqual(
    ['apiextensions', 'apps', 'core', 'custom', 'networking', 'rbac', 'storage'].sort(),
  );
  for (const [key, cls] of CLIENT_CLASSES) {
    const client = clients[key];
    expect(client).toBeInstanceOf(cls);
    // The client is the real generated API — verify a class-specific method.
    const method = CLIENT_METHOD[key] ?? '';
    expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe('function');
  }
}

describe('buildDoctorClients', () => {
  it('builds all seven doctor API clients from one KubeConfig', () => {
    const kc = new KubeConfig();
    kc.loadFromString(FAKE_KUBECONFIG);
    expectCompleteClientSet(buildDoctorClients(kc));
  });

  it('returns a fresh client set per call (caching lives in doctorClients, not the builder)', () => {
    const kc = new KubeConfig();
    kc.loadFromString(FAKE_KUBECONFIG);
    const first = buildDoctorClients(kc);
    const second = buildDoctorClients(kc);
    expectCompleteClientSet(first);
    expectCompleteClientSet(second);
    expect(second).not.toBe(first);
    expect(second.core).not.toBe(first.core);
  });

  it('throws when the KubeConfig has no active cluster', () => {
    const kc = new KubeConfig();
    expect(() => buildDoctorClients(kc)).toThrow('No active cluster');
  });
});

describe('doctorClients', () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalHost: string | undefined;
  let originalPort: string | undefined;

  beforeAll(() => {
    originalHome = process.env.HOME;
    originalHost = process.env.KUBERNETES_SERVICE_HOST;
    originalPort = process.env.KUBERNETES_SERVICE_PORT;
    homeDir = mkdtempSync(path.join(tmpdir(), 'k8s-clients-test-'));
    // Force the shared kube client to load our fake kubeconfig instead of the
    // in-cluster service account for this process.
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_PORT;
    process.env.HOME = homeDir;
    const dotKube = path.join(homeDir, '.kube');
    mkdirSync(dotKube, { recursive: true });
    writeFileSync(path.join(dotKube, 'config'), FAKE_KUBECONFIG);
  });

  afterAll(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalHost !== undefined) process.env.KUBERNETES_SERVICE_HOST = originalHost;
    else delete process.env.KUBERNETES_SERVICE_HOST;
    if (originalPort !== undefined) process.env.KUBERNETES_SERVICE_PORT = originalPort;
    else delete process.env.KUBERNETES_SERVICE_PORT;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns the seven real clients from the ambient kubeconfig', () => {
    expectCompleteClientSet(doctorClients());
  });

  it('caches the built client set across calls (no per-command rebuild)', () => {
    const first = doctorClients();
    const second = doctorClients();
    expect(second).toBe(first);
    expect(second.core).toBe(first.core);
    expect(second.storage).toBe(first.storage);
  });
});
