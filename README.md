# percussionist

Kubernetes-native orchestration for [OpenCode](https://opencode.ai) agents.
Each agent run is a Pod; you attach to it on demand with `opencode attach`.

> **Status:** M3 — `beatctl` CLI on top of the M2 operator. M1 (single
> hand-rolled pod) and M2 (CRD + operator + dispatcher) both still work.

## Repo layout

```
.
├── crds/               # OpenCodeRun CustomResourceDefinition (v1alpha1)
├── deploy/             # Operator Deployment + RBAC
├── examples/           # Sample OpenCodeRun manifests
├── images/
│   ├── runner/         # opencode + git + ssh on Alpine (used by every run pod)
│   └── node/           # Shared Node 22 image; builds operator + dispatcher
├── manifests/          # Raw k8s manifests for M1 smoke
├── packages/
│   ├── api/            # Shared Zod schemas, constants, type helpers
│   ├── operator/       # CRD reconciler (informer + reconciler loop)
│   ├── dispatcher/     # Sidecar that drives each run via the opencode HTTP API
│   └── cli/            # beatctl — user-facing CLI (M3)
└── scripts/            # Smoke tests + minikube image loader
```

Planned (M4+): `e2e/` automated end-to-end suite.

## M1: smoke test

Goal: prove `opencode serve` runs in a Kubernetes pod and that you can drop
into its TUI from your laptop with `opencode attach`.

### Prerequisites

- `kubectl` pointed at a cluster you control (ideally homelab k3s)
- `docker` locally to build the runner image
- `opencode` CLI on your laptop (for `opencode attach`)
- At least one provider API key exported as an env var
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...)

### 1. Build the runner image

```sh
docker build -t percussionist/runner:dev images/runner
```

### 2. Make the image available to the cluster

Pick the one that matches your setup:

- **minikube** — one-shot build + load:
  ```sh
  ./scripts/minikube-load.sh
  ```
  (Re-run after any change to `images/runner/Dockerfile`; `--overwrite` is used.)
- **Docker Desktop Kubernetes** — nothing to do, the daemon is shared.
- **k3s (homelab)** — import into containerd:
  ```sh
  docker save percussionist/runner:dev | sudo k3s ctr images import -
  ```
- **kind** — `kind load docker-image percussionist/runner:dev`
- **Remote cluster** — push to a registry and run the smoke with
  `IMAGE=ghcr.io/you/runner:tag ./scripts/m1-smoke.sh`

### 3. Run the smoke

```sh
export ANTHROPIC_API_KEY=sk-ant-...
./scripts/m1-smoke.sh
```

The script:

1. Verifies the current `kubectl` context (warns if it looks like a non-local cluster).
2. Creates the `percussionist-m1` namespace.
3. Creates two Secrets (auth password + LLM keys) from your env.
4. Applies `manifests/m1-smoke.yaml` (Pod + Service).
5. Waits for the pod to become Ready.
6. Starts `kubectl port-forward svc/opencode-smoke 4096:4096` in the foreground
   and prints the `opencode attach` command.

### 4. Attach from another terminal

The script prints the exact command; it looks like:

```sh
export OPENCODE_SERVER_PASSWORD='<generated-or-your-value>'
opencode attach http://localhost:4096
```

You should drop straight into a TUI backed by the pod. Send a prompt; the
workspace lives at `/workspace` inside the pod (empty `emptyDir` for M1).

### 5. Tear down

```sh
./scripts/m1-smoke.sh --down
```

Deletes the `percussionist-m1` namespace and everything in it.

## M1 exit criteria

- [x] Runner image builds and `opencode serve` responds on `/global/health`.
- [ ] Pod reaches Ready in a real cluster.
- [ ] `opencode attach` from laptop yields a working TUI.
- [ ] A prompt executes end-to-end inside the pod.

Once all four are checked, we move to **M2**: `OpenCodeRun` CRD + operator +
dispatcher sidecar that drives sessions via the SDK and pushes branches on
completion.

## M2: CRD + operator + dispatcher

Goal: declaratively launch opencode runs by creating an `OpenCodeRun` custom
resource. The operator reconciles each CR into a Secret + Service + Pod, and a
dispatcher sidecar inside the Pod creates an opencode session, submits the
configured prompt, and writes lifecycle info back to `.status`.

### Architecture at a glance

```
  OpenCodeRun (CR)
        │
        ▼  watched by
  ┌──────────────┐        creates / owns       ┌─────────────────────────┐
  │   operator   │ ──────────────────────────► │  Secret   (auth pwd)    │
  │ (Deployment) │                             │  Service  (ClusterIP)   │
  └──────────────┘                             │  Pod                    │
                                               │   ├─ runner   (opencode)│
                                               │   └─ dispatcher (sidecar)
                                               └──────────┬──────────────┘
                                                          │ patches
                                                          ▼
                                                    .status subresource
```

- **runner** container: `percussionist/runner:dev`, runs `opencode serve` on
  `:4096`, password-protected via `OPENCODE_SERVER_PASSWORD`.
- **dispatcher** container: waits for the runner's health endpoint, creates a
  session, `POST /session/:id/prompt_async`, polls `/session/:id/message` for
  the last assistant message's `time.completed`, then patches the CR status to
  `Succeeded` (or `Failed` on error) and exits.
- **operator** watches `OpenCodeRun` resources via a hand-rolled informer
  (there's no kubebuilder for TypeScript), creates child objects with
  `ownerReferences`, and mirrors Pod phase into the CR status every 10s.

### Prerequisites

Everything from M1, plus:

- `pnpm` (Node workspace) and Node 22
- A running cluster with the `percussionist` namespace available (the deploy
  manifest creates it for you)

### 1. Build and load all three images

```sh
./scripts/minikube-load.sh
```

Builds `runner`, `operator`, `dispatcher` and loads them into minikube. On
other clusters see the M1 section for alternatives.

When you change code and a pod is still pinning the old image, minikube's
plain `image load` silently no-ops. The script warns you when that happens;
pass `--force` to have it fix things for you:

```sh
./scripts/minikube-load.sh --only dispatcher --force          # interactive
./scripts/minikube-load.sh --force --yes                       # CI / scripts
```

`--force` does three things:

1. `docker build --no-cache` for the rebuilt images (ensures changes in
   workspace packages actually land in the image — plain rebuilds can
   reuse a cached build stage with stale sources).
2. Finds anything inside minikube pinning the old image ID and evicts it:
   scales `deploy/percussionist-operator` to 0 for the operator image, or
   deletes any `OpenCodeRun` whose pods are using the runner / dispatcher
   image.
3. Runs `minikube image rm` before the fresh `load` so the new ID actually
   sticks.

Without `--yes` the script prompts before deleting any `OpenCodeRun`.

### 2. Install the CRD, RBAC, and operator

```sh
kubectl apply -f crds/opencoderun.yaml
kubectl apply -f deploy/operator.yaml
kubectl -n percussionist rollout status deploy/percussionist-operator
```

### 3. Submit a run

The sample run uses opencode's bundled Zen provider (`big-pickle`), which
needs no API key — handy for smoke-testing without burning real credits.

```sh
kubectl apply -f examples/hello-run.yaml
kubectl get opencoderun -n percussionist -w
```

Typical lifecycle (elapsed ~5–10s on a warm node):

```
NAME    PHASE       SESSION ID               TOKENS IN   TOKENS OUT
hello   Pending
hello   Running     ses_250d3c2afffe...              0           0
hello   Succeeded   ses_250d3c2afffe...             65          85
```

Inspect `.status` for `startedAt`, `completedAt`, `message`, and the
generated `podName` / `serviceName`.

### 4. Attach while a run is live

Runs expose the same Service shape as M1, so `opencode attach` still works:

```sh
kubectl -n percussionist port-forward svc/hello 4096:4096 &
export OPENCODE_SERVER_PASSWORD="$(kubectl -n percussionist get secret hello-auth \
  -o jsonpath='{.data.OPENCODE_SERVER_PASSWORD}' | base64 -d)"
opencode attach http://localhost:4096
```

### 5. One-shot smoke

```sh
./scripts/m2-smoke.sh           # apply + wait for Succeeded
./scripts/m2-smoke.sh --down    # cleanup
```

## M2 exit criteria

- [x] `OpenCodeRun` CRD installed and validated by the apiserver.
- [x] Operator reconciles CR → Secret + Service + Pod with owner refs.
- [x] Dispatcher creates a session and dispatches the configured prompt.
- [x] Dispatcher detects completion and patches status to `Succeeded` with
      token counts and timestamps.
- [x] Deleting the CR garbage-collects all child objects.

Next up — **M3:** `beatctl` CLI (`submit`, `ls`, `attach`, `logs`, `cancel`)
so you never have to touch `kubectl` for routine use.

## M3: `beatctl` CLI

`beatctl` is a user-facing CLI that replaces raw `kubectl` for the common
percussionist workflows. It reuses your existing kubeconfig (same rules as
kubectl: `KUBECONFIG`, then `~/.kube/config`), so it picks up whatever cluster
/ context / namespace you've already set up.

### Run it during development

```sh
pnpm beatctl --help
# or equivalently:
pnpm --filter @percussionist/cli exec tsx src/index.ts --help
```

Install globally (after `pnpm -r build`):

```sh
pnpm --filter @percussionist/cli build
pnpm link --global --filter @percussionist/cli
beatctl --help
```

### Commands

| Command                        | What it does                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `beatctl submit -t "<task>"`   | Create an `OpenCodeRun` with an inline task prompt.                          |
| `beatctl submit -i`            | Interactive run — no automatic prompt; keeps the runner alive for `beatctl attach`. |
| `beatctl submit ... -a`        | `--attach`: after submit, poll until `Running` and hand off to attach in one shot. Great combined with `-i`. |
| `beatctl submit -f run.yaml`   | Create from a YAML file (CLI flags still override name / namespace).         |
| `beatctl ls`                   | Table of runs with phase, session ID, running token totals, age.             |
| `beatctl get <name>`           | Detailed view of a single run (also `-o yaml` / `-o json`).                  |
| `beatctl logs <name> [-f]`     | Stream container logs. `-c dispatcher` to watch the sidecar instead.         |
| `beatctl attach <name>`        | Start a `kubectl port-forward` to the run's Service and launch `opencode attach` with the right basic-auth password loaded from the auth Secret. Port-forward is torn down automatically on exit. |
| `beatctl cancel <name>`        | Delete the run (cascades to its Pod/Service/Secret via `ownerReferences`).   |

Global conventions:

- `-n, --namespace <ns>` on every command, defaulting to `percussionist` (or
  `$PERCUSSIONIST_NAMESPACE`).
- `submit` without `--name` generates a short timestamp-based name so you can
  spam submissions without thinking about uniqueness.
- `attach` picks a random free local port unless you pass `--local-port`.

### Example end-to-end

```sh
beatctl submit --task "say hello briefly" --name hello
beatctl ls
# NAME   PHASE    SESSION                 TOK-IN  TOK-OUT  AGE
# hello  Running  ses_250c...              0       0        3s
beatctl logs hello -c dispatcher -f
beatctl cancel hello
```

### One-shot interactive shell

For exploratory work, skip writing a task and drop straight into a TUI
backed by a fresh pod:

```sh
beatctl submit -i -a --name scratch
# creates OpenCodeRun scratch, waits for Running, then `opencode attach`s
# into it. When you exit the TUI, run `beatctl cancel scratch` to tear
# down the pod (interactive runs stay Running until cancelled or timed
# out).
```

## M3 exit criteria

- [x] `submit` creates an `OpenCodeRun` from inline flags or a YAML file.
- [x] `ls` / `get` show run state with token totals.
- [x] `logs` streams pod logs, selecting runner or dispatcher container.
- [x] `attach` forwards the Service port, reads the auth Secret, and launches
      `opencode attach` with the correct credentials; cleans up port-forward
      on exit.
- [x] `cancel` deletes the CR and cascades to all child objects.

## M4: git workspace source

Point a run at a repo and the operator clones it into `/workspace` before
the agent starts. The runner's working directory is `/workspace`, so tools
that list files, read sources, run `git`, etc. all just work.

```yaml
spec:
  task: "Find the entry point and summarise what it does."
  source:
    git:
      url: https://github.com/octocat/Hello-World.git
      # ref: main     # optional; omitted = remote HEAD (default branch)
```

How it works:

- The operator injects an init container using the runner image (it already
  has git + openssh). It clones into a shared `emptyDir` mounted at
  `/workspace` on the runner, then exits.
- Ref handling: omitted ⇒ default branch, `--depth=1`. Branch or tag ⇒
  `--depth=1 --branch <ref>`. Full SHA (7–40 hex chars) ⇒ full clone +
  `git checkout --detach <sha>` (shallow fetch by SHA isn't portable).
- Private repos: reference a Secret containing an SSH key. The file is
  mounted read-only at `/etc/git-ssh/id` (mode 0400) and `GIT_SSH_COMMAND`
  is set to use it with `StrictHostKeyChecking=no` (homelab default; tighten
  for production).

```bash
kubectl create secret generic agent-key \
  --type=kubernetes.io/ssh-auth \
  --from-file=ssh-privatekey=$HOME/.ssh/id_ed25519 \
  -n percussionist
```

```yaml
spec:
  source:
    git:
      url: git@github.com:you/private-repo.git
      ref: main
      sshSecret:
        name: agent-key
        # key: ssh-privatekey   # default; override only if your secret differs
```

No push-back is implemented yet — the agent can read and modify files, but
changes live only in the pod's `/workspace` until the pod is deleted. A
later milestone will add `spec.source.git.pushRef` plus a post-run hook.

Try it:

```bash
kubectl apply -f examples/git-run.yaml
pnpm beatctl get git-demo
```

## M4 exit criteria

- [x] `spec.source.git.url` triggers an init-container clone before the runner
      starts; runner `workingDir` is `/workspace`.
- [x] `ref` supports branches, tags, and full commit SHAs; omitted falls back
      to the remote default branch.
- [x] `sshSecret` mounts an SSH private key for private-repo auth.
- [x] Init-container failures (bad URL, wrong ref, missing key) surface as
      `Pod.Failed` and propagate to `RunPhase.Failed` via the operator's
      pod-phase mirror.
