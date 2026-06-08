# Percussionist

## Project
Kubernetes-native orchestration for OpenCode AI agents. A pnpm monorepo (v10)
of TypeScript packages under `packages/*`.

## Key Commands
- `pnpm build` - Build all packages
- `pnpm typecheck` - Type-check all packages via `tsc -b` (run before committing; respects project references, runs in topological order)
- `pnpm test` - Run unit + smoke tests across all packages (Vitest + Bun)
- `pnpm e2e:core` - Run deterministic E2E suites on a live cluster (PR gate)
- `pnpm e2e:extended` - Run extended E2E suites for complex paths like feature branching
- `pnpm e2e` - Aggregate: runs all E2E suites
- `pnpm bundle` - Bundle CLI into standalone binary (`beatctl`)
- `pnpm codegen` - Generate CRD YAML from Zod schemas
- `pnpm beatctl` - Run CLI from source
- `pnpm web` - Start web dev server
- `pnpm web:client` - Start Vite dev server for client

## Building
- All packages build with `tsc` (ESM output, ES2022 target, NodeNext module)
- Web client is built separately via Vite (run `pnpm build:client` inside `packages/web`, or just use `pnpm build` from the root which handles it)
- Docker images live in `images/` with multi-stage Dockerfiles:
  - `images/runner/` - opencode + git + ssh + node (Alpine-based)
  - `images/node/` - Shared Node 24 base
  - `images/web/` - Bun runtime
  - `images/manager/` - Node 24
- Images are built locally (no external registry) and loaded into cluster via `scripts/minikube-load.sh`

## Testing

Percussionist uses a four-layer testing model. See [`docs/testing-strategy.md`](docs/testing-strategy.md) for full details including deterministic principles, responsibility boundaries, and the recipe for adding new E2E tests.

| Tier | Command | When to run | Duration target |
|------|---------|-------------|-----------------|
| **Unit + Smoke** | `pnpm test` | Every commit; PR gate required | < 1 min |
| **Core E2E** | `pnpm e2e:core` | Before merging feature branches; CI on every PR | < 10 min |
| **Extended E2E** | `pnpm e2e:extended` | Before releases; manual trigger for complex paths | < 20 min |

### Deterministic Principles (always apply)

- **Never trust model prose for pass/fail.** Assert only on CR status fields (`Run.status.phase`, `Task.status.phase`) and board JSON columns — never on LLM-generated text.
- **MCP tool calls are deterministic control points.** Use ClusterAgent fixtures with `CRITICAL OVERRIDE` to force specific agent behavior (`complete_run`, `complete_plan`, `fail_run`).
- **Pod-exec is a targeted oracle.** Only use `kubectl exec` when CR status cannot express the needed fact (e.g., plan artifact existence in worktree).
- **Tests are model-agnostic.** A test should pass regardless of which LLM provider or model is configured.

### Adding a New Deterministic E2E Test

1. Create a deterministic ClusterAgent fixture in `k8s/tests/` with `CRITICAL OVERRIDE` instructions
2. Write the test file in `tests/e2e/e2e-<scenario>.test.ts` using shared harness helpers
3. Assert only on CR status and board state — never on model output text
4. Ensure `afterAll` always runs cleanup via `teardown(NS)`
5. Add to `e2e:core` script for PR-required tests, or `e2e:extended` for complex paths

See [`docs/testing-strategy.md`](docs/testing-strategy.md#adding-a-new-deterministic-e2e-test) for the complete recipe with code examples.

## Deployment
- CRDs: `kubectl apply -f k8s/crds/` (must be applied first)
- Manifests: `kubectl apply -f k8s/deploy/` (operator, manager, web, RBAC)
- Default namespace: `percussionist` (overridable via `PERCUSSIONIST_NAMESPACE`)
- Smoke test: `kubectl apply -f k8s/samples/m1-smoke.yaml`
- All deployments are single-replica with `Recreate` strategy (no leader election)
- In-cluster config by default, falls back to kubeconfig

## Data PVC (Caching + Git)
- All runs require `metadata.labels["percussionist.dev/project"]` label
- Data PVC (`{project}-data`) is auto-created per project with RWX access mode
- PVC layout:
  - `/data/cache/pnpm/` - pnpm home and global bins
  - `/data/cache/pnpm-store/` - pnpm store directory
  - `/data/cache/npm/` - npm cache
  - `/data/cache/bun/` - bun install cache
  - `/data/cache/turbo/` - Turbo build cache
  - `/data/git-mirrors/{url-hash}/` - bare git mirror (one per remote repo URL)
  - `/data/worktrees/{run-name}/` - per-run worktree checkout (remote git)
  - `/data/workspace/` - persistent local git workspace (`source.local: true`)
- PVC size: 10Gi (default)
- PVC lifecycle: Tied to Project (auto-deleted when project is deleted)
- Storage: Uses cluster default storage class with ReadWriteMany access mode
  - For RWX support on minikube/k3s, requires NFS or similar provisioner
  - Falls back gracefully if PVC creation fails
- Override PVC name via `spec.data.pvcName` (optional)
- Override storage class via `spec.data.storageClass` (optional)
- Override mount path via `spec.data.mountPath` (defaults to `/data`)

## Code-Server (Interactive Workspace Access)

Projects can enable an opt-in code-server instance for interactive VS Code access
to the workspace.

### Enable

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
spec:
  source:
    local: true  # or source.git
  codeServer:
    enabled: true
    # Optional overrides:
    # image: codercom/code-server:4.96.4
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

### Access (Minikube / Vanilla K8s)

```bash
kubectl -n percussionist port-forward svc/code-server-my-project 8080:8080
# Open http://localhost:8080
```

### Workspace Layout

The code-server mounts the project's data PVC at `/data`, giving access to:
- `/data/worktrees/{run-name}/` — per-run git worktrees (remote git)
- `/data/workspace/` — persistent workspace (local git)
- `/data/git-mirrors/` — bare git mirrors
- `/data/cache/` — package manager caches

### Requirements

- `source.git` or `source.local` must be set (needs a data PVC)

### Resources

| Component | CPU Request | Memory Request | Memory Limit |
|-----------|-------------|----------------|--------------|
| code-server | 100m | 256Mi | 512Mi |

## Vector Memory Service

Projects can enable a per-project vector memory service for semantic context
retrieval and session summarization. When `spec.embedding.enabled: true`, the
operator deploys a `memory-{project}` Deployment + Service running a Bun server
with bun:sqlite and sqlite-vec for vector storage and search.

### How It Works

1. **Memory Service Pod** — A `memory-{project}` Bun container runs alongside
   the project's data PVC. It exposes REST endpoints on port 4100 for storing
   memories, semantic search, and context retrieval. It calls Ollama's
   `/api/embeddings` endpoint to generate vector embeddings.

2. **Context Injection** — When `buildWorkerRun()` constructs the worker prompt
   (see `worker-builder.ts`), if `spec.embedding.enabled: true` it queries the
   memory service with the task description as the search query. Matching results
   are injected into the prompt as a `RELEVANT PROJECT CONTEXT:` block so the
   agent has relevant past decisions and findings without manual context loading.

3. **Session Summarization** — When a worker run completes (`Succeeded` or
   `Failed`), if `spec.embedding.enabled: true`, the manager fires a fire-and-forget
   `SummarizeSession` effect. The session-summarizer reads the session messages
   from the dispatcher's ConfigMap snapshot, compacts them, sends them to the LLM
   for a 2-3 paragraph summary, and stores the summary in:
   - The run's `{runName}-session` ConfigMap under key `summary-{sessionID}`
   - The project's vector memory database (via `POST /memory`), tagged with
     `type: "session-summary"`

4. **BUILD Task Generation Context** — The `buildBuildTaskGeneratorRun()`
   function (in `facilitator.ts`) reads stored session summaries from the
   ConfigMap before constructing the buildgen agent's prompt. If a stored
   summary exists for the preceding PLAN worker run, it is included as
   `PLAN SESSION CONTEXT:` so the buildgen agent has high-level context
   without needing to read the full session.

### Enable

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
spec:
  source:
    git:
      url: https://github.com/example/repo.git
  embedding:
    enabled: true
    # Optional overrides:
    # model: nomic-embed-text           # default
    # dimensions: 768                    # default
    # ollamaUrl: http://ollama:11434     # default (cluster DNS)
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

### Prerequisites

- **Ollama Deployment** — The cluster must have an Ollama service running the
  embedding model:
  ```bash
  kubectl apply -f k8s/deploy/ollama.yaml
  kubectl -n percussionist wait --for=condition=Ready pod -l app.kubernetes.io/component=ollama
  ```
  The init container on the Ollama Deployment automatically pulls `nomic-embed-text`
  before the main container starts, so no manual pull is required.
- `source.git` or `source.local` must be set (needs a data PVC)

### Available MCP Tools

When the memory service is enabled, the manager MCP server (port 4097) exposes
these tools for agent use:

| Tool | Purpose |
|------|---------|
| `store_memory` | Store a memory with semantic embedding for future context retrieval |
| `query_memory` | Semantic search across stored memories, ranked by cosine distance |
| `get_context` | Retrieve relevant context from past runs and memories, formatted for prompt injection |

### Resources

| Component | CPU Request | Memory Request | Memory Limit |
|-----------|-------------|----------------|--------------|
| memory service | 100m | 256Mi | 512Mi |

### Lifecycle

- **Created**: Automatically when a Project with `spec.embedding.enabled: true`
  is created and has `source.git` or `source.local` configured.
- **Deleted**: Automatically when the Project is deleted (via owner references)
  or when `embedding.enabled` is set to `false`.

## Git Workspace Modes

### Remote git (`source.git`)
- First run: clones a bare mirror to `/data/git-mirrors/{hash}/` then creates a worktree at `/data/worktrees/{run-name}/`
- Subsequent runs: `git fetch` updates the mirror; worktree is reused by default (`gitCache.worktreeReuse: true`)
- Set `gitCache.worktreeReuse: false` to always start from a clean checkout
- Agent can push to the real remote — `remote set-url` restores the real URL after mirror-based setup
- Mirror fetches are serialized with `flock` so parallel runs don't corrupt the bare repo
- Worktree cleanup: the pod init container prunes stale worktrees on startup via `git worktree prune`; MCP tools (force_retry, set_task_state) no longer delete runs eagerly — the TTL controller handles cleanup after `runTTLDays` days; a cleanup pod spawns when a task reaches `done` to remove all deterministic worker worktrees for that task

### Local git (`source.local: true`)
- No remote URL required — mutually exclusive with `source.git`
- Workspace initialised with `git init` + empty commit on first use
- Persists across runs at `/data/workspace/` — agent commits accumulate
- Sample: `k8s/samples/local-git-project.yaml`

## Feature Branch Workflow (Optional)

Projects can enable isolated feature branch development by setting `spec.featureBranchingEnabled: true`. This creates per-task feature branches that prevent worktree conflicts and enable incremental feature development.

### Branch Structure

When enabled, tasks work on dedicated feature branches instead of `main`:

- **PLAN tasks** work on: `feature/{plan-task-id}`
- **BUILD tasks** (with parent PLAN) work on: `feature/{plan-task-id}--{build-task-id}`
- **Standalone BUILD tasks** work on: `feature/{build-task-id}`

Each run gets its own worktree at `/data/worktrees/{run-name}/` checking out the task's branch.

### Workflow

1. **PLAN Task Creation**
   - Task assigned branch `feature/plan-abc`
   - First run creates branch from `main`
   - Planner must create `.percussionist/plans/{plan-task-id}.md`; PLAN review evaluates this artifact, not code implementation output
   - Subsequent runs (retries/rework) continue on same branch
   - PLAN branch persists after completion (for future manual merge to main)

2. **BUILD Task Generation**
   - When PLAN is approved, BUILD tasks are created
   - Build task generation reads `.percussionist/plans/{plan-task-id}.md` first and includes full-plan context plus the plan path in each BUILD task description
   - Each BUILD branches from parent: `feature/plan-abc--build-123`
   - BUILD branches are created from the parent PLAN branch

3. **BUILD Review & Merge**
   - Agent works on BUILD branch, commits and pushes
   - On approval, merge run merges BUILD branch → parent PLAN branch
   - BUILD branch is deleted after successful merge
   - Next BUILD in sequence can now start (sees predecessor's changes)

4. **Predecessor Dependencies**
   - BUILD tasks with `spec.predecessorRef` wait for predecessor to merge
   - Reconciler blocks task from starting until predecessor is in `done` column AND has `mergedAt` timestamp
   - Ensures correct build order and that dependent tasks see predecessor's changes

5. **Feature Branch Merge** (Manual)
   - PLAN's `feature/{plan-id}` branch contains all merged BUILD changes
   - Manual merge to `main` when feature is complete (workflow TBD)
   - Feature branch kept indefinitely for now

### Benefits

- **No worktree conflicts**: Each task has unique branch, eliminating "refusing to fetch" errors
- **Incremental progress**: Retries/rework continue from previous work on same branch
- **Feature isolation**: All related work stays on feature branch until complete
- **Clean history**: Features merge as cohesive units

### Backward Compatibility

- Default: `featureBranchingEnabled: false` (work on `main`)
- Existing tasks continue on `main` when flag is enabled
- Only new tasks use feature branches
- Projects can migrate gradually

## Runner Packages

Projects can declare Alpine Linux packages to install in every run pod
via `spec.runner.packages`. These are installed at pod initialization
time in the workspace-init container through `apk add`.

### Enable

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
spec:
  runner:
    packages:
      - ripgrep
      - jq
      - tree
      - postgresql-client
```

### How it works

1. The workspace-init container runs `apk update --quiet && apk add --no-cache <packages>`
   before git mirror fetch or worktree setup.
2. The runner pod starts with all declared packages available via `$PATH`.
3. The manager injects the package list into the agent prompt as
   `AVAILABLE SYSTEM TOOLS:` so agents know what's available without
   manual discovery.
4. Per-run override: `spec.runner.packages` on a Run CR overrides the
   project defaults.

### Manager MCP tools

When the memory service is enabled, the manager MCP server (port 4097) exposes
additional tools for package management:

| Tool | Purpose |
|------|---------|
| `list_available_packages(project)` | Returns the packages declared for a project |
| `install_packages(project, packages)` | Installs ad-hoc packages via a maintenance pod (not persistent across restarts) |

### Base image

Packages are installed on top of the runner image
(`ghcr.io/erkkaha/percussionist/runner:latest`). The base image always
includes git, openssh, node, npm, bash, curl, unzip, and github-cli.

## Architecture
- All packages are ESM (`"type": "module"`)
- Strict TypeScript everywhere (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- Zod schemas in `@percussionist/api` are the single source of truth for CRDs (5 CRDs: `Run`, `Project`, `Task`, `ClusterAgent`, `ClusterSettings`)
- CRD YAML is generated from Zod (`packages/api/codegen/`)
- Operator and Manager use `makeInformer` + in-memory work queue pattern
- API group: `percussionist.dev/v1alpha1`
- Tasks are first-class `Task` CRs (not embedded in project spec); task state is authoritative in `Task.status`; project `spec.agents`, `spec.maxParallel`, `spec.phase` are top-level (no `spec.board` key)
- `opencode-web` supports MCP servers via the `mcp` config key (not `mcpServers` — that was a legacy format); the manager's agent-config ConfigMap uses `mcp` with `type: "remote"` pointing at the in-process MCP server on :4097.

## Database (SQLite — `@percussionist/web`)

The web server uses bun:sqlite via Drizzle ORM. Schema and migrations are managed by drizzle-kit.

**Tables:** `runs`, `messages`, `toolCalls`, `fileOps`, `taskEvents` (append-only audit log of `Task` state transitions — live task state is authoritative in the CRD status subresource).

**Tool Metrics:** Tool usage data comes from `toolCalls` (extracted from message parts by the dispatcher's `stats-reporter.ts`), NOT from `toolEvents` (which was based on SSE events and was removed — OpenCode's SSE stream does not emit `tool.started`/`tool.finished`). The `GET /api/stats/tool-metrics?days=30&agent=X` endpoint queries `toolCalls` joined with `runs` and `messages` for agent breakdown and estimated token cost per tool.

**Key files:**
- `packages/web/src/server/schema.ts` — Drizzle table definitions (single source of truth; no driver imports, safe for drizzle-kit)
- `packages/web/src/server/db.ts` — DB singleton; calls `migrate()` on first open
- `packages/web/migrations/` — generated SQL migration files (committed to git)
- `packages/web/drizzle.config.ts` — drizzle-kit config

**Workflow for schema changes:**
```bash
# 1. Edit packages/web/src/server/schema.ts
# 2. Generate migration SQL
cd packages/web && npx drizzle-kit generate
# 3. Commit schema.ts + the new migration file together
git add src/server/schema.ts migrations/
```
The server applies all pending migrations automatically on startup via `migrate()` in `getDb()`. No manual ALTER TABLE blocks.

**Removing tables — always use drizzle-kit generate, never manual surgery:**
Never delete a migration file or manually edit `migrations/meta/_journal.json` or `migrations/meta/0000_snapshot.json`. The journal tracks which migrations have been applied to production databases — removing an entry causes migration desync. To remove a table:
1. Delete the table definition from `schema.ts`
2. Run `cd packages/web && npx drizzle-kit generate`
3. Commit `schema.ts` + the new migration file together
Drizzle-kit will produce a `DROP TABLE` migration and update the journal/snapshot automatically.

**Adding columns — what NOT to do:**
Do not add `ALTER TABLE` try/catch blocks to `db.ts`. Do not duplicate DDL as raw SQL strings in `db.ts`. Always use drizzle-kit generate to produce a migration file.

## Conventions
- No linter/formatting tool configured -- do not add one without asking
- Testing: Vitest in `packages/manager-controller`; run `pnpm test` locally
- K8s client: `@kubernetes/client-node` (lazy singleton, typed CRUD helpers)
- Console-based logging with timestamps (no structured logger)
- CamelCase for TS, kebab-case for YAML
- `runXxx` prefix for CLI action functions in `@percussionist/cli`
- **`undefined` in merge-patches is silently dropped**: `JSON.stringify` strips `undefined` values, so a K8s merge-patch with `{ foo: undefined }` serializes to `{}` — the field is never cleared. Always use `null` to remove a field in a status patch or annotation patch passed to `patchTask` / `patchTaskStatus`.
- **Drizzle `sql` template with table aliases**: When using `${table.column}` inside a raw `sql\`...\`` template with a table alias (e.g. `FROM tool_calls tc2`), the column reference expands to `"table"."column"` — so `tc2.${toolCalls.sessionId}` generates `tc2."tool_calls"."session_id"` (broken). Always use the raw column name as a string on the aliased side: `tc2.session_id` not `tc2.${toolCalls.sessionId}`. The right side of a comparison can still use `${toolCalls.sessionId}` to reference the outer query's column.

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

### Available MCP Tools

| Tool | Purpose |
|------|---------|
| `inspect_cr` | Get full details of a CR (Run, Project, Task, ClusterAgent) |
| `list_crs` | List CRs of a given kind with optional labelSelector |
| `read_logs` | Read pod logs for a run (default: opencode container, last 100 lines) |
| `read_session` | Read session messages from a completed run's ConfigMap snapshot |
| `read_session_live` | Incremental session messages with `since`/`nextSince` for polling (tries live API first, falls back to ConfigMap) |
| `patch_board` | Merge-patch `Project.status.board` (escalations, pendingQuestions, facilitations, managerMetrics) |
| `delete_run` | Delete an Run by name |
| `create_run` | Create a new run for a ready task; resolves feature-branch metadata and updates `Task.status` |
| `create_task` | Create a new Task CR from the manager |
| `force_retry` | Restart a stuck task at an incremented retry count via `Task.status` (does not delete old runs) |
| `set_task_state` | Move a task to a target column, optionally cancel running runs (runs preserved by default) |
| `exec_in_workspace` | Run commands in the project's data PVC workspace |
| `read_plan` | Read a plan artifact from the project's plans ConfigMap |
| `write_plan` | Write a plan artifact to the project's plans ConfigMap |
| `check_for_updates` | Check the latest Percussionist release version |
| `apply_upgrade` | Upgrade Percussionist deployments to a target image tag |
| `list_models` | List available LLM providers and models from the opencode sidecar |
| `list_task_events` | List task lifecycle audit events (append-only log) |
| `read_manager_logs` | Read logs from the manager controller pod |
| `pause_reconciliation` | Pause the manager reconcile loop for a project (auto-resumes after timeout) |
| `resume_reconciliation` | Resume a paused reconcile loop |
| `get_reconcile_status` | Check whether the reconcile loop is paused and when it was last paused |
| `list_available_packages` | List Alpine packages declared for a project's runner |
| `install_packages` | Install ad-hoc Alpine packages via a maintenance pod |
| `store_memory` | Store a memory with semantic embedding for future context retrieval |
| `query_memory` | Semantic search across stored memories, ranked by cosine distance |
| `get_context` | Retrieve relevant context from past runs and memories, formatted for prompt injection |

**`create_run`** — Direct run creation without waiting for reconcile cycle.
- Requires: `project`, `task` (Task CR name)
- Optional: `agent`, `model`, `retryCount`, `reworkFeedback`, `namespace`
- Validates the transition via `isValidTransition(currentPhase, "running")` — errors
  if the current phase does not allow moving to `running` (use `force_retry` first)
- Moves task to `running` and patches `Task.status.worker` with resolved `gitBranch`,
  `parentBranch`, and `mergeIntoBranch` when feature branching is enabled

**`force_retry`** — One-shot cleanup and restart for stuck tasks.
- Requires: `project`, `task` (Task CR name)
- Optional: `createRun` (default `true`), `agent`, `model`, `namespace`
- Does NOT delete old runs — they are preserved as historical records until the TTL controller cleans them up after `runTTLDays` days
- Validates via `isValidTransition(currentPhase, "running")`; if the transition is
  non-standard (e.g. `failed` → `running`), it logs an admin override warning but
  proceeds (this is an administrative tool)
- If `createRun: true`: starts the next retry count (`existing retryCount + 1`) and
  resets task to `running` with feature-branch metadata via `patchTaskStatus`
- If `createRun: false`: resets task to `pending`, clears `runName`, and marks the
  worker failed so reconciliation can pick it up later

**`set_task_state`** — Atomic task phase transition.
- Requires: `project`, `task` (Task CR name), `targetPhase`
- Optional: `cancelRunning` (default `false`), `preserveRuns` (default `true`), `admin` (default `false`), `namespace`
- Valid phases: any value in the transition table (use `admin: true` to bypass validation)
- By default, validates via `isValidTransition(currentPhase, targetPhase)` and rejects
  illegal transitions. Set `admin: true` to override.
- Deletes matching runs for the specified project/task and prunes remote-git run worktrees; if `cancelRunning: true` also deletes active runs
- Patches `Task.status.phase`; phase-specific worker updates handle `running`, `done`,
  `pending`, `rework-requested`, and `failed` transitions

**`read_session_live`** — Real-time session message streaming.
- Requires: `runName`
- Optional: `sessionID` (auto-discovered), `since` (message index, default 0), `namespace`
- Returns `{ messages, total, nextSince, runPhase, sessionID, source }`
- Poll with `since = prev.nextSince` for incremental reads
- Falls back to ConfigMap snapshot if run pod is gone

**`pause_reconciliation`** — Prevent the manager from overriding manual board patches.
- Requires: `project`
- Optional: `durationSeconds` (default: 300), `namespace`
- Auto-resumes after the specified duration

## Dispatcher MCP Tools

The dispatcher sidecar runs an in-process MCP server on port 4097 (same port as manager,
but served within each run pod). These tools are available to agents during run execution:

| Tool | Purpose |
|------|---------|
| `complete_run` | Signal successful BUILD task completion |
| `complete_plan` | Signal successful PLAN task completion |
| `fail_run` | Signal task failure with reason, triggering facilitator analysis |
| `get_status` | Return current run state (phase, session ID, token usage) |
| `create_task` | Create a new BUILD Task CR (runs in the same project) |
| `search_code` | Search the workspace with ripgrep/grep |
| `write_plan` | Persist a plan artifact to the project's plans ConfigMap |
| `read_plan` | Read a plan artifact from the project's plans ConfigMap |
| `read_session` | Read session messages from another run's ConfigMap snapshot |

**`complete_plan`** vs **`complete_run`**:
- PLAN agents should call `complete_plan` after committing their plan document to `.percussionist/plans/{task-id}.md`
- BUILD agents should call `complete_run` after implementation is committed
- `complete_plan` signals plan artifact completion (no code work expected)
- `complete_run` signals implementation work is done

## Dispatcher SSE Event Streaming

The dispatcher connects to OpenCode's `/event` SSE endpoint for real-time token updates
and session state changes. Implementation notes:

- **Reconnection backoff**: 1-second delay between reconnection attempts (both success
  and error paths) to prevent runaway reconnection loops
- **Event logging**: All SSE events are logged as `[event] <type> <properties>` for
  debugging (properties truncated to 200 chars)
- **Known issue**: OpenCode's SSE stream may close immediately after `server.connected`,
  causing rapid reconnections. The 1-second backoff prevents resource exhaustion.
- See `packages/dispatcher/src/polling.ts` lines 194-252 (interactive) and 481-540 (prompt)

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

## Deployment Discipline

### NEVER do the following

**1. Never hot-deploy code changes to a running cluster.**
Code fixes go through commit → tag → push → CI. The CI pipeline builds images,
pushes to ghcr.io, and the cluster picks up the new tag on next pod restart.
Hot-deploying by rebuilding Docker images and `minikube image load` is fragile:
- Images silently fail to load when old image is pinned by a running pod
- The manager deployment references `ghcr.io/erkkaha/percussionist/manager:latest` —
  a locally tagged `:latest` may not match what the cluster expects
- Docker builds are memory-heavy and can OOM the host
- The running reconciler will override any manual status patches immediately

**2. Never delete and recreate the minikube cluster.**
`minikube delete` wipes ALL cluster state: CRDs, deployments, PVCs, all existing
tasks, runs, and project data. The cluster cannot be recovered after this.
If minikube is OOM or stuck, tell the human — don't try to fix it.

**3. Never attempt Docker builds on a memory-constrained system.**
The multi-stage `images/node/Dockerfile` runs `pnpm build` which compiles all
TypeScript packages. This requires several GB of free memory. If `free -h` shows
less than 2GB available, Docker builds will OOM. Stop and report.

**4. Never chain destructive cluster operations.**
If a deployment step fails (e.g. image not found), stop. Don't:
- Delete pods to force restart
- Reapply CRDs or manifests
- Rebuild other images
- Recreate the cluster
Each of these compounds the problem. Stop and ask the human.

**5. Never `kubectl cp` + `kill 1` to hot-reload code on a running pod.**
This is a more insidious form of hot-deploying. `kubectl cp` copies files into the
container's writable overlay layer, which vanishes on pod reschedule. The deployment
controller may replace the pod before you finish, leaving you thinking the fix is
applied when it isn't. Additionally:
- `kubectl cp` with a directory silently does nothing if the target exists (no error)
- Multiple replicas mean you never know which pod serves your request
- `kill 1` restarts the container but the copied files may not persist across restart
- The pod's image is baked from git — only commit/tag/push/CI produces consistent results

### The correct deploy flow

1. Commit code changes
2. Tag with the next semver: `git tag v0.X.Y && git push origin v0.X.Y`
3. CI builds images and pushes to ghcr.io automatically
4. When ready to deploy: `kubectl -n percussionist rollout restart deploy/<name>`
5. Verify: `kubectl -n percussionist rollout status deploy/<name>`

### If the cluster is down

- Tell the human. Include what you know: OOM, node not ready, API server down.
- Do NOT try to fix it. Cluster recovery is a human operation.
- The code changes are safe in git — they'll deploy when the cluster is back.

## Tailscale (Mobile HTTPS Access)

The web pod runs a Tailscale sidecar (`tailscale/tailscale:latest`) that provisions
a Let's Encrypt TLS certificate and proxies HTTPS to the web app on port 8080.

### Prerequisites (one-time)

1. **Tailscale account** at https://login.tailscale.com
2. **Enable HTTPS**: Admin Console → DNS → **HTTPS Certificates** → Enable
3. **Auth key**: Admin Console → Keys → **Generate auth key** (reusable, tag `percussionist`)

### Setup

```bash
# 1. Create the auth secret (replace key value)
kubectl delete secret tailscale-auth -n percussionist --ignore-not-found
kubectl create secret generic tailscale-auth -n percussionist \
  --from-literal=key=tskey-auth-xxxxx

# 2. Restart web pod to pick up the secret
kubectl -n percussionist rollout restart deploy/percussionist-web
kubectl -n percussionist rollout status deploy/percussionist-web

# 3. Verify the sidecar connected
kubectl -n percussionist logs deploy/percussionist-web -c tailscale --tail=10
# Expected output: "Tailscale IP: 100.x.x.x" and "HTTPS serve enabled"
```

### Access

Install Tailscale on your mobile device, log into the same tailnet, then open:

```
https://percussionist-web.<your-tailnet>.ts.net
```

### Sidecar details

- Defined in `k8s/deploy/web.yaml` under the `percussionist-web` Deployment
- Runs `tailscale serve --https=443 http://127.0.0.1:8080`
- State persisted in K8s Secret `tailscale-state-web`
- Userspace networking only (no kernel TUN required)
- Reuses the existing `percussionist-web` ServiceAccount (already has `secrets` RBAC)

### Troubleshooting

```bash
# Check sidecar logs
kubectl -n percussionist logs deploy/percussionist-web -c tailscale

# Verify Tailscale machine in admin console
# https://login.tailscale.com/admin/machines — look for "percussionist-web"

# If HTTPS serve fails: ensure HTTPS is enabled in Admin Console → DNS
# If auth fails: regenerate the auth key and update the secret, then restart the pod
```

### Common Issues & Fixes

#### Session Message Format
When processing OpenCode session messages, always use the correct nested structure:
- `msg.info.role` (not `msg.role`)
- `msg.parts[0].text` (not `msg.textContent`)

Incorrect access returns `undefined` and breaks message extraction. The dispatcher
and session-read MCP tools handle this correctly; agents calling `read_session_live`
receive properly structured messages regardless of the format.

#### SSE Reconnection Storms
If you see thousands of `[event] server.connected` logs in the dispatcher, the SSE
stream is closing immediately and reconnecting in a tight loop. This was fixed by
adding a 1-second backoff between all reconnection attempts (both success and error
paths) in `packages/dispatcher/src/polling.ts` lines 250 and 540.

**Symptoms:**
- Dispatcher logs flooded with `[event] server.connected` (35K+ events per run)
- High CPU/memory usage in run pods
- Pods being killed with exit 137 (SIGKILL) due to resource exhaustion

**Fix applied:** Added `if (!terminate) await sleep(1000);` after the SSE reader loop
completes to prevent runaway reconnections when OpenCode's `/event` endpoint closes
the stream prematurely.

#### Web Pod OOM When Viewing Large Sessions
The web server's `/api/runs/:name/session` endpoint loads all session messages into
memory at once via `fetchSessionMessages()` from the OpenCode API. For runs with large
session histories (thousands of messages), this can exceed the memory limit.

**Fix applied:** `fetchSessionMessages()` now reads the OpenCode response with a hard
20 MB cap before JSON parsing. If the live session is too large, the route falls back
to the dispatcher's ConfigMap snapshot, which is already truncated to fit the
ConfigMap budget. Do not raise the web pod memory limit to mask this issue.

**Longer-term improvement:** Implement pagination or streaming for session message
retrieval so large live sessions can be viewed incrementally instead of falling back
to a truncated snapshot.

## Tagging

Release tags follow `v<major>.<minor>.<patch>` semver format (e.g. `v0.15.0`).
CI triggers on any push matching `v*`.

**Do not guess tags.** Always derive from existing remote tags:

```bash
git fetch --tags origin
git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1V -k2,2V -k3,3V | tail -1
```

Start from that tag, increment the appropriate segment, create, and push:

```bash
git tag v0.15.1
git push origin v0.15.1
```

Never invent a version — read what exists and increment.

## Self-Development Workflow

Percussionist dogfoods itself for development using resources in `k8s/self-dev/`.
This directory is for maintainers only — external users should skip it.

### Meta-Agents (k8s/self-dev/agents/)

| Agent | Role |
|-------|------|
| `meta-reviewer` | Runs typecheck/build/tests and reviews code quality before integration |
| `meta-smoke-tester` | Builds Docker images via DinD and validates changes in an isolated test namespace |
| `meta-integrator` | Rebases and merges an approved feature branch into main, pushes to remote |
| `meta-documenter` | Updates README.md and AGENTS.md to reflect changes that landed on main |

### Project

`percussionist-dev` (in `k8s/self-dev/projects/`) is the self-development Project.
It uses a remote git mirror/worktree workflow — agents push to `agent/<task-name>`
branches and the integrator merges to main.

### Task Workflow

```
PLAN → BUILD → REVIEW → (SMOKE) → INTEGRATE → (DOCUMENT)
```

1. **PLAN** (`planner`) — Explores codebase, produces implementation plan, creates child BUILD tasks
2. **BUILD** (`builder`) — Implements changes on `agent/<task-name>` branch
3. **REVIEW** (`meta-reviewer`) — Typecheck, build, code quality gate
4. **SMOKE** (`meta-smoke-tester`) — Optional; build images + e2e in isolated namespace
5. **INTEGRATE** (`meta-integrator`) — Rebase-merge to main, push to remote
6. **DOCUMENT** (`meta-documenter`) — Optional; update docs post-merge

Setup instructions: `k8s/self-dev/secrets/README.md`

## Packages (dependency order)
1. `@percussionist/api` - Zod schemas, constants, type helpers
2. `@percussionist/kube` - Shared K8s client; depends on `api`
3. `@percussionist/operator` - Run reconciler; creates Pod/Service/Ingress/ConfigMap
4. `@percussionist/dispatcher` - Sidecar; session lifecycle, SSE streaming, analytics
5. `@percussionist/manager-controller` - Project board controller + embedded agent module (decision engine, MCP tools on :4097, chat handler on :4098, opencode-web sidecar on :4096)
6. `@percussionist/memory-service` - Per-project vector embedding server; REST API for storing, searching, and retrieving memories (Bun + sqlite-vec)
7. `@percussionist/web` - Hono + React dashboard; REST APIs, stats DB (SQLite via Drizzle)
8. `@percussionist/cli` - beatctl CLI; talks to K8s API directly (includes `chat` command)
