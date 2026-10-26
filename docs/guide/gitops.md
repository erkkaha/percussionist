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

### Crossing v0.3.0 (SQLite → PostgreSQL) {#crossing-v0-3-0}

v0.3.0 moved web and memory storage to PostgreSQL. An install that is on
v0.2.x under Flux needs three steps **before** the tag moves; the dashboard
Upgrade button does none of them, and the direct-patch path cannot cross this
release at all (it only swaps images, while the new web image needs
`DATABASE_URL` and a database to connect to — use `beatctl deploy` there).

1. **Create the `percussionist-db` Secret** (see
   [Installation → Database](/guide/installation#database)). The web
   Deployment and the bundled PostgreSQL StatefulSet both reference it with
   `optional: false`, so without it neither pod starts.

2. **Keep the old SQLite volume.** The `percussionist-web-db-v3` PVC was part
   of the v0.2.x manifests, so Flux owns it, and v0.3.0 dropped it — the first
   reconcile at the new tag prunes it, and with the usual `Delete` reclaim
   policy the volume goes with it. Annotating the PVC with
   `kustomize.toolkit.fluxcd.io/prune: disabled` does **not** help: Flux strips
   annotations it did not apply on its next reconcile, before the tag change
   lands. Retain the PersistentVolume instead, which Flux never touches:

   ```bash
   PV=$(kubectl -n percussionist get pvc percussionist-web-db-v3 -o jsonpath='{.spec.volumeName}')
   kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
   ```

   The PVC is still deleted; the PV is left `Released` with its data, ready to
   be bound by a new claim for copy-out. Per-project memory databases live on
   each project's data PVC (`/data/memory/vectors.db`) and are not affected.

3. **Switch the web Deployment to `Recreate` by hand.** v0.3.0 sets
   `strategy.type: Recreate` on it, but the live object still carries the
   defaulted `strategy.rollingUpdate` from v0.2.x. Flux uses server-side apply,
   which does not remove a field it never owned (`rollingUpdate: null` in the
   manifest does not help either), so the Kustomization fails its dry-run with
   `spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy
   type is 'Recreate'` and nothing at the new tag is applied:

   ```bash
   kubectl -n percussionist patch deploy percussionist-web --type=json -p \
     '[{"op":"remove","path":"/spec/strategy/rollingUpdate"},{"op":"replace","path":"/spec/strategy/type","value":"Recreate"}]'
   ```

   A plain `kubectl apply` (the direct `beatctl deploy` path) merges this
   change on its own and needs no patch.

Then upgrade as above. Expect the web and memory-service pods to restart a few
times with `ECONNREFUSED ... :5432` while PostgreSQL runs its first-boot
initialisation; they settle once it accepts connections. Stats, usage history,
dashboard logins and project memories start empty — there is no importer.

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
