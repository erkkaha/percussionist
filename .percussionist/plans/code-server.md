# Per-Project Code-Server with Tailscale

## Overview

Add opt-in code-server support to Projects, enabling interactive VS Code workspace access via Tailscale. The operator will reconcile a Deployment, Service, and Tailscale Ingress per project when `spec.codeServer.enabled: true`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Project: my-project                                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ code-server Deployment (1 replica)                       │   │
│  │  - Mounts: {project}-data PVC at /data                   │   │
│  │  - Workdir: /data (can browse worktrees/, git-mirrors/)  │   │
│  │  - Port: 8080                                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Tailscale Ingress                                        │   │
│  │  - hostname: code-{project}                              │   │
│  │  - proxyClass: percussionist-code-server                 │   │
│  │  - backend: code-server-{project}:8080                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│         https://code-{project}.{tailnet}.ts.net                 │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

1. **Scope**: Per-project (not per-run) to minimize resource usage
2. **Image**: Configurable, default `codercom/code-server:4.96.4` (pinned)
3. **Extensions**: None pre-installed
4. **Auth**: None (Tailscale provides network-level auth)
5. **Reconciler**: Part of existing operator package
6. **Naming**: `code-{project-name}` for Tailscale hostname
7. **PVC requirement**: Only enabled when `source.git` or `source.local` is set

## Resource Estimates

| Component | CPU Request | Memory Request | Memory Limit |
|-----------|-------------|----------------|--------------|
| code-server | 100m | 256Mi | 512Mi |
| Tailscale proxy | 50m | 64Mi | 128Mi |
| **Total per project** | **150m** | **320Mi** | **640Mi** |

## Task Breakdown

### 1. API Schema Changes (`@percussionist/api`)

**File**: `packages/api/src/index.ts`

- Add constants:
  ```typescript
  export const CODE_SERVER_CONTAINER = "code-server";
  export const CODE_SERVER_PORT = 8080;
  export const CODE_SERVER_DEFAULT_IMAGE = "codercom/code-server:4.96.4";
  ```

- Add `CodeServerSpecSchema`:
  ```typescript
  export const CodeServerSpecSchema = z.object({
    /** Enable per-project code-server for interactive workspace access. */
    enabled: z.boolean().default(false),
    /** code-server image. */
    image: z.string().default(CODE_SERVER_DEFAULT_IMAGE),
    /** Pod resource requirements. */
    resources: ResourceRequirementsSchema.optional(),
  });
  export type CodeServerSpec = z.infer<typeof CodeServerSpecSchema>;
  ```

- Extend `ProjectSpecSchema`:
  ```typescript
  /** Per-project code-server for interactive workspace access via Tailscale.
   *  Requires source.git or source.local (needs a data PVC to mount). */
  codeServer: CodeServerSpecSchema.optional(),
  ```

### 2. CRD Regeneration

**Command**: `pnpm codegen`

Regenerates `k8s/crds/project.yaml` from the updated Zod schema.

### 3. Operator: Code-Server Builder

**New file**: `packages/operator/src/code-server.ts`

Functions:
- `shouldReconcileCodeServer(project)` — returns true if enabled AND has source
- `codeServerDeploymentName(project)` — returns `code-server-{name}`
- `codeServerServiceName(project)` — returns `code-server-{name}`
- `codeServerIngressName(project)` — returns `code-server-{name}`
- `renderCodeServerDeployment(project)` — returns `V1Deployment`
- `renderCodeServerService(project)` — returns `V1Service`
- `renderCodeServerIngress(project)` — returns `V1Ingress`

**Deployment spec details**:
- Image: `spec.codeServer.image` (default `codercom/code-server:4.96.4`)
- Command: `["code-server", "--bind-addr", "0.0.0.0:8080", "--auth", "none", "/data"]`
- Working directory: `/data` (browse worktrees, git-mirrors, cache)
- Volume: `{project}-data` PVC mounted at `/data`
- Resources: `spec.codeServer.resources` or defaults
- Owner reference: Project CR (garbage collection on delete)

**Ingress spec details**:
- `ingressClassName: tailscale`
- Annotation: `tailscale.com/hostname: code-{project-name}`
- Annotation: `tailscale.com/proxy-class: percussionist-code-server`
- TLS host: `code-{project-name}`
- Backend: service `code-server-{project}`, port 8080

### 4. Operator: Project Informer

**File**: `packages/operator/src/index.ts`

Add a Project informer following the existing Run informer pattern:
- Watch `/apis/percussionist.dev/v1alpha1/namespaces/${NAMESPACE}/projects`
- On `add`/`update`: call `reconcileProject()`
- On `delete`: call `cleanupCodeServer()`
- On `error`: log and restart after 2s delay

### 5. Operator: Project Reconciler

**File**: `packages/operator/src/reconciler.ts`

Add functions:
- `reconcileProject(project)`:
  - If `shouldReconcileCodeServer()`:
    - Ensure data PVC exists
    - Upsert Deployment (patch or create)
    - Upsert Service (patch or create)
    - Upsert Ingress (patch or create)
  - Else: call `cleanupCodeServer()`

- `cleanupCodeServer(project)`:
  - Delete Ingress (ignore 404)
  - Delete Service (ignore 404)
  - Delete Deployment (ignore 404)

### 6. ProxyClass Manifest

**New file**: `k8s/deploy/code-server-proxy-class.yaml`

```yaml
apiVersion: tailscale.com/v1alpha1
kind: ProxyClass
metadata:
  name: percussionist-code-server
spec:
  statefulSet:
    pod:
      tailscaleContainer:
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            memory: 128Mi
```

**Update**: `k8s/deploy/kustomization.yaml` — add to resources list.

### 7. Documentation Update

**File**: `AGENTS.md`

Add section documenting:
- How to enable code-server on a project
- Tailscale access URL pattern
- Resource requirements
- Limitations (requires `source.git` or `source.local`)

## Files Changed

| # | Package/Location | File | Change Type |
|---|------------------|------|-------------|
| 1 | `@percussionist/api` | `src/index.ts` | Edit |
| 2 | `k8s/crds/` | `project.yaml` | Regenerated |
| 3 | `@percussionist/operator` | `src/code-server.ts` | **New file** |
| 4 | `@percussionist/operator` | `src/index.ts` | Edit |
| 5 | `@percussionist/operator` | `src/reconciler.ts` | Edit |
| 6 | `k8s/deploy/` | `code-server-proxy-class.yaml` | **New file** |
| 7 | `k8s/deploy/` | `kustomization.yaml` | Edit |
| 8 | Root | `AGENTS.md` | Edit |

## Verification

1. `pnpm build` — all packages compile
2. `pnpm typecheck` — no type errors
3. `pnpm codegen` — regenerate CRDs
4. Manual test:
   - Apply CRDs: `kubectl apply -f k8s/crds/`
   - Apply deploy: `kubectl apply -f k8s/deploy/`
   - Create project with `codeServer.enabled: true` and `source.local: true`
   - Verify: Deployment, Service, Ingress created
   - Access: `https://code-{project}.{tailnet}.ts.net`

## Usage Example

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
  namespace: percussionist
spec:
  source:
    local: true  # or source.git: { url: "..." }
  codeServer:
    enabled: true
    # Optional overrides:
    # image: codercom/code-server:4.96.4
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

Access at: `https://code-my-project.{tailnet}.ts.net`
