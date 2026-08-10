# Installation

There are two ways to install the control plane, and the choice determines how
upgrades behave later:

| | Install | Upgrades cover |
|---|---|---|
| Direct | `beatctl deploy`, or the manual steps below | Container images only — CRDs need a manual re-apply |
| GitOps | `beatctl deploy --gitops` | CRDs and manifests together, applied in order |

Direct is the smaller footprint and needs nothing besides `kubectl`. GitOps
runs two extra controllers and makes the dashboard's Upgrade button complete —
see [GitOps upgrades](/guide/gitops) for what that fixes and why it matters.

## CRDs

Apply the Custom Resource Definitions first. These define the API types that Percussionist operates on.

```bash
kubectl apply -f k8s/crds/
```

CRDs must be applied before any Percussionist resources can be created.

## Manifests

Deploy the operator, manager, web dashboard, and RBAC:

```bash
kubectl apply -k k8s/deploy/
```

Note `-k`, not `-f`: the directory carries a `kustomization.yaml`, which
`kubectl apply -f` tries to apply as a cluster resource and fails on.

### Components

| Component | Purpose | Replicas |
|-----------|---------|----------|
| `percussionist-operator` | Run reconciler — creates Pods, Services, ConfigMaps | 1 |
| `percussionist-manager` | Project board controller, decision engine, MCP server | 1 |
| `percussionist-web` | Hono + React dashboard, stats database | 1 |

All deployments use `Recreate` strategy. No leader election required.

## Namespace

Default namespace: `percussionist`

```bash
kubectl create namespace percussionist
```

Override via the `PERCUSSIONIST_NAMESPACE` environment variable on deployments.

## Dashboard sign-in

The dashboard requires authentication, so configure GitHub sign-in before you can
reach it. Register a GitHub App whose callback URL exactly matches
`${WEB_BASE_URL}/api/auth/callback/github` (`WEB_BASE_URL` is set in
`k8s/deploy/web.yaml` and must match your Ingress host). No App permissions are
needed and it does not need installing anywhere.

```bash
beatctl auth github set-app <client-id> <client-secret>
beatctl auth github allow <your-github-login>   # empty allowlist = nobody can sign in
beatctl auth session-secret                     # session signing key
beatctl auth mcp-token                          # gates the manager's MCP port
kubectl -n percussionist rollout restart deploy/percussionist-web
```

The web server mints the operator's and manager's scoped API keys on first
startup and writes them to the `operator-api-key` and `manager-api-key` Secrets.
Restart those two afterwards so they pick the keys up, then confirm:

```bash
kubectl -n percussionist rollout restart deploy/percussionist-operator
kubectl -n percussionist rollout restart deploy/percussionist-manager
beatctl auth key list
```

For local development you can skip all of this with `beatctl auth web-token
disable`, which sets `AUTH_DISABLED=1` and bypasses authentication entirely. That
is also the way back in if sign-in is ever misconfigured.

See [Security](/security) for the full model.

## Local overrides (kustomize)

Anything machine-specific — the public hostname, locally built image tags —
belongs in an overlay rather than in the checked-in manifests, so `git status`
stays clean and `git pull` never conflicts with your cluster:

```bash
cp -r k8s/local.example k8s/local   # k8s/local is gitignored
$EDITOR k8s/local/kustomization.yaml k8s/local/tailnet-ingress.yaml
kubectl apply -k k8s/local
```

The overlay uses `k8s/deploy` as its base. `beatctl deploy` still applies
`k8s/deploy/*.yaml` directly, so it reverts patches to those resources — re-run
`kubectl apply -k k8s/local` afterwards. Resources the overlay *adds* have their
own names and are never touched.

### Tailnet access

`k8s/local.example/` is a worked example of the most common override: serving the
dashboard to every device on a [Tailscale](https://tailscale.com) tailnet over
real HTTPS, which also gives you the secure context that browser notifications
and the drum audio require. It combines an extra Ingress for the MagicDNS
hostname (ingress-nginx routes by `Host`, and `tailscale serve` forwards the
tailnet name) with a `WEB_BASE_URL` patch, plus:

```bash
sudo tailscale serve --bg --https=443 http://$(minikube ip):80
```

Register `https://<host>.<tailnet>.ts.net/api/auth/callback/github` with your
GitHub App first — changing `WEB_BASE_URL` changes the OAuth `redirect_uri`, and
the https origin makes session cookies `Secure`, so it becomes the only origin
you can sign in from. See the comments in `k8s/local.example/tailnet-ingress.yaml`
for the full walkthrough.

## Verifying

```bash
kubectl -n percussionist get pods
kubectl -n percussionist get crd | grep percussionist
```

## Next

- [LXD, MicroK8s, and Tailscale](/guide/lxd-microk8s-tailscale) — tailnet-only single-node playbook
- [Configuration](/guide/configuration) — project spec reference
- [Getting Started](/guide/getting-started) — first run walkthrough
