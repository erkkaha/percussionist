# Installation

## CRDs

Apply the Custom Resource Definitions first. These define the API types that Percussionist operates on.

```bash
kubectl apply -f k8s/crds/
```

CRDs must be applied before any Percussionist resources can be created.

## Manifests

Deploy the operator, manager, web dashboard, and RBAC:

```bash
kubectl apply -f k8s/deploy/
```

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

## Verifying

```bash
kubectl -n percussionist get pods
kubectl -n percussionist get crd | grep percussionist
```

## Next

- [Configuration](/guide/configuration) — project spec reference
- [Getting Started](/guide/getting-started) — first run walkthrough
