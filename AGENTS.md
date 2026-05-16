# Percussionist

## Project
Kubernetes-native orchestration for OpenCode AI agents. A pnpm monorepo (v10)
of TypeScript packages under `packages/*`.

## Key Commands
- `pnpm build` - Build all packages
- `pnpm typecheck` - Type-check all packages (run before committing)
- `pnpm bundle` - Bundle CLI into standalone binary (`beatctl`)
- `pnpm codegen` - Generate CRD YAML from Zod schemas
- `pnpm beatctl` - Run CLI from source
- `pnpm web` - Start web dev server
- `pnpm web:client` - Start Vite dev server for client

## Building
- All packages build with `tsc` (ESM output, ES2022 target, NodeNext module)
- Web client is built separately via Vite (`pnpm build:client`)
- Docker images live in `images/` with multi-stage Dockerfiles:
  - `images/runner/` - opencode + git + ssh + node (Alpine-based)
  - `images/node/` - Shared Node 24 base
  - `images/web/` - Bun runtime
  - `images/manager/` - Node 24
- Images are built locally (no external registry) and loaded into cluster via `scripts/minikube-load.sh`

## Deployment
- CRDs: `kubectl apply -f crds/` (must be applied first)
- Manifests: `kubectl apply -f deploy/` (operator, manager, web, RBAC)
- Default namespace: `percussionist` (overridable via `PERCUSSIONIST_NAMESPACE`)
- Smoke test: `kubectl apply -f manifests/m1-smoke.yaml`
- All deployments are single-replica with `Recreate` strategy (no leader election)
- In-cluster config by default, falls back to kubeconfig

## Caching
- All runs require `metadata.labels["percussionist.dev/project"]` label
- Cache PVC (`{project}-cache`) is auto-created per project with RWX access mode
- Cache structure:
  - `/cache/pnpm/` - pnpm home and global bins
  - `/cache/pnpm-store/` - pnpm store directory
  - `/cache/npm/` - npm cache
  - `/cache/bun/` - bun install cache
  - `/cache/turbo/` - Turbo build cache
- Cache size: 5Gi (default, configurable via `spec.cache` in future)
- Cache lifecycle: Tied to OpenCodeProject (auto-deleted when project is deleted)
- Storage: Uses cluster default storage class with ReadWriteMany access mode
  - For RWX support on minikube/k3s, requires NFS or similar provisioner
  - Falls back gracefully if PVC creation fails
- Override PVC name via `spec.cache.pvcName` (optional)
- Override storage class via `spec.cache.storageClass` (optional)
- Override mount path via `spec.cache.mountPath` (defaults to `/cache`)

## Architecture
- All packages are ESM (`"type": "module"`)
- Strict TypeScript everywhere (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- Zod schemas in `@percussionist/api` are the single source of truth for CRDs
- CRD YAML is generated from Zod (`packages/api/codegen/`)
- Operator and Manager use `makeInformer` + in-memory work queue pattern
- API group: `percussionist.dev/v1alpha1`
- `opencode-web` supports MCP servers via the `mcp` config key (not `mcpServers` — that was a legacy format); the manager's agent-config ConfigMap uses `mcp` with `type: "remote"` pointing at the in-process MCP server on :4097.

## Conventions
- No linter/formatting tool configured -- do not add one without asking
- No test framework -- do not add tests without asking
- K8s client: `@kubernetes/client-node` (lazy singleton, typed CRUD helpers)
- Console-based logging with timestamps (no structured logger)
- CamelCase for TS, kebab-case for YAML
- `runXxx` prefix for CLI action functions in `@percussionist/cli`

## MCP Server Configuration

The manager runs an in-process MCP server (`packages/manager-controller/src/agent/tools.ts`)
on port 4097 serving tools at `POST /mcp` (Streamable HTTP, JSON-RPC 2.0).

The opencode-web sidecar discovers it via the `agent-config` ConfigMap's `opencode.json`
under the `mcp.manager-agent` key. The URL **must** include the full path:

```json
{
  "mcp": {
    "manager-agent": {
      "type": "remote",
      "url": "http://127.0.0.1:4097/mcp",
      "enabled": true
    }
  }
}
```

The `/mcp` path is required — the server returns 404 on all other paths. After updating
the ConfigMap, verify the sidecar is connected:

```bash
kubectl -n percussionist exec deployment/percussionist-manager -c opencode-web \
  -- wget -qO- http://127.0.0.1:4096/mcp
# Expected: {"manager-agent":{"status":"connected"}}
```

If the status is anything other than `"connected"`, the URL or path is wrong.

## Image Build & Load Pitfalls

### 1. New source files may be silently excluded from Docker images
The `images/node/Dockerfile` cleans `dist/` before each `pnpm build` to avoid tsc
incremental compilation skipping newly-added files. If you see a running pod
missing expected code (e.g., `dist/agent/` directory doesn't exist), rebuild
with `--no-cache`:
```
docker build --no-cache --build-arg PKG=manager-controller -f images/node/Dockerfile -t percussionist/manager:dev .
```

### 2. `minikube image load --overwrite=true` silently fails when old image is in use
When a running container references the old image, Docker refuses to untag it.
The `--overwrite=true` flag exits 0 but does **not** update the tag. To verify:
```bash
# Check if the pod's image ID matches what you just built
docker image inspect --format '{{.Id}}' percussionist/manager:dev | cut -d: -f2 | cut -c1-12
minikube image ls --format table | grep manager
```
If they differ, the old image is pinned. Fix (scale to 0, rm, load, scale back):
```bash
kubectl -n percussionist scale deploy/percussionist-manager --replicas=0
kubectl -n percussionist wait --for=delete pod -l app.kubernetes.io/component=manager --timeout=60s
minikube image rm docker.io/percussionist/manager:dev
minikube image load percussionist/manager:dev
kubectl -n percussionist scale deploy/percussionist-manager --replicas=1
```
Or simply use `--force` with `scripts/minikube-load.sh` which handles eviction
automatically:
```
./scripts/minikube-load.sh --force --only manager
```

### 3. Debugging: exec into the pod to check dist/ contents
If changes don't appear in a running pod, check the actual files:
```bash
kubectl -n percussionist exec deployment/percussionist-manager -c manager -- ls -la /app/packages/manager-controller/dist/agent/
```
If the directory is missing, the image was built from old code (see #1 above).
If it exists but the pod still behaves wrong, the service/endpoint may need
verification:
```bash
kubectl -n percussionist exec deployment/percussionist-web -- wget -qO- --timeout=5 http://percussionist-manager.percussionist.svc.cluster.local:4098/chat/history
```

### 4. Eviction labels in `scripts/minikube-load.sh`
The `--force` path scales deployments to 0 before reloading images. The pod
label selectors used are:
- Manager: `app.kubernetes.io/component=manager`
- Operator: `app.kubernetes.io/component=operator`
- Web: `app.kubernetes.io/component=web`
These match the `matchLabels` in each Deployment's spec.selector.

## Packages (dependency order)
1. `@percussionist/api` - Zod schemas, constants, type helpers
2. `@percussionist/kube` - Shared K8s client; depends on `api`
3. `@percussionist/operator` - OpenCodeRun reconciler; creates Pod/Service/Ingress/ConfigMap
4. `@percussionist/dispatcher` - Sidecar; session lifecycle, SSE streaming, analytics
5. `@percussionist/manager-controller` - OpenCodeProject board controller + embedded agent module (decision engine, MCP tools on :4097, chat handler on :4098, opencode-web sidecar on :4096)
6. `@percussionist/web` - Hono + React dashboard; REST APIs, stats DB (SQLite via Drizzle)
7. `@percussionist/cli` - beatctl CLI; talks to K8s API directly (includes `chat` command)
