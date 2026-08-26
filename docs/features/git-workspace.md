# Git Workspace

Percussionist supports two git workspace modes: remote git with mirror/worktree isolation, and local git for persistent incremental development.

## Remote Git (`source.git`)

Each run gets its own isolated git worktree, eliminating conflicts between concurrent agents.

### How it works

1. **First run:** Clones a bare mirror to `/data/git-mirrors/{url-hash}/`, then creates a worktree at `/data/worktrees/{run-name}/`
2. **Subsequent runs:** `git fetch` updates the mirror — both `refs/heads/*` (into `refs/remotes/origin/*`) and the namespaced `refs/percussionist/*` worker branches. Namespaced refs are promoted into the mirror's `refs/heads` fast-forward-only, so a fresh mirror can reconstruct in-flight branches without ever clobbering local work. Worktree is reused by default (`gitCache.worktreeReuse: true`)
3. **Push capability:** `remote set-url` restores the real remote URL after mirror-based setup, so agents can push commits

### Remote durability of in-flight branches

On worker-run completion (`complete_run`/`complete_plan`) the dispatcher pushes
the branch to `refs/percussionist/<branch>` on the real remote — invisible in
the GitHub branch UI and not fetched by normal clones. This makes the remote
the durable copy of unmerged work, so review/merge/child runs can rebuild it
into any mirror. The push is best-effort: on failure the run completes with a
warning in its summary and the mirror-only behavior remains. The namespaced
ref is deleted when the task reaches `done`. Runs that never reach `done`
(TTL-expired) may leave a stale namespaced ref behind — harmless and invisible;
remote GC for that path is a known follow-up.

### Concurrency safety

Mirror fetches are serialized with `flock` so parallel runs don't corrupt the bare repo.

### Worktree cleanup

- Pod init container prunes stale worktrees on startup via `git worktree prune`
- A cleanup pod spawns when a task reaches `done` to remove all worker, review, buildgen, and merge worktrees for that task
- Deleting a Run's git-sourced worktree is triggered off Run deletion — TTL expiry, `kubectl delete run`, dashboard delete, or the manager's `delete_run` — via a `batch/v1` Job (not a bare Pod), so it isn't limited to the TTL path
- The TTL controller expires a Run using its own `spec.ttlSecondsAfterFinished` when set, otherwise falling back to the cluster-wide `runTTLDays` default

## Local Git (`source.local: true`)

For projects that don't need a remote, or for local-only experimentation.

### How it works

- Workspace initialized with `git init` + empty commit on first use
- Persists across runs at `/data/workspace/`
- Agent commits accumulate in the workspace
- No remote URL required

## Configuration

```yaml
spec:
  source:
    git:
      url: https://github.com/example/repo.git
  gitCache:
    worktreeReuse: true    # default: true
```

Set `worktreeReuse: false` to always start from a clean checkout.
