// gitops-manifest.ts — fill the cluster-specific holes in the Flux bootstrap.
//
// k8s/flux/percussionist.yaml is checked in with working defaults so it can be
// applied by hand. `beatctl deploy --gitops` rewrites two of those defaults —
// the release tag and the ingress base URL — before applying it.
//
// Unlike the operator.yaml patching in deploy.ts, a failed substitution here
// throws rather than warning and applying the file unchanged. Both values are
// load-bearing: a stale tag installs the wrong release, and a wrong ingress URL
// hands out per-run URLs that do not resolve. Neither is worth guessing at.

export interface FluxManifestPatch {
  /** Release tag to pin the OCIRepository to, e.g. "v0.2.12". */
  tag?: string;
  /** Base URL the operator hands out for per-run ingress, e.g. "https://1.2.3.4.nip.io:30443". */
  ingressBaseUrl?: string;
  /** StorageClass override for DEFAULT_STORAGE_CLASS. */
  storageClass?: string;
  /** IngressClass override for PERCUSSIONIST_INGRESS_CLASS. */
  ingressClass?: string;
}

// Indented `tag:` — the only mapping key of that name in the file. Comment
// lines mentioning `tag:` start at column 0 behind a `#`, so they cannot match.
const TAG_RE = /^([ \t]+tag:[ \t]+)\S+/m;

// The env entries inside the Kustomization's strategic merge patch. Matched as
// name/value pairs so they cannot latch onto some other `value:` line.
const INGRESS_RE = /^([ \t]+- name: PERCUSSIONIST_INGRESS_BASE_URL\n[ \t]+value:[ \t]+)\S+/m;
const STORAGE_RE = /^([ \t]+- name: DEFAULT_STORAGE_CLASS\n[ \t]+value:[ \t]+)\S+/m;
const CLASS_RE = /^([ \t]+- name: PERCUSSIONIST_INGRESS_CLASS\n[ \t]+value:[ \t]+)\S+/m;

/**
 * Apply the requested substitutions to the bootstrap manifest.
 *
 * @throws if a requested substitution finds nothing to replace — that means the
 *         manifest drifted from what this function knows how to patch.
 */
export function patchFluxManifest(yaml: string, patch: FluxManifestPatch): string {
  let out = yaml;

  if (patch.tag !== undefined) {
    if (!TAG_RE.test(out)) {
      throw new Error('could not find an OCIRepository `tag:` line in k8s/flux/percussionist.yaml');
    }
    out = out.replace(TAG_RE, `$1${patch.tag}`);
  }

  if (patch.ingressBaseUrl !== undefined) {
    if (!INGRESS_RE.test(out)) {
      throw new Error(
        'could not find the PERCUSSIONIST_INGRESS_BASE_URL patch in k8s/flux/percussionist.yaml',
      );
    }
    out = out.replace(INGRESS_RE, `$1${patch.ingressBaseUrl}`);
  }

  if (patch.storageClass !== undefined) {
    if (!STORAGE_RE.test(out)) {
      throw new Error(
        'could not find the DEFAULT_STORAGE_CLASS patch in k8s/flux/percussionist.yaml',
      );
    }
    out = out.replace(STORAGE_RE, `$1${patch.storageClass}`);
  }

  if (patch.ingressClass !== undefined) {
    if (!CLASS_RE.test(out)) {
      throw new Error(
        'could not find the PERCUSSIONIST_INGRESS_CLASS patch in k8s/flux/percussionist.yaml',
      );
    }
    out = out.replace(CLASS_RE, `$1${patch.ingressClass}`);
  }

  return out;
}

/**
 * Read the version to pin from the repo's package.json version field.
 * Returns a v-prefixed tag, since that is how releases are tagged.
 */
export function tagFromVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
