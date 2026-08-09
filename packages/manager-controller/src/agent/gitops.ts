// agent/gitops.ts — Flux source detection and version pinning.
//
// When the control plane is installed via k8s/flux/percussionist.yaml, the
// deployed version is a property of one field: `.spec.ref.tag` on the
// `percussionist` OCIRepository. Upgrading means changing that field and
// asking Flux to reconcile; Flux then applies CRDs first (its Kustomization
// declares `dependsOn` + `wait`) and rolls the Deployments after.
//
// That ordering is the reason this path exists. The direct-patch fallback in
// apply_upgrade can only reach Deployments — the manager has no RBAC for
// customresourcedefinitions, and deliberately so, since that verb includes
// delete and deleting a CRD cascades every Project, Run and Task in the
// cluster. So a direct-patch upgrade rolls new controllers against whatever
// schema is already installed, and any field the new version writes that the
// old schema does not know about is silently pruned by the API server.
//
// Handing the CRD apply to kustomize-controller keeps that privilege where it
// belongs and leaves the manager needing only `patch` on two Flux resources.

import { setHeaderOptions } from '@kubernetes/client-node';
import { custom } from '@percussionist/kube';

export const FLUX_NAMESPACE = process.env.PERCUSSIONIST_FLUX_NAMESPACE ?? 'flux-system';
export const FLUX_SOURCE_NAME = process.env.PERCUSSIONIST_FLUX_SOURCE ?? 'percussionist';

const SOURCE_GROUP = 'source.toolkit.fluxcd.io';
const SOURCE_VERSION = 'v1';
const SOURCE_PLURAL = 'ocirepositories';

const KUSTOMIZE_GROUP = 'kustomize.toolkit.fluxcd.io';
const KUSTOMIZE_VERSION = 'v1';
const KUSTOMIZE_PLURAL = 'kustomizations';

// Kustomizations driven by the OCIRepository, in the order k8s/flux applies
// them. Annotating both is what turns a tag change into an immediate rollout
// instead of one that waits out the reconcile interval.
export const KUSTOMIZATION_NAMES = ['percussionist-crds', 'percussionist'];

/** Structural subset of CustomObjectsApi — lets tests pass a fake. */
export interface CustomObjectClient {
  getNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
  patchNamespacedCustomObject(
    args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
      body: unknown;
    },
    options?: unknown,
  ): Promise<unknown>;
}

export interface FluxSource {
  namespace: string;
  name: string;
  /** Currently pinned tag, or null when the source tracks a semver range. */
  tag: string | null;
  url: string;
  /** True when `.spec.ref.semver` is set — unattended upgrades are enabled. */
  semverRange: string | null;
  suspended: boolean;
}

interface OciRepository {
  spec?: {
    url?: string;
    suspend?: boolean;
    ref?: { tag?: string; semver?: string };
  };
}

// A merge patch is the right strategy here: `.spec.ref` is a plain object, so
// there is no list-merge ambiguity, and it leaves every other field alone.
const MERGE_PATCH = () => setHeaderOptions('Content-Type', 'application/merge-patch+json');

/**
 * Look for the Flux OCIRepository that drives this install.
 *
 * Returns null when Flux is not installed, the CRD is absent, or the source
 * simply does not exist — all three mean "not a GitOps install", and all three
 * surface as request failures rather than something worth distinguishing.
 */
export async function detectFluxSource(
  client: CustomObjectClient = custom(),
  namespace: string = FLUX_NAMESPACE,
  name: string = FLUX_SOURCE_NAME,
): Promise<FluxSource | null> {
  try {
    const obj = (await client.getNamespacedCustomObject({
      group: SOURCE_GROUP,
      version: SOURCE_VERSION,
      namespace,
      plural: SOURCE_PLURAL,
      name,
    })) as OciRepository;

    return {
      namespace,
      name,
      tag: obj.spec?.ref?.tag ?? null,
      url: obj.spec?.url ?? '',
      semverRange: obj.spec?.ref?.semver ?? null,
      suspended: obj.spec?.suspend === true,
    };
  } catch {
    return null;
  }
}

/**
 * Pin the source to `targetTag`.
 *
 * Clears `.spec.ref.semver` at the same time: the two are mutually exclusive
 * in Flux, and a leftover range would keep overriding the pin on the next
 * reconcile — an upgrade that silently reverts is worse than one that fails.
 */
export async function pinFluxSourceTag(
  source: FluxSource,
  targetTag: string,
  client: CustomObjectClient = custom(),
): Promise<void> {
  await client.patchNamespacedCustomObject(
    {
      group: SOURCE_GROUP,
      version: SOURCE_VERSION,
      namespace: source.namespace,
      plural: SOURCE_PLURAL,
      name: source.name,
      body: { spec: { ref: { tag: targetTag, semver: null } } },
    },
    MERGE_PATCH(),
  );
}

/**
 * Ask Flux to reconcile now rather than at the next interval, by bumping the
 * annotation its controllers watch for.
 *
 * Best-effort by design: the tag is already pinned by the time this runs, so a
 * failure here delays the rollout to the next interval instead of losing it.
 * Returns the names that could not be annotated.
 */
export async function requestReconcile(
  source: FluxSource,
  now: string,
  client: CustomObjectClient = custom(),
): Promise<string[]> {
  const failed: string[] = [];

  const annotate = async (
    group: string,
    version: string,
    plural: string,
    name: string,
  ): Promise<void> => {
    try {
      await client.patchNamespacedCustomObject(
        {
          group,
          version,
          namespace: source.namespace,
          plural,
          name,
          body: { metadata: { annotations: { 'reconcile.fluxcd.io/requestedAt': now } } },
        },
        MERGE_PATCH(),
      );
    } catch {
      failed.push(name);
    }
  };

  // Source first — the Kustomizations have nothing new to apply until the
  // artifact for the new tag has actually been pulled.
  await annotate(SOURCE_GROUP, SOURCE_VERSION, SOURCE_PLURAL, source.name);
  for (const name of KUSTOMIZATION_NAMES) {
    await annotate(KUSTOMIZE_GROUP, KUSTOMIZE_VERSION, KUSTOMIZE_PLURAL, name);
  }

  return failed;
}
