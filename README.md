# percussionist

Kubernetes-native orchestration for [OpenCode](https://opencode.ai) agents.
Each agent run is a first-class Kubernetes resource — declarative, observable,
and scriptable from CI. Attach to a live run with `opencode attach` any time.

## Features

- **Declarative runs** — create an `OpenCodeRun` CR; the operator handles pod
  scheduling, auth secrets, service routing, and lifecycle mirroring.
- **Git workspaces** — clone any repo into `/workspace` before the agent starts,
  with branch/tag/SHA resolution and SSH key support.
- **Project boards** — each `OpenCodeProject` carries an embedded kanban-style
  board: parallel worker dispatch, automatic retries, human-in-the-loop review,
  and rework. The manager controller drives task execution from the board.
- **ClusterAgents** — cluster-scoped agent role definitions reusable across
  projects and runs; referenced by name rather than inlined per-run.
- **Web dashboard** — real-time run table, project/board views, agent catalog,
  and historical session analytics.
- **`beatctl` CLI** — submit, watch, attach, and cancel runs without touching
  `kubectl`.
- **Provider auth** — OAuth tokens (GitHub Copilot, ChatGPT Plus, Claude Pro)
  imported once and shared cluster-wide via Kubernetes Secrets.

## Repo layout

```
.
├── crds/               # CustomResourceDefinitions (v1alpha1)
│   ├── opencoderun.yaml
│   ├── opencodeproject.yaml
│   └── clusteragent.yaml
├── deploy/             # Kubernetes Deployment + RBAC manifests
│   ├── operator.yaml
│   ├── manager-controller.yaml
│   └── web.yaml
├── examples/           # Sample OpenCodeProject and OpenCodeRun manifests
├── images/
│   ├── runner/         # opencode + git + ssh on Alpine (used by every run pod)
│   ├── node/           # Shared Node 24 image; builds operator + dispatcher + manager
│   └── web/            # Bun image; builds + serves the web dashboard
├── manifests/          # Raw k8s manifests for standalone smoke testing
├── packages/
│   ├── api/            # Shared Zod schemas, constants, type helpers
│   ├── operator/       # CRD reconciler (informer + reconciler loop)
│   ├── dispatcher/     # Sidecar that drives each run via the opencode HTTP API
│   ├── cli/            # beatctl — user-facing CLI
│   ├── web/            # Dashboard SPA + Hono server + bun:sqlite stats DB
│   └── manager-controller/  # Watches OpenCodeProject CRs, drives the embedded board
└── scripts/            # Cluster image loader + smoke test helpers
```

## Prerequisites

- `kubectl` pointed at a cluster you control (minikube, k3s, kind, or remote)
- `docker` to build images locally
- `pnpm` and Node 24 for the TypeScript workspace
- `opencode` CLI on your workstation (for `opencode attach`)
- At least one provider API key or OAuth token (see [Provider auth](#provider-auth))

## Getting started

### 1. Build and load all images

```sh
./scripts/minikube-load.sh
```

Builds `runner`, `operator`, `dispatcher`, `web`, and `manager` images and loads
them into minikube. For other cluster types:

| Cluster | How to make images available |
|---------|------------------------------|
| **minikube** | `./scripts/minikube-load.sh` (handles build + load) |
| **Docker Desktop** | Nothing — the daemon is shared |
| **k3s** | `docker save percussionist/runner:dev \| sudo k3s ctr images import -` |
| **kind** | `kind load docker-image percussionist/runner:dev` |
| **Remote** | Push to a registry; set `RUNNER_IMAGE_DEFAULT` on the operator Deployment |

When you change code and a pod is still pinning the old image, minikube's
plain `image load` silently no-ops. Pass `--force` to evict stale pods and
force a clean reload:

```sh
./scripts/minikube-load.sh --only dispatcher --force   # interactive
./scripts/minikube-load.sh --force --yes                # CI / scripts
```

`--force` does three things: rebuilds with `--no-cache`, evicts pods pinning
the old image ID, and runs `minikube image rm` before the fresh load.

### 2. Deploy CRDs + operator + web

```sh
beatctl deploy
```

Installs all three CRDs, the operator, manager controller, and web dashboard,
then waits for rollouts to complete. Equivalent manual flow:

```sh
kubectl apply -f crds/opencoderun.yaml
kubectl apply -f crds/opencodeproject.yaml
kubectl apply -f crds/clusteragent.yaml
kubectl apply -f deploy/operator.yaml
kubectl apply -f deploy/manager-controller.yaml
kubectl apply -f deploy/web.yaml
kubectl -n percussionist rollout status deploy/percussionist-operator
kubectl -n percussionist rollout status deploy/percussionist-manager
kubectl -n percussionist rollout status deploy/percussionist-web
```

To uninstall everything:

```sh
beatctl deploy --down
```

### 3. Submit a run

```sh
beatctl submit --task "say hello briefly" --project my-project --name hello
beatctl ls
# NAME   PHASE    SESSION                 TOK-IN  TOK-OUT  AGE
# hello  Running  ses_250c...              0       0        3s
beatctl logs hello -f
```

Typical lifecycle (elapsed ~5–10 s on a warm node):

```
NAME    PHASE            SESSION ID               TOKENS IN   TOKENS OUT
hello   Pending
hello   Running          ses_250d3c2afffe...              0           0
hello   Succeeded        ses_250d3c2afffe...             65          85

A run in `WaitingForInput` means the agent needs human clarification.
Reply from the dashboard or via `beatctl submit --attach`.
```

### 4. Attach to a live run

```sh
beatctl attach hello
```

Forwards the run's Service port, reads the auth Secret, and drops you into the
opencode TUI. Port-forward is torn down automatically on exit.

Or combine submit + attach in one step:

```sh
beatctl submit -i -a --name scratch --project my-project
# creates the run, waits for Running, then attaches
```

### 5. Tear down

```sh
beatctl cancel hello        # deletes the CR and all owned resources
beatctl deploy --down       # removes the operator, CRDs, and web dashboard
```

## Architecture

### OpenCodeRun

```mermaid
flowchart TD
    CR[OpenCodeRun CR]

    CR -->|watched by| OP[operator\nDeployment]

    OP -->|creates / owns| SEC[Secret\nauth pwd]
    OP -->|creates / owns| SVC[Service\nClusterIP]
    OP -->|creates / owns| POD[Pod]
    OP -->|creates / owns\nif spec.agents set| AGCM[ConfigMap\nagents]
    OP -->|creates / owns\nif INGRESS_BASE_URL set| ING[Ingress\nper-run web URL]
    OP -->|mirrors pod phase\nevery 10 s| CR

    POD --> INIT[git-clone init container\nif spec.source.git set]
    POD --> OC[opencode container\nopencode web :4096]
    POD --> DISP[dispatcher container\nsidecar]

    AGCM -->|volume mount\n/root/.config/opencode/agents| OC
    ING -->|routes| SVC
    SVC -->|ClusterIP :4096| OC

    DISP -->|HTTP 127.0.0.1:4096| OC
    DISP -->|patches| STATUS[CR .status subresource]
```

- **opencode container** runs `opencode web` on `:4096`. Network-isolated by
  default; exposed via per-run Ingress when configured.
- **dispatcher container** waits for the runner's health endpoint, creates a
  session, fires `POST /session/:id/prompt_async`, then concurrently polls
  `/session/:id/message` and consumes the SSE `/event` stream for low-latency
  token updates. Once the last assistant message's `time.completed` is set it
  patches the CR to `Succeeded` (or `Failed` on error) and exits. A 1-hour
  hard timeout guard exits with code 3 if the run stalls indefinitely.
- **operator** uses a hand-rolled informer (no kubebuilder for TypeScript),
  creates child objects with `ownerReferences` for cascading deletion, and
  mirrors Pod phase into the CR status every 10 s.

### OpenCodeProject + Board

```mermaid
flowchart TD
    PCR[OpenCodeProject CR\nwith embedded board]

    PCR -->|watched by| MGR[manager\nDeployment]

    MGR -->|pulls ready tasks\nup to maxParallel|MGR
    MGR -->|creates worker CRs| WRK[OpenCodeRun\nworker CR]
    MGR -->|reads worker status| WRK
    MGR -->|patches board state| PCR

    WRK --> POD[Pod\noperator-managed]

    COLS["Column flow\nready → in-progress → review → rework → done"]
    MGR -->|moves task IDs\nacross columns| COLS

    AGENT[ClusterAgent CR\nclassic role definitions] -->|resolved by operator|MGR
```

- **Projects** are the canonical home for environment config (git, secrets, model,
  image, resources). Every run and board worker inherits from its project.
- The **embedded board** (`spec.board`) defines a task backlog with columns, a team
  roster of ClusterAgents, a WIP limit (`maxParallel`), and optional overrides for
  worker run defaults.
- **The manager controller** reconciles projects in a continuous loop: pulls ready tasks
  up to `maxParallel`, monitors active workers (polling OpenCodeRun status), retries
  failed tasks (up to 3 retries), escalates when exhausted, and re-dispatches rework
  tasks with feedback context.
- **Worker runs** are `OpenCodeRun` CRs created by the manager; they reference their
  parent project via `spec.project` for provenance and config resolution.

### ClusterAgent

```mermaid
flowchart LR
    CA[ClusterAgent CR\ncluster-scoped] -->|content served at reconcile| OP[operator]
    OP -->|mounts as ConfigMap| POD[run pod]

    BOARD[project board.agents[]] -->|references by name| CA
```

`ClusterAgent` is a cluster-scoped resource that defines reusable agent role
definitions (system prompts + front-matter metadata). Projects reference agents
by name in their board roster, and runs reference them via `spec.agent` or
`spec.agents`. The operator resolves names to content at reconcile time and
mounts them into the pod as a ConfigMap.

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: ClusterAgent
metadata:
  name: code-reviewer
spec:
  content: |
    ---
    description: Reviews code for quality and security issues
    mode: subagent
    permission:
      edit: deny
      bash: deny
    ---

    You are a code reviewer. Focus on security, correctness, and maintainability.
```

CLI reference: `beatctl agent list`, `beatctl agent create --name <name> -f agent.yaml`

### OpenCodeRun

```mermaid
flowchart TD
    CR[OpenCodeRun CR]

    CR -->|watched by| OP[operator\nDeployment]

    OP -->|creates / owns| SEC[Secret\nauth pwd]
    OP -->|creates / owns| SVC[Service\nClusterIP]
    OP -->|creates / owns| POD[Pod]
    OP -->|creates / owns\nif ClusterAgents or inline agents set| AGCM[ConfigMap\nagents]
    OP -->|creates / owns\nif INGRESS_BASE_URL set| ING[Ingress\nper-run web URL]
    OP -->|mirrors pod phase\nevery 10 s| CR

    POD --> INIT[git-clone init container\nif spec.source.git set]
    POD --> OC[opencode container\nopencode web :4096]
    POD --> DISP[dispatcher container\nsidecar]

    AGCM -->|volume mount\n/root/.config/opencode/agents| OC
    ING -->|routes| SVC
    SVC -->|ClusterIP :4096| OC

    DISP -->|HTTP 127.0.0.1:4096| OC
    DISP -->|patches| STATUS[CR .status subresource]

    PROJ[OpenCodeProject] -->|spec.project ref| CR
```

- **opencode container** runs `opencode web` on `:4096`. Network-isolated by
  default; exposed via per-run Ingress when configured.
- **dispatcher container** waits for the runner's health endpoint, creates a
  session, fires `POST /session/:id/prompt_async`, then concurrently polls
  `/session/:id/message` and consumes the SSE `/event` stream for low-latency
  token updates. Once the last assistant message's `time.completed` is set it
  patches the CR to `Succeeded` (or `Failed` on error) and exits. A 1-hour
  hard timeout guard exits with code 3 if the run stalls indefinitely.
- **operator** uses a hand-rolled informer (no kubebuilder for TypeScript),
  creates child objects with `ownerReferences` for cascading deletion, and
  mirrors Pod phase into the CR status every 10 s.

### Run phases

| Phase | Description |
|-------|-------------|
| `Pending` | CR created; not yet enqueued for reconciliation |
| `Initializing` | Operator is creating pod/service/ingress resources |
| `Running` | Pod ready, dispatcher has started work (prompt dispatched or waiting for attach) |
| `WaitingForInput` | Agent needs human clarification — visible as pending questions on the board. Reply via dashboard `/runs/:name/reply` endpoint |
| `Succeeded` | Run completed successfully (terminal) |
| `Failed` | Run hit an error that could not be recovered from (terminal) |
| `Cancelled` | Run was deleted or timed out (terminal) |

### Session analytics

```mermaid
flowchart LR
    POD[OpenCodeRun Pod\ndispatcher sidecar]
    POD -->|POST /api/stats/session\nfire-and-forget, non-fatal| WEB[percussionist-web pod]
    WEB --> DB[(bun:sqlite\n/app/data/stats.db\n1 Gi PVC)]
    DB -->|hourly cleanup\nRETENTION_DAYS| DB
    USER[user / LLM CLI]
    USER -->|GET /api/stats/export| WEB
```

## `beatctl` CLI

`beatctl` reuses your existing kubeconfig (same rules as `kubectl`: `KUBECONFIG`
then `~/.kube/config`).

### Installation

```sh
# Run from source during development
pnpm beatctl --help

# Install globally
pnpm --filter @percussionist/cli build
pnpm link --global --filter @percussionist/cli

# Or build a self-contained binary (Bun runtime embedded, ~98 MB)
pnpm bundle
./packages/cli/bin/beatctl ls
```

### Commands

| Command | What it does |
|---------|-------------|
| `beatctl deploy` | Install CRDs and apply operator + manager controller + web manifests; waits for rollouts. |
| `beatctl deploy --down` | Delete all operator/web/manager resources and CRDs. |
| `beatctl submit -t "<task>" --project <name>` | Create an `OpenCodeRun` with an inline task prompt (requires a project name). |
| `beatctl submit -i --project <name>` | Interactive run — no prompt; runner stays alive for `beatctl attach`. |
| `beatctl submit ... -a` | After submit, poll until `Running` then hand off to attach. |
| `beatctl submit -f run.yaml` | Create from a YAML file (requires `-t` or `-i`; project is resolved via `spec.project` in the file). |
| `beatctl ls` | Table of runs with phase, session ID, token totals, age. |
| `beatctl get <name>` | Detailed view of a single run (`-o yaml` / `-o json` supported). |
| `beatctl logs <name> [-f]` | Stream container logs. `-c dispatcher` to watch the sidecar. |
| `beatctl attach <name>` | Port-forward the run's Service and launch `opencode attach`; cleans up on exit. |
| `beatctl wait <name>` | Block until terminal phase. Exit 0 = Succeeded, 1 = other terminal or deleted, 2 = timeout, 3 = API error. `--for <phase>` to await a specific phase. |
| `beatctl cancel <name>` | Delete the run and all owned resources. |
| `beatctl board get <project>` | Show the board state (columns, workers, escalations) for an OpenCodeProject. |
| `beatctl board task add <project> --id X --title Y --agent Z` | Add a task to the project's board. |
| `beatctl board task move <project> --task-id X --to column` | Move a task between columns. |
| `beatctl board task remove <project> --task-id X` | Remove a task from the board (spec + status). |
| `beatctl project list` / `get` / `create` / `delete` | Manage OpenCodeProject templates. |
| `beatctl agent list` / `get` / `create` / `delete` | Manage ClusterAgent resources (cluster-scoped). |

Global flags: `-n, --namespace <ns>` (default: `percussionist` or `$PERCUSSIONIST_NAMESPACE`).

### Scripting with `wait`

```sh
beatctl submit --name ci-lint -f run.yaml --project my-project
if beatctl wait ci-lint --timeout 600; then
  echo "lint passed"
else
  beatctl logs ci-lint -c opencode --tail 200
  exit 1
fi
beatctl cancel ci-lint
```

Exit codes: `0` awaited phase reached · `1` terminal phase other than awaited,
or the CR was deleted mid-wait · `2` timeout · `3` Kubernetes API error (non-404).

> `--project` is required unless using `-f` with a fully-specified run YAML that
> includes `spec.project`. When in doubt, always provide it.

## Git workspace source

Point a run at a repo and the operator clones it into `/workspace` before the
agent starts. The runner's working directory is `/workspace`.

Git configuration is normally set on an `OpenCodeProject` so all runs from that
project inherit it:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeProject
metadata:
  name: my-project
spec:
  source:
    git:
      url: https://github.com/octocat/Hello-World.git
      ref: main        # optional; omitted = remote HEAD (default branch)
```

Individual runs override the project defaults with explicit fields. A minimal run
just references its project:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeRun
metadata:
  name: hello
spec:
  task: "Find the entry point and summarise what it does."
  project: my-project   # pulls git, secrets, model from project
```

### Run-level override

You can pin a different repo or branch on a per-run basis:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: OpenCodeRun
metadata:
  name: explore-branch
spec:
  task: "Find the entry point and summarise what it does."
  project: my-project
  source:
    git:
      url: https://github.com/other/repo.git
      ref: experimental-feature
```

Ref handling:

- Omitted → default branch, `--depth=1`
- Branch or tag → `--depth=1 --branch <ref>`
- Full SHA (7–40 hex chars) → full clone + `git checkout --detach <sha>`

For private repos, reference a Secret containing an SSH key:

```bash
kubectl create secret generic agent-key \
  --type=kubernetes.io/ssh-auth \
  --from-file=ssh-privatekey=$HOME/.ssh/id_ed25519 \
  -n percussionist
```

```yaml
# On a project or run spec:
spec:
  source:
    git:
      url: git@github.com:you/private-repo.git
      ref: main
      sshSecret:
        name: agent-key
        # key: ssh-privatekey   # default
      author:
        name: Percussionist Agent
        email: agent@example.com
```

`author` sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in both the init container
and the runner, so in-run `git commit` works without manual `git config`.

CLI equivalents (flags override project values):

```bash
beatctl submit \
  -t "make a small docs change and commit" \
  --project my-project \
  --git-url git@github.com:you/private-repo.git \
  --git-ref main \
  --git-ssh-secret agent-key \
  --git-author-name "Percussionist Agent" \
  --git-author-email "agent@example.com"
```

## Project boards

An `OpenCodeProject` can carry an embedded kanban-style board that coordinates
multi-task agentic development through a five-column flow:
`ready → in-progress → review → rework → done`.

### Board spec fields (on OpenCodeProject)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `spec.board.maxParallel` | int | 2 | WIP limit: max concurrent worker runs (1–20) |
| `spec.board.agents[]` | AgentRef[] | — | ClusterAgent names available as task assignees |
| `spec.board.tasks[]` | BoardTask[] | — | Task backlog (max 100 per board) |
| `spec.board.overrides.model` | string | project.default | Model override for all worker runs on this board |
| `spec.board.overrides.timeoutSeconds` | int | project.default | Timeout override for worker runs |
| `spec.board.phase` | enum | Active | Board lifecycle: Active / Complete / Archived |

### BoardTask fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string (max 32 chars) | — | Unique task ID (e.g. "F-104", "BUG-42"). Immutable once created. |
| `title` | string (max 256 chars) | — | Short human-readable title shown on the card |
| `description` | string (max 8192 chars) | optional | Acceptance criteria and context sent to the worker agent |
| `priority` | enum | medium | Priority for ordering: high / medium / low |
| `agent` | string (min 1 char) | required | ClusterAgent name from `board.agents[]` that handles this task |

### Creating a board

The board is configured as part of project creation. Create a project with an
embedded board via the CLI or web dashboard:

```sh
beatctl project create --name my-project \
  --display-name "My Project" \
  --model anthropic/claude-sonnet-4 \
  --git-url https://github.com/octocat/Hello-World.git
```

Then add tasks to the board:

```sh
# Add ClusterAgents (team roster) first — reference cluster-scoped agent definitions.
beatctl agent create --name code-reviewer -f agents/code-reviewer.yaml

# Add a task to the project's board. It starts in the "ready" column.
beatctl board task add my-project \
  --id F-101 --title "Implement login" \
  --description "Add OAuth login with GitHub provider" \
  --agent code-reviewer

# View board state
beatctl board get my-project
```

The manager controller automatically picks up tasks in "ready", creates worker
runs, and moves them across columns as they progress.

### Human-in-the-loop

The manager escalates a task after 3 retries (4 total attempts). Review the
escalation text via `beatctl board get <project>` or in the dashboard:

1. **Accept** — move task to "done" via `beatctl board task move my-project --task-id F-101 --to done`.
2. **Rework** — move back to "rework"; the manager re-dispatches with feedback
   context embedded in the prompt.
3. **Skip** — remove the task from the board entirely (`beatctl board task remove`).

When a worker asks the agent for clarification, the run enters `WaitingForInput`
phase and a pending question appears on the board status. Reply via the web UI's
`/runs/:name/reply` endpoint.

### Status fields (project.status.board)

- `.status.columns` — ordered column names: `["ready", "in-progress", "review", "rework", "done"]`
- `.status.backlog` — map of column name → task ID array
- `.status.workers[]` — per-worker run name, status (`Running/Succeeded/Failed/Escalated`), branch, escalation text
- `.status.activeWorkers` — count of currently running workers
- `.status.escalations[]` — human-readable escalation texts for tasks that exhausted retries
- `.status.pendingQuestions[]` — worker sessions waiting for human input

The web dashboard renders board state on project detail pages under the Board tab.

## Web dashboard

The dashboard (`percussionist-web`) is exposed via Ingress at a stable URL.
For minikube with the default IP:

```
http://app.192.168.49.2.nip.io:30080/
```

[nip.io](https://nip.io) resolves `*.192.168.49.2.nip.io` to `192.168.49.2` —
no `/etc/hosts` edits needed.

### Pages

| Page | URL | What it shows |
|------|-----|---------------|
| **Runs** | `/` | Live `OpenCodeRun` list — phase badges, token totals, age, attach button. |
| **Projects** | `/projects` | Project templates with embedded board views (tasks, workers, escalations). |
| **Agents** | `/agents` | Cluster-wide agent catalog — reusable `.md` definitions. |
| **Stats** | `/stats` | Historical session analytics from the stats DB. |

> Board detail is accessible via a project's Board tab rather than as a separate page.

### Stats view

Aggregates data persisted by the dispatcher after each run. Shows:

- **Summary cards** — total runs, success rate, average duration, total tokens.
- **Tool usage** — call counts per tool with proportional bars.
- **Model breakdown** — runs and tokens per model with stacked bars.
- **Tokens per run** — top 20 sessions by total token count.
- **Sessions table** — one row per session with phase, model, tokens, duration.

A day-range selector (7d / 30d / 90d / All) refetches from `/api/stats/export?days=N`.

### Setup (minikube)

1. Enable the ingress addon:
   ```sh
   minikube addons enable ingress
   ```
2. Run `scripts/minikube-load.sh` — it pins the ingress-nginx HTTP NodePort to
   `30080` automatically (idempotent).
3. `beatctl deploy` applies `deploy/web.yaml` as part of the full deployment.

> **Note:** the web server runs under Bun. Bun's TLS stack does not pick up
> the custom `https.Agent` that `@kubernetes/client-node` configures for the
> in-cluster CA. `deploy/web.yaml` sets `NODE_EXTRA_CA_CERTS` to the service
> account CA bundle path so Bun trusts the cluster API server certificate.

## Per-run web UI (subdomains)

Each run exposes the full opencode web UI via its ClusterIP Service on port
4096. To make it browser-accessible, the operator can create a per-run Ingress
that routes `http://<run>.<baseDomain>/` to the run's Service.

### Ingress controller setup

| Cluster | Setup |
|---------|-------|
| **minikube** | `minikube addons enable ingress` + `scripts/minikube-load.sh` to pin NodePort |
| **kind** | `extraPortMappings` for port 80 + install `ingress-nginx` |
| **k3d** | `k3d cluster create --port 80:80@loadbalancer` — Traefik included |
| **Docker Desktop** | Install `ingress-nginx` manually |

### Operator configuration

Set these environment variables on the operator Deployment (see commented-out
examples in `deploy/operator.yaml`):

```sh
# Required: enables per-run Ingress creation (scheme://host[:port])
PERCUSSIONIST_INGRESS_BASE_URL=http://192.168.49.2.nip.io:30080

# Optional: ingress class name
PERCUSSIONIST_INGRESS_CLASS=nginx

# Optional: extra annotations merged onto every Ingress (JSON)
# The SSE /event endpoint needs long timeouts and no buffering:
PERCUSSIONIST_INGRESS_ANNOTATIONS='{"nginx.ingress.kubernetes.io/proxy-read-timeout":"3600","nginx.ingress.kubernetes.io/proxy-buffering":"off"}'
```

DNS options for minikube:

```sh
# nip.io wildcard DNS (recommended — no local config needed)
PERCUSSIONIST_INGRESS_BASE_URL=http://$(minikube ip).nip.io:30080

# *.localhost (Linux with systemd-resolved, macOS Ventura+, Windows 11)
PERCUSSIONIST_INGRESS_BASE_URL=http://percussionist.localhost
```

### Per-run opt-out

```yaml
spec:
  task: "run the tests"
  expose:
    web: false
```

### URL format

```
http://<run-name>.<base-host>:<port>/
# e.g. http://run-abc123.192.168.49.2.nip.io:30080/
```

> **Security note:** the opencode server runs without a password. The Ingress
> is only reachable on your local network via the minikube IP. Do not bind the
> ingress controller to a public interface without adding authentication.

## Provider auth

Not every LLM provider uses a static API key. GitHub Copilot, ChatGPT Plus,
and Claude Pro use OAuth device-code flows whose token lands in
`~/.local/share/opencode/auth.json` on your workstation. Opencode checks the
`OPENCODE_AUTH_CONTENT` env var before reading that file — so the workflow is:
log in once locally, ship the token to a cluster Secret, project it as an env
var in run pods.

### One-time setup

```bash
opencode auth login github-copilot     # opens https://github.com/login/device
# opencode auth login openai           # ChatGPT Plus/Pro
# opencode auth login anthropic        # Claude Pro/Max

# Import credentials into the cluster (read-only on your workstation)
beatctl auth import
```

This creates a Secret called `opencode-auth` in the `percussionist` namespace.
Re-run after re-authenticating locally; the Secret is replaced wholesale.

### Referencing from a run

```yaml
spec:
  task: "Say hi"
  model: github-copilot/claude-sonnet-4.5
  secrets:
    opencodeAuthSecret:
      name: opencode-auth
```

Or with inline flags:

```bash
beatctl submit \
  -t "Say hi" \
  -m github-copilot/claude-sonnet-4.5 \
  --auth-secret opencode-auth
```

`llmKeysSecret` (static API keys) and `opencodeAuthSecret` (OAuth tokens) are
orthogonal — both may be set. If both configure the same provider, the
auth.json entry wins.

### Config file injection (`opencodeConfigMap`)

To supply a full `opencode.json` config file — for example to configure a
custom provider such as lmstudio or ollama:

```bash
kubectl create configmap my-opencode-config \
  --from-file=opencode.json=./my-opencode.json \
  -n percussionist
```

```yaml
spec:
  task: "Say hi"
  secrets:
    opencodeConfigMap:
      name: my-opencode-config
      # key: opencode.json   # default
```

The operator projects the ConfigMap value as `OPENCODE_CONFIG_CONTENT`, which
opencode reads before its on-disk `~/.config/opencode/opencode.json`.

### Caveats

- Token lifetime is provider-controlled. GitHub Copilot tokens are long-lived
  until revoked under [github.com/settings/applications](https://github.com/settings/applications);
  Anthropic tokens are refresh-rotated and may expire — re-run `beatctl auth import` on auth errors.
- One Secret shared across many runs means one revocation affects all. This is
  intentional — per-run tokens create orphan-Secret cleanup churn.
- `beatctl auth` never prints raw tokens. `--dry-run` shows a type and
  length summary for sanity-checking.
- The token is not in plain text in any Kubernetes object, but is reachable
  from inside the pod via `/proc/<pid>/environ` — same exposure as
  `OPENCODE_SERVER_PASSWORD`.

---

## Customizing agents and skills

Agents and skills can be delivered through two complementary channels.

### Cluster-wide baseline (baked into the runner image)

Place agent markdown files and skill directories under `images/runner/content/`:

```
images/runner/content/
├── agents/
│   └── <name>.md            # one file per agent, filename = agent name
└── skills/
    └── <name>/
        └── SKILL.md         # one folder per skill
```

These are copied into `/root/.config/opencode/` when the runner image is built.
Every pod sees them as cluster-wide defaults regardless of workspace. The
directory is empty by default — add files and rebuild to ship them.

```bash
docker build -t percussionist/runner:dev images/runner
./scripts/minikube-load.sh --only runner
```

See `images/runner/content/README.md` for file format details.

### Per-repo extensions (travel with the workspace)

Commit agents and skills under `.opencode/` in the workspace repository:

```
<repo>/
└── .opencode/
    ├── agents/
    │   └── <name>.md
    └── skills/
        └── <name>/
            └── SKILL.md
```

When the operator clones the repo via `spec.source.git`, opencode discovers
these automatically by walking up from `/workspace` — no operator or image
changes required.

### Precedence

Both channels are additive. When the same name exists in both, the workspace
version wins (project-local paths are searched before global).

---

## Session analytics

Every run is recorded in a SQLite database embedded in the web pod, covering
prompts, responses, tool invocations, files read/written, token counts, and
timing. Intended for periodic LLM-assisted pattern analysis.

### What is stored

| Table | Contents |
|-------|----------|
| `runs` | session ID, run name, task, model, agent, phase, timestamps, token totals, error |
| `messages` | full part list (JSON), role, model, per-message token counts, timing |
| `tool_calls` | tool name, arguments (JSON), success, error, duration |
| `file_ops` | file path, operation (`read`/`write`/`delete`), message index |

Stats are sent for both succeeded and failed runs. The call is fire-and-forget
and never delays run completion.

### Exporting for analysis

```bash
# Last 30 days (default)
curl http://app.<minikube-ip>.nip.io:30080/api/stats/export > sessions.json

# All time
curl http://app.<minikube-ip>.nip.io:30080/api/stats/export?days=0 > sessions.json

# Pipe into an LLM
curl .../api/stats/export | llm "find patterns in agent tool usage and prompt effectiveness"
```

The export is a JSON array; each element is a session with nested `messages`,
`toolCalls`, and `fileOps` arrays.

### Retention

Sessions are deleted after **30 days** by an hourly cleanup job in the web pod.
Override via `RETENTION_DAYS` on the `percussionist-web` Deployment (`0` = keep forever):

```yaml
# deploy/web.yaml — under the web container env:
- name: RETENTION_DAYS
  value: "90"
```

### Web pod configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `DATA_DIR` | `/app/data` | Directory for `stats.db` |
| `RETENTION_DAYS` | `30` | Days to retain session data (`0` = forever) |

The PVC (`percussionist-web-stats`, 1 Gi) is created by `deploy/web.yaml` and
survives pod restarts and redeployments.

### Operator configuration

The operator automatically injects `WEB_STATS_URL` into every dispatcher pod,
resolving to the web service in the same namespace:

```
http://percussionist-web.<namespace>.svc.cluster.local:8080
```

Override by setting `WEB_STATS_URL` on the operator Deployment if the web pod
lives elsewhere. Set it to an empty string to disable stats collection entirely.
