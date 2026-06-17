# Configuration

The `Project` CR is the top-level configuration object.

## Project Spec

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
  namespace: percussionist
spec:
  source:
    git:
      url: https://github.com/example/repo.git
    # OR:
    # local: true

  agents:
    - name: planner
    - name: builder
      model: anthropic/claude-sonnet-4
    - name: reviewer
    - name: buildgen

  maxParallel: 2

  phase: Active

  data:
    mountPath: /data

  gitCache:
    worktreeReuse: true

  featureBranchingEnabled: false

  codeServer:
    enabled: true

  embedding:
    enabled: true
    model: nomic-embed-text
    dimensions: 768

  runner:
    packages:
      - ripgrep
      - jq

  flow:
    preset: plan-build-review-merge
```

## Source

The `source` field determines how agent workspaces are configured.

### Remote Git

```yaml
source:
  git:
    url: https://github.com/example/repo.git
```

Creates a bare mirror at `/data/git-mirrors/{hash}/` and per-run worktrees at `/data/worktrees/{run-name}/`.

### Local Git

```yaml
source:
  local: true
```

Initializes a persistent local git workspace at `/data/workspace/`. No remote URL required.

## Agents

`agents` is an array of ClusterAgent references. Each entry has a `name` (matching the ClusterAgent CR name) and an optional `model` override.

```yaml
agents:
  - name: planner
  - name: builder
    model: anthropic/claude-sonnet-4
```

## Phase

| Value | Description |
|-------|-------------|
| `Active` | Project is live — tasks are scheduled and runs are created |
| `Complete` | Project goal achieved — no new tasks, existing work wraps up |
| `Archived` | Read-only — board is closed |

## Flow

Projects configure their task lifecycle via `spec.flow.preset`:

| Preset | Flow |
|--------|------|
| `simple` | Direct: scheduled → running → succeeded → done |
| `review` | Adds AI review step after completion |
| `plan-build` | PLAN→BUILD workflow without review |
| `plan-build-review-merge` | Full pipeline with PLAN→BUILD, review, and merge (default) |

Individual flow phases can be further configured:

```yaml
flow:
  preset: plan-build-review-merge
  plan:
    onApprove: generate-builds          # generate-builds | done
    defaultAgent: planner
  build:
    onSuccess: human-review             # human-review | ai-review | done
    onApprove: merge                    # merge | done
  review:
    aiReviewerEnabled: true
    maxAutoReworks: 2
  merge:
    mode: auto                          # auto | manual | disabled
```

## Data PVC

The data PVC is auto-created per project with a default 50Gi size and ReadWriteOnce access mode. ReadWriteMany (RWX) is available when your storage class supports it — override via the `data` fields in the Project CR.

PVC layout:

| Path | Purpose |
|------|---------|
| `/data/cache/pnpm/` | pnpm home and global bins |
| `/data/cache/pnpm-store/` | pnpm store directory |
| `/data/cache/npm/` | npm cache |
| `/data/cache/bun/` | bun install cache |
| `/data/git-mirrors/{hash}/` | bare git mirror |
| `/data/worktrees/{run-name}/` | per-run worktree |
| `/data/workspace/` | persistent local workspace |

## ClusterSettings (Cluster-Wide)

Cluster-wide defaults are set via the `ClusterSettings` CR (singleton, name must be `default`):

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: ClusterSettings
metadata:
  name: default
spec:
  runnerImage: ghcr.io/erkkaha/percussionist/runner:latest
  runTTLDays: 7
```

## Next

- [Features](/features/git-workspace) — deep dives into each feature
- [Task Lifecycle](/reference/task-lifecycle) — task state machine
