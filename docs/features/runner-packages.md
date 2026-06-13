# Runner Packages

Projects can declare Alpine Linux packages to install in every run pod via `spec.runner.packages`. These are installed at pod initialization time in the workspace-init container through `apk add`.

## Enable

```yaml
spec:
  runner:
    packages:
      - ripgrep
      - jq
      - tree
      - postgresql-client
```

## How it Works

1. The workspace-init container runs `apk update --quiet && apk add --no-cache <packages>` before git mirror fetch or worktree setup
2. The runner pod starts with all declared packages available via `$PATH`
3. The manager injects the package list into the agent prompt as `AVAILABLE SYSTEM TOOLS:` so agents know what's available without manual discovery
4. Per-run override: `spec.runner.packages` on a Run CR overrides the project defaults

## Base Image

Packages are installed on top of the runner image (`ghcr.io/erkkaha/percussionist/runner:latest`). The base image always includes:

- git
- openssh
- node
- npm
- bash
- curl
- unzip
- github-cli
