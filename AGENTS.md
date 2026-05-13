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

## Architecture
- All packages are ESM (`"type": "module"`)
- Strict TypeScript everywhere (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- Zod schemas in `@percussionist/api` are the single source of truth for CRDs
- CRD YAML is generated from Zod (`packages/api/codegen/`)
- Operator and Manager use `makeInformer` + in-memory work queue pattern
- API group: `percussionist.dev/v1alpha1`

## Conventions
- No linter/formatting tool configured -- do not add one without asking
- No test framework -- do not add tests without asking
- K8s client: `@kubernetes/client-node` (lazy singleton, typed CRUD helpers)
- Console-based logging with timestamps (no structured logger)
- CamelCase for TS, kebab-case for YAML
- `runXxx` prefix for CLI action functions in `@percussionist/cli`

## Packages (dependency order)
1. `@percussionist/api` - Zod schemas, constants, type helpers
2. `@percussionist/kube` - Shared K8s client; depends on `api`
3. `@percussionist/operator` - OpenCodeRun reconciler; creates Pod/Service/Ingress/ConfigMap
4. `@percussionist/dispatcher` - Sidecar; session lifecycle, SSE streaming, analytics
5. `@percussionist/manager` - OpenCodeProject board controller; creates worker OpenCodeRuns
6. `@percussionist/web` - Hono + React dashboard; REST APIs, stats DB (SQLite via Drizzle)
7. `@percussionist/cli` - beatctl CLI; talks to K8s API directly
