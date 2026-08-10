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
    local: true  # or source.git
  codeServer:
    enabled: true
    # Optional: persistent human repo folder on the data PVC — a clone of the
    # project repo checked out on the project default branch (spec.source.git.ref),
    # opened by default in code-server. Defaults resolve to name "code", branch
    # = spec.source.git.ref, remote = spec.source.git.url (source.git only;
    # without a remote URL the folder bootstraps as an empty git repo).
    humanFolder:
      enabled: true
      # Optional overrides:
      # name: code
      # branch: main
      # remoteUrl: git@github.com:example/repo.git
    # Optional overrides:
    # image: codercom/code-server:4.96.4
    # resources:
    #   requests: { cpu: "100m", memory: "256Mi" }
    #   limits: { memory: "512Mi" }
```

## Access

```bash
kubectl -n percussionist port-forward svc/ide-my-project 8080:8080
# Open http://localhost:8080
```

With `PERCUSSIONIST_INGRESS_BASE_URL` set on the operator, each project also
gets an Ingress at `ide-{project}.<base host>`.

### Dashboard links

The web UI resolves IDE links from `ClusterSettings.spec.codeServerUrlTemplate`
(a URL with a `{project}` placeholder, editable under Settings → Runner):

```yaml
spec:
  codeServerUrlTemplate: https://ide-{project}.10.0.0.1.nip.io
```

When unset, the UI falls back to replacing the first label of the dashboard
hostname with `ide-{project}` — which only works when the IDE ingresses are
siblings of the dashboard's own domain.

## Workspace Layout

The code-server mounts the project's data PVC at `/data`, giving access to:

| Path | Content |
|------|---------|
| `/data/code/` | Human repo clone on project default branch (when `humanFolder` enabled) |
| `/data/worktrees/{run-name}/` | Per-run git worktrees (remote git) |
| `/data/workspace/` | Persistent workspace (local git) |
| `/data/git-mirrors/` | Bare git mirrors |
| `/data/cache/` | Package manager caches |

When `humanFolder` is enabled, `/data/code/` is a clone of the project repo
checked out on the project default branch (`spec.source.git.ref`). `git push`
from the human folder requires the human's own credentials: the project's deploy
key (`source.git.sshSecret`) is mounted in the code-server init container (for
the clone) only — it is never exposed in the main code-server container, which
runs with `auth: none`.

## Requirements

`source.git` or `source.local` must be set (needs a data PVC).

## Resources

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | — |
| Memory | 256Mi | 512Mi |
