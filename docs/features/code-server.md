# Code Server

Projects can enable an opt-in code-server instance for interactive VS Code access to the workspace.

## Enable

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Project
metadata:
  name: my-project
spec:
  source:
    local: true
  codeServer:
    enabled: true
    # Optional overrides:
    # image: codercom/code-server:4.96.4
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

## Access

```bash
kubectl -n percussionist port-forward svc/code-server-my-project 8080:8080
# Open http://localhost:8080
```

## Workspace Layout

The code-server mounts the project's data PVC at `/data`, giving access to:

| Path | Content |
|------|---------|
| `/data/worktrees/{run-name}/` | Per-run git worktrees (remote git) |
| `/data/workspace/` | Persistent workspace (local git) |
| `/data/git-mirrors/` | Bare git mirrors |
| `/data/cache/` | Package manager caches |

## Requirements

`source.git` or `source.local` must be set (needs a data PVC).

## Resources

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | — |
| Memory | 256Mi | 512Mi |
