# Git Workspace

Percussionist supports two git workspace modes: remote git with mirror/worktree isolation, and local git for persistent incremental development.

## Remote Git (`source.git`)

Each run gets its own isolated git worktree, eliminating conflicts between concurrent agents.

### How it works

1. **First run:** Clones a bare mirror to `/data/git-mirrors/{url-hash}/`, then creates a worktree at `/data/worktrees/{run-name}/`
2. **Subsequent runs:** `git fetch` updates the mirror. Worktree is reused by default (`gitCache.worktreeReuse: true`)
3. **Push capability:** `remote set-url` restores the real remote URL after mirror-based setup, so agents can push commits

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
