// k8s-clients.ts — lazy builder for the K8s API clients `beatctl doctor` needs.
//
// The CLI's other commands get by with the shared core/apps/custom clients
// from @percussionist/kube, but the doctor command also audits CRDs, RBAC,
// NetworkPolicy and StorageClass resources. All clients are built lazily on
// first use from the same KubeConfig and node-http transport that
// `kubeConfig()` / `makeNodeApiClient` already set up.

import {
  ApiextensionsV1Api,
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  StorageV1Api,
} from '@kubernetes/client-node';
import { kubeConfig, makeNodeApiClient } from '@percussionist/kube';

export interface DoctorClients {
  core: CoreV1Api;
  apps: AppsV1Api;
  custom: CustomObjectsApi;
  apiextensions: ApiextensionsV1Api;
  rbac: RbacAuthorizationV1Api;
  networking: NetworkingV1Api;
  storage: StorageV1Api;
}

let cached: DoctorClients | undefined;

/**
 * Build the seven doctor API clients from a single KubeConfig. Pure — split
 * out from doctorClients() so tests can drive it with an in-memory kubeconfig
 * instead of the ambient one.
 */
export function buildDoctorClients(kc: ReturnType<typeof kubeConfig>): DoctorClients {
  return {
    core: makeNodeApiClient(kc, CoreV1Api),
    apps: makeNodeApiClient(kc, AppsV1Api),
    custom: makeNodeApiClient(kc, CustomObjectsApi),
    apiextensions: makeNodeApiClient(kc, ApiextensionsV1Api),
    rbac: makeNodeApiClient(kc, RbacAuthorizationV1Api),
    networking: makeNodeApiClient(kc, NetworkingV1Api),
    storage: makeNodeApiClient(kc, StorageV1Api),
  };
}

/**
 * Build (once) and return the K8s API clients the doctor command uses.
 * Construction only parses the kubeconfig — it never touches the network —
 * so a throw here means no cluster is configured at all (fatal, exit 2).
 */
export function doctorClients(): DoctorClients {
  if (cached) return cached;
  cached = buildDoctorClients(kubeConfig());
  return cached;
}
