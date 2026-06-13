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

## Verifying

```bash
kubectl -n percussionist get pods
kubectl -n percussionist get crd | grep percussionist
```

## Next

- [Configuration](/guide/configuration) — project spec reference
- [Getting Started](/guide/getting-started) — first run walkthrough
