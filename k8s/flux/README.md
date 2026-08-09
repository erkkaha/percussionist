# GitOps bootstrap

`percussionist.yaml` installs the control plane through Flux instead of
applying `k8s/deploy/` directly. The reason to want that is upgrades: the
in-place upgrade path patches container images only and cannot touch CRDs, so a
release that changes a schema leaves new controllers writing fields the API
server silently prunes.

Apply it with the tag and ingress URL filled in for your cluster:

```bash
beatctl deploy --gitops
```

or edit `ref.tag` and the `PERCUSSIONIST_INGRESS_BASE_URL` patch by hand and:

```bash
kubectl apply -f k8s/flux/percussionist.yaml
```

The tag is pinned, not a semver range — Flux reconciles continuously but
nothing upgrades until the tag changes.

Full documentation: [docs/guide/gitops.md](../../docs/guide/gitops.md).
