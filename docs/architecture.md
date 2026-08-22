# Architecture

Percussionist orchestrates OpenCode AI agents on Kubernetes with a controller-based architecture.

## System Overview

```
┌──────────────────────────────────────┐
│  Cluster                              │
│                                        │
│  ┌──────────┐  ┌──────────────────┐   │
│  │ Operator  │  │ Manager          │   │
│  │ Controller│  │ Controller + MCP │   │
│  └────┬─────┘  └────────┬─────────┘   │
│       │                 │             │
│  ┌────▼──────────┐  ┌──▼──────────┐  │
│  │ Runner Pod    │  │ Web Dashboard│  │
│  │ ┌───────────┐ │  │ (Hono+React)│  │
│  │ │OpenCode   │ │  └─────────────┘  │
│  │ │Dispatcher │ │                   │
│  │ │Init       │ │  ┌──────────────┐  │
│  │ └───────────┘ │  │ Memory Svc   │  │
│  └───────────────┘  │ (Bun+sqlite) │  │
│                     └──────┬───────┘  │
│                            │          │
│                     ┌──────▼───────┐  │
│                     │ Ollama       │  │
│                     │ (embeddings) │  │
│                     └──────────────┘  │
└──────────────────────────────────────┘
```

## Packages (dependency order)

| # | Package | Description |
|---|---------|-------------|
| 1 | `@percussionist/api` | Zod schemas, constants, type helpers |
| 2 | `@percussionist/kube` | Shared K8s client; depends on `api` |
| 3 | `@percussionist/operator` | Run reconciler; creates Pods, Services, ConfigMaps |
| 4 | `@percussionist/dispatcher` | Sidecar; session lifecycle, SSE streaming |
| 5 | `@percussionist/manager-controller` | Project board controller + decision engine + MCP server |
| 6 | `@percussionist/memory-service` | Per-project vector embedding server (Bun + sqlite-vec) |
| 7 | `@percussionist/web` | Hono + React dashboard, REST APIs, stats DB |
| 8 | `@percussionist/cli` | `beatctl` CLI; talks to K8s API directly |
| 9 | `@percussionist/runner-claude` | Claude Agent SDK runner sidecar (alternative engine) |

The first eight form the dependency chain (`api` → `kube` → operator/dispatcher/
manager-controller → web/cli); `runner-claude` is standalone (Claude Agent SDK +
Hono) and ships in its own image.

## Controller Architecture

### Operator

The operator watches `Run` CRs and creates the necessary Kubernetes resources:

- **Runner Pod** — 3 containers: workspace-init (cache/git setup), opencode (agent runtime), dispatcher (session management, SSE streaming, MCP tools)
- **Service** — Exposes the agent's web UI and dispatcher MCP server
- **ConfigMap** — Agent configuration (`opencode.json`, `settings.json`)
- **PVC mounts** — Project data PVC for caching and git workspaces

### Manager

The manager watches `Project` and `Task` CRs, implementing the board controller pattern:

- **Reconcile loop** — Reads project board state, determines next actions
- **Decision engine** — Evaluates task transitions, agent assignments, parallel limits
- **MCP server** — Exposes orchestration tools (create_run, force_retry, etc.) on port 4097
- **Chat handler** — Interactive agent chat on port 4098
- **OpenCode web** — Sidecar on port 4096

### Controller Pattern

Both controllers use `makeInformer` + in-memory work queue pattern. They are single-replica with `Recreate` strategy — no leader election required.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict, ESM, ES2022) |
| Runtime | Node.js 24, Bun (web + memory service) |
| K8s Client | `@kubernetes/client-node` |
| API Framework | Hono (web), raw `node:http` (manager MCP/chat) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui |
| Database | SQLite via Drizzle ORM (web), sqlite-vec (memory) |
| Package Manager | pnpm (monorepo) |
| Linting | Biome |

## Data Flow

1. **User** creates a `Task` CR via `kubectl` or the web dashboard
2. **Manager** watches `Task` CRs, reconciles, creates a `Run` CR
3. **Operator** watches `Run` CRs, reconciles, creates a runner Pod
4. **Runner** runs init containers (git mirror fetch, worktree setup, cache setup)
5. **Runner** launches OpenCode agent with dispatcher sidecar
6. **Agent** communicates with Manager via MCP tools (`create_task`, `force_retry`, etc.)
7. **Agent** signals completion via `complete_run` / `fail_run` MCP tools
8. **Agent** may report issues outside its own task via `report_unrelated_issue` MCP tool → writes to `{project}-findings` ConfigMap inbox (distinct from a reviewer's `complete_review` findings, which land on the task at `status.diffFindings`)
9. **Manager** ingests findings from ConfigMap inbox on each reconcile cycle: deduplicates, triages, optionally auto-creates Task CRs, and updates `board.status.findings[]`
10. **Manager** updates `Task.status` and board state accordingly
