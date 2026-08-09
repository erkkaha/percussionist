# GitOps upgrades (Flux)

Percussionist can hand its own control plane to [Flux](https://fluxcd.io). The
point is not continuous deployment — the version stays pinned until you change
it — but making "install this update" mean *all* of an update, CRDs included.

## Why

The dashboard's Upgrade button patches container images on the operator,
manager and web Deployments. It cannot touch CustomResourceDefinitions: the
manager has no RBAC for them, deliberately, because that permission includes
delete and deleting a CRD cascade-deletes every Project, Run and Task in the
cluster.

That gap is invisible until a release changes a schema. New controllers come up
against the old CRDs, and any field the new version writes that the old schema
does not declare is **pruned by the API server on write** — no error, a `200`
response, and the field simply is not there afterwards. CRD schemas do change
between releases; `spec.color` and `humanFolder` both arrived that way.

Under GitOps, kustomize-controller applies the CRDs and waits for them before
rolling the Deployments. The privilege to do that lives in Flux, where it
belongs, and the manager needs only `patch` on two resources in one namespace —
strictly less than it has today.

## What gets installed

Two Flux controllers, not the full suite:

| Controller | Why |
|---|---|
| `source-controller` | Pulls the manifests artifact from GHCR |
| `kustomize-controller` | Applies CRDs, then the control plane |

`helm-controller`, `notification-controller` and the image-automation
controllers are not installed. Image automation in particular wants write
access to a git repo, which is a much larger surface than this needs.

Manifests come from an OCI artifact published alongside the images on every
release:

```
oci://ghcr.io/erkkaha/percussionist/manifests:v0.2.12
```

It contains the same `k8s/` directory that ships in the repo, with one
difference: image references are rewritten from `:latest` to the release tag.
A working copy tracking `:latest` is convenient; a *deployed revision* that
does so is unidentifiable and can roll forward on any pod reschedule.

## Install

```bash
beatctl deploy --gitops
```

This does the usual TLS and ingress setup, installs the two controllers if they
are absent, and applies `k8s/flux/percussionist.yaml` with the release tag and
ingress URL filled in for your cluster.

Requires the [`flux` CLI](https://fluxcd.io/flux/installation/) if the
controllers are not already present. `beatctl` will not fetch and apply a
second control plane from the network on your behalf — if the CLI is missing it
prints the exact command to run instead.

To pin a specific release rather than the version of your checkout:

```bash
beatctl deploy --gitops --release v0.2.11
```

To apply it by hand, edit the tag and ingress URL in
`k8s/flux/percussionist.yaml` and `kubectl apply -f` it.

## Upgrading

Unchanged from before: Settings → Updates → **Upgrade** in the dashboard. The
panel states which mode is in effect, so it is clear whether CRDs are included.

The equivalent by hand:

```bash
kubectl -n flux-system patch ocirepository percussionist \
  --type=merge -p '{"spec":{"ref":{"tag":"v0.2.13"}}}'
flux reconcile source oci percussionist
```

Rollback is the same command with an earlier tag — which the direct-patch path
has no equivalent for, since it has no record of where it came from.

## Staying on demand

The OCIRepository pins an exact `tag:`. Flux still reconciles on its interval,
but with a fixed tag that reconciliation only repairs drift — someone hand-
editing a Deployment gets reverted; no new version arrives. Nothing upgrades
until the tag changes.

If you want unattended upgrades, replace `ref.tag` with a `ref.semver` range.
Note that an upgrade triggered from the dashboard pins the tag and clears the
range: the two are mutually exclusive in Flux, and leaving a range in place
would silently re-resolve over your pin on the next reconcile.

## Interaction with local development

Do not point this at a cluster you develop against. `scripts/minikube-load.sh`
deliberately shadows published tags with locally built `:dev` images, and a
reconciling Kustomization reverts exactly that, on its interval, silently.

If you need both, suspend reconciliation while you work:

```bash
flux suspend kustomization percussionist
# ... build, load, iterate ...
flux resume kustomization percussionist
```

## Uninstalling

```bash
beatctl deploy --down
```

The Flux bootstrap is removed first. This is not conditional on `--gitops`:
deleting the Deployments while a Kustomization still points at them means Flux
re-applies everything within its interval, and the teardown looks like it
silently failed.

CRDs are never pruned by Flux here (`prune: false` on that Kustomization), so
removing the bootstrap alone will not take your Projects and Runs with it.

## Not covered

Flux manages the control plane only. `Run`, `Task` and their pods, Services and
PVCs are created imperatively by the operator and are not in any Kustomization's
inventory, so pruning cannot reach them.
