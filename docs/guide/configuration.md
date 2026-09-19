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
| `review` | Adds a human review step after completion — no AI review |
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
  integration:
    mode: auto-merge                    # auto-merge | pr | manual | disabled
```

The `integration` block controls how a PLAN's feature branch lands on the target
branch (`project.spec.source.git.ref ?? "main"` by default) when
`featureBranchingEnabled: true`:

| Mode | Behavior |
|------|----------|
| `auto-merge` (default) | A merge run merges the feature branch directly to the target branch. No human in the loop. |
| `pr` | A short-lived run opens a GitHub PR from the feature branch to the target. The manager polls the PR state (15-minute cache interval) and auto-transitions the task to `done` when the PR is merged. If the PR is closed without merging, the task goes to `awaiting-human`. Requires `source.git.githubTokenSecret` to be configured so the manager can read the PR state via the GitHub API. Detection latency is up to 15 minutes after merge. |
| `manual` | The task parks in `awaiting-human`; a human merges the feature branch to the target entirely outside the system, then marks the task done in Percussionist. |
| `disabled` | No integration merge; the task goes to `done` once all BUILD children are done. |

Branch retention depends on the mode: branches pushed to the remote (e.g. the feature branch in `pr` mode) are kept indefinitely, while in `auto-merge`/`manual` mode the feature-branch ref lives only in the local bare mirror and is deleted from it when the task reaches `done`.

## Data PVC

The data PVC is auto-created per project with a default 50Gi size and ReadWriteOnce access mode. ReadWriteMany (RWX) is available when your storage class supports it — the PVC name, mount path, and storage class are overridable per project or run via the `data` fields in the CR (`pvcName`, `mountPath`, `storageClass`). The access mode and size are operator environment overrides (`DEFAULT_STORAGE_ACCESS_MODE`, `DEFAULT_STORAGE_SIZE`, `DEFAULT_STORAGE_CLASS`) applied when the data PVC is created.

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
  runner:
    image: ghcr.io/erkkaha/percussionist/runner:latest
  runTTLDays: 7
```

## ConfigMap Ownership

The operator is the **authoritative writer** of two ConfigMaps in the
`percussionist` namespace:

| ConfigMap | Consumer | Content |
|---|---|---|
| `agent-config` | manager's embedded OpenCode host (`OPENCODE_CONFIG_CONTENT` on the manager container) | `opencode.json` (provider, model, MCP, skills) + `manager-decision.md` |
| `opencode-config` | every run pod (`OPENCODE_CONFIG_CONTENT`) | `opencode.json` with the dispatcher MCP stanza injected |

Both are rendered from `ClusterSettings` and written with **server-side apply**
under `fieldManager="percussionist-operator"` with `force=true`. That makes the
operator the owner of the `data` keys regardless of who wrote them before.

**Do not manage the `data` keys of these ConfigMaps from Flux, `kubectl apply`,
`beatctl deploy`, a kustomize overlay, or any other writer.** A foreign writer
takes field ownership and, because it changes the object without changing
`ClusterSettings`, would otherwise win permanently: the operator's
`ClusterSettings` informer never fires. The operator now defends against that
with three triggers:

1. the `ClusterSettings` informer (add/update), as before;
2. a **ConfigMap informer** on the two owned ConfigMaps, so drift is reverted
   immediately;
3. a **periodic resync** — `PERCUSSIONIST_CLUSTER_SETTINGS_RESYNC_INTERVAL_MS`,
   default `300000` (5 minutes), `0` disables it.

Before every write the operator reads the live ConfigMap and skips the write
when the data already matches, so steady state produces no `resourceVersion`
churn and no log lines. Each corrective write logs one line naming the
ConfigMap and the previous field manager, e.g.:

```
corrected ConfigMap percussionist/agent-config (previous field manager: kustomize-controller)
```

### Sidecar Rollout

The manager's embedded OpenCode host reads `OPENCODE_CONFIG_CONTENT` from a
`configMapKeyRef` **once at container start**, so a corrected `agent-config` only
takes effect after the manager pod restarts. When the rendered `agent-config`
content changes, the operator stamps the manager Deployment's pod template with
`percussionist.dev/agent-config-hash` (a hash of the data). Adjusting that
annotation rolls the pod; an unchanged hash is a no-op, so the periodic resync
never restarts the manager for nothing.

### GitOps / Flux

Flux's kustomize-controller also applies `k8s/deploy/agent-config.yaml` from the
manifests artifact every reconcile. Without a guard it would reclaim the `data`
keys and revert the operator on its own schedule. The shipped manifest therefore
carries:

```yaml
metadata:
  annotations:
    kustomize.toolkit.fluxcd.io/ssa: IfNotPresent
```

which tells kustomize-controller to create the ConfigMap only when absent and
otherwise leave it alone. If you maintain your own overlay, keep this
annotation on `agent-config` and do not set its `data` keys.

## Run Timeout

Each `Run` CR has a per-run deadline: `spec.timeoutSeconds` (default `3600`, i.e. 1 hour). The operator sets the run pod's `activeDeadlineSeconds` from this value and injects it into the dispatcher as the `RUN_TIMEOUT_SECONDS` environment variable.

The dispatcher's hard-timeout guard derives its deadline from `RUN_TIMEOUT_SECONDS` and fires 60 s **before** the pod's `activeDeadlineSeconds` (grace period), so on expiry it fails the run gracefully — session snapshot → stats → `Failed` status patch — rather than exiting abruptly and racing the kubelet's SIGTERM/SIGKILL. When the env is missing or invalid (local runs, tests), it falls back to the legacy 65-minute hard timeout.

## Next

- [Features](/features/git-workspace) — deep dives into each feature
- [Task Lifecycle](/reference/task-lifecycle) — task state machine
