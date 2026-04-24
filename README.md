# percussionist

Kubernetes-native orchestration for [OpenCode](https://opencode.ai) agents.
Each agent run is a Pod; you attach to it on demand with `opencode attach`.

> **Status:** M4 + Provider auth — git-sourced workspaces and OAuth-based
> providers (GitHub Copilot, ChatGPT Plus, Claude Pro) on top of the M3
> CLI, M2 operator, and the original M1 runner pod.

## Repo layout

```
.
├── crds/               # OpenCodeRun CustomResourceDefinition (v1alpha1)
├── deploy/             # Operator Deployment + RBAC
├── examples/           # Sample OpenCodeRun manifests
├── images/
│   ├── runner/         # opencode + git + ssh on Alpine (used by every run pod)
│   └── node/           # Shared Node 22 image; builds operator + dispatcher
│   └── web/            # Bun image; builds + serves the web dashboard
├── manifests/          # Raw k8s manifests for M1 smoke
├── packages/
│   ├── api/            # Shared Zod schemas, constants, type helpers
│   ├── operator/       # CRD reconciler (informer + reconciler loop)
│   ├── dispatcher/     # Sidecar that drives each run via the opencode HTTP API
│   ├── cli/            # beatctl — user-facing CLI (M3)
│   └── web/            # Dashboard SPA + Hono server + bun:sqlite stats DB
└── scripts/            # Smoke tests + minikube image loader
```

Planned (M5+): `e2e/` automated end-to-end suite; git push-back.

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
  (Re-run after any change to `images/runner/Dockerfile`; the script loads
  with `--overwrite=true` and, with `--force`, also evicts any pods still
  pinning the previous image ID — see the M2 section.)
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
  `:4096` (unauthenticated — rely on network isolation; expose only via the
  per-run Ingress described below for local access).
- **dispatcher** container: waits for the runner's health endpoint, creates a
  session, `POST /session/:id/prompt_async`, polls `/session/:id/message` for
  the last assistant message's `time.completed`, then patches the CR status to
  `Succeeded` (or `Failed` on error) and exits.
- **operator** watches `OpenCodeRun` resources via a hand-rolled informer
  (there's no kubebuilder for TypeScript), creates child objects with
  `ownerReferences`, and mirrors Pod phase into the CR status every 10s.

### Prerequisites

Everything from M1, plus:

- `pnpm` (Node workspace) and Node 24
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
pnpm --filter @percussionist/cli exec bun src/index.ts --help
```

Install globally (after `pnpm -r build`):

```sh
pnpm --filter @percussionist/cli build
pnpm link --global --filter @percussionist/cli
beatctl --help
```

Or bundle a self-contained single-file executable (no Node or Bun required on
the target machine — the Bun runtime is embedded in the binary):

```sh
pnpm bundle                    # -> packages/cli/bin/beatctl (~98 MB)
./packages/cli/bin/beatctl ls  # drop into ~/.local/bin if you like
```

The bundle is produced by `packages/cli/scripts/bundle.mjs` using
`bun build --compile`. It bakes in all workspace deps (`@percussionist/api`
included) and the Bun runtime itself, so the binary runs anywhere with no
external dependencies.

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
| `beatctl attach <name>`        | Start a `kubectl port-forward` to the run's Service and launch `opencode attach`. Port-forward is torn down automatically on exit. |
| `beatctl wait <name>`          | Block until the run reaches a terminal phase. Exit 0 on `Succeeded`, 1 on `Failed`/`Cancelled`/deleted, 2 on timeout. `--for <phase>` waits for a specific phase (e.g. `Running`). Intended for CI and `submit && wait` chains. |
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

### Scripting with `wait`

`wait` turns `beatctl` into a first-class CI citizen. Exit 0 means the run
succeeded — everything else is a non-zero exit code:

```sh
beatctl submit -t "run the linter" --name ci-lint -f run.yaml
if beatctl wait ci-lint --timeout 600; then
  echo "lint passed"
else
  beatctl logs ci-lint -c opencode --tail 200
  exit 1
fi
beatctl cancel ci-lint
```

Exit codes: `0` awaited phase reached · `1` terminal-but-not-awaited (e.g.
`Failed`, `Cancelled`, or the CR was deleted mid-wait) · `2` timeout · `3`
Kubernetes API error.

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

## Dashboard access

The Percussionist web dashboard (`percussionist-web`) is exposed via Ingress
at a stable URL — no `kubectl port-forward` needed:

```
http://app.<minikube-ip>.traefik.me:30080/
```

For the default minikube IP (`192.168.49.2`):

```
http://app.192.168.49.2.traefik.me:30080/
```

[traefik.me](https://traefik.me) is a free wildcard DNS service: `*.192.168.49.2.traefik.me`
resolves to `192.168.49.2` — no `/etc/hosts` edits needed.

The web pod runs under **Bun** and hosts the session analytics SQLite database
alongside the dashboard SPA. See [Session analytics](#session-analytics) for
details on the `/api/stats/export` endpoint.

### Pages

The dashboard has a persistent left sidebar with two views:

| Page | URL | What it shows |
|------|-----|---------------|
| **Runs** | `/` | Live `OpenCodeRun` list — phase badges, token totals, age, attach button. Sortable and filterable by phase. |
| **Stats** | `/stats` | Historical session analytics from the stats DB (see below). |

#### Stats view

The stats view aggregates data persisted by the dispatcher sidecar after each
run completes. It shows:

- **Summary cards** — total runs, succeeded, failed, success rate, average
  duration, total tokens in/out.
- **Tool usage** — call counts per tool with a proportional bar. Falls back to
  parsing inline message content when the `toolCalls` table is empty.
- **Model breakdown** — runs and tokens in/out per model, with a stacked
  in/out bar. Resolves the model from the user message when the run row has
  `null`.
- **Tokens per run** — horizontal stacked bar chart of the top 20 sessions by
  total token count.
- **Sessions table** — one row per historical session with phase, model,
  tokens, duration, and age.

A day-range selector (7d / 30d / 90d / All) refetches from
`/api/stats/export?days=N`. Data is retained for `RETENTION_DAYS` days
(default: 30; set to 0 to keep forever).

### Prerequisites

1. Enable the ingress addon:
   ```sh
   minikube addons enable ingress
   ```
2. Run `scripts/minikube-load.sh` at least once — it pins the ingress-nginx
   HTTP NodePort to `30080` automatically (idempotent).
3. Apply `deploy/web.yaml`:
   ```sh
   kubectl apply -f deploy/web.yaml
   ```

> **Note:** the web server runs under Bun. Bun's TLS stack does not pick up
> the custom `https.Agent` that `@kubernetes/client-node` configures for the
> in-cluster CA. `deploy/web.yaml` sets `NODE_EXTRA_CA_CERTS` to the service
> account CA bundle path so Bun trusts the cluster API server certificate.

The script also prints the dashboard and run URLs as a reminder at the end of
each run.

## Opencode web access (per-run subdomains)

Each run exposes a full opencode web UI via its ClusterIP Service on port 4096.
By default this is only reachable in-cluster. To make it accessible in a
browser while running locally, Percussionist can create a per-run Kubernetes
Ingress that routes `http://<run>.<baseDomain>/` to the run's Service.

### Prerequisites

An ingress controller must be deployed. Quick setups:

| Cluster  | Setup |
|----------|-------|
| **minikube** | `minikube addons enable ingress` (then run `scripts/minikube-load.sh` to pin NodePort) |
| **kind** | Add `extraPortMappings` for port 80 and install `ingress-nginx`: `kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml` |
| **k3d**  | `k3d cluster create --port 80:80@loadbalancer` — Traefik is included by default |
| **Docker Desktop k8s** | Install `ingress-nginx` manually |

### DNS

For minikube, use `traefik.me` wildcard DNS with your minikube IP:

```sh
PERCUSSIONIST_INGRESS_BASE_URL=http://$(minikube ip).traefik.me:30080
```

For setups where the ingress controller is on `127.0.0.1:80`, use
`*.percussionist.localhost` — modern OS resolvers (Linux with systemd-resolved,
macOS Ventura+, Windows 11) resolve `*.localhost` to `127.0.0.1` automatically:

```sh
PERCUSSIONIST_INGRESS_BASE_URL=http://percussionist.localhost
```

### Operator configuration

Set these environment variables on the operator Deployment (see commented-out
examples in `deploy/operator.yaml`):

```sh
# Required: enables per-run Ingress creation (scheme://host[:port])
PERCUSSIONIST_INGRESS_BASE_URL=http://192.168.49.2.traefik.me:30080

# Optional: ingress class name (e.g. "nginx", "traefik")
PERCUSSIONIST_INGRESS_CLASS=nginx

# Optional: extra annotations merged onto every Ingress (JSON)
# The SSE endpoint /event needs long timeouts and no buffering:
PERCUSSIONIST_INGRESS_ANNOTATIONS='{"nginx.ingress.kubernetes.io/proxy-read-timeout":"3600","nginx.ingress.kubernetes.io/proxy-buffering":"off"}'
```

### Per-run opt-out

Set `spec.expose.web: false` on a run to skip Ingress creation for that run:

```yaml
spec:
  task: "run the tests"
  expose:
    web: false
```

### Usage

Once configured, every run's dashboard page shows an **Open web** link in the
header and a **Web UI** field in the Status card with the full URL. Clicking
opens the opencode SPA in a new tab — no authentication required.

The URL format is:

```
http://<run-name>.<base-host>:<port>/
```

e.g. for minikube with the default IP:

```
http://run-abc123.192.168.49.2.traefik.me:30080/
```

> **Security note:** the opencode server runs without a password. The Ingress is only reachable on your local network via the minikube IP. If you bind the ingress controller to a public interface the service becomes reachable without authentication.

## M3 exit criteria

- [x] `submit` creates an `OpenCodeRun` from inline flags or a YAML file.
- [x] `ls` / `get` show run state with token totals.
- [x] `logs` streams pod logs, selecting runner or dispatcher container.
- [x] `attach` forwards the Service port, reads the auth Secret, and launches
      `opencode attach` with the correct credentials; cleans up port-forward
      on exit.
- [x] `cancel` deletes the CR and cascades to all child objects.
- [x] `wait` blocks on a terminal phase with script-friendly exit codes
      (added post-M3 for CI workflows).

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
      author:
        name: Percussionist Agent
        email: agent@example.com
```

`author` is optional, but when set both `name` and `email` are required. The
operator injects them as `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in both the
clone init container and the runner container, so in-run `git commit` works
without manual `git config`.

CLI equivalents:

```bash
# One-off run
pnpm beatctl submit \
  -t "make a small docs change and commit" \
  --git-url git@github.com:you/private-repo.git \
  --git-ref main \
  --git-ssh-secret agent-key \
  --git-author-name "Percussionist Agent" \
  --git-author-email "agent@example.com"

# Project defaults
pnpm beatctl project create \
  --name my-repo \
  --git-url git@github.com:you/private-repo.git \
  --git-ref main \
  --git-ssh-secret agent-key \
  --git-author-name "Percussionist Agent" \
  --git-author-email "agent@example.com"
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

## Provider auth

Not every LLM provider exposes a static API key. GitHub Copilot, ChatGPT
Plus, and Claude Pro use OAuth device-code flows whose resulting token
lands in your workstation's `~/.local/share/opencode/auth.json`. Opencode
also checks a first-class env var, `OPENCODE_AUTH_CONTENT`, before reading
that file — so the integration shape is "log in once locally, ship the
token into a cluster Secret, project it as an env var in run pods".

### One-time setup

```bash
# On your workstation: log into the provider.
opencode auth login github-copilot     # opens https://github.com/login/device
# ...repeat for any other OAuth providers you want in the cluster:
# opencode auth login openai           # ChatGPT Plus/Pro
# opencode auth login anthropic        # Claude Pro/Max

# Push the credentials into the cluster. Default = import every provider
# found locally; filter with --provider. The command is read-only on your
# workstation — it never modifies ~/.local/share/opencode/auth.json.
pnpm beatctl auth import
```

This creates a Secret called `opencode-auth` in the `percussionist`
namespace. Re-run the import whenever you re-auth locally; the Secret is
replaced wholesale.

### Referencing it from a run

```yaml
spec:
  task: "Say hi"
  model: github-copilot/claude-sonnet-4.5    # optional; pins a Copilot-proxied model
  secrets:
    opencodeAuthSecret:
      name: opencode-auth
```

Or with inline flags:

```bash
pnpm beatctl submit \
  -t "Say hi" \
  -m github-copilot/claude-sonnet-4.5 \
  --auth-secret opencode-auth
```

Both `llmKeysSecret` and `opencodeAuthSecret` may be set on the same run —
they're orthogonal. `llmKeysSecret` projects `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / … for static-key providers, while `opencodeAuthSecret`
carries OAuth tokens. If both configure the same provider, the auth.json
entry wins.

### Caveats

- The token's lifetime is whatever the upstream provider says. GitHub
  Copilot OAuth tokens are long-lived until revoked under
  [github.com/settings/applications](https://github.com/settings/applications);
  Anthropic's are refresh-rotated and may expire — re-run
  `beatctl auth import` when you see auth errors.
- One Secret shared across many runs means one revocation breaks all of
  them. That's intentional — per-run tokens aren't worth the orphan-Secret
  cleanup churn.
- `beatctl auth` never prints raw tokens. `--dry-run` shows a summary
  (type, first-four/last-four chars, length) so you can sanity-check.
- `kubectl describe pod` shows the env var as
  `<set to the key '…' in secret '…'>`; the token isn't in plain text in
  any k8s object. It *is* reachable from inside the pod via
  `/proc/<pid>/environ`, same exposure class as `OPENCODE_SERVER_PASSWORD`.

---

## Customizing agents and skills

OpenCode agents and skills can be delivered to run pods through two
complementary channels.

### Cluster-wide baseline (baked into the runner image)

Place agent markdown files and skill directories under
`images/runner/content/`:

```
images/runner/content/
├── agents/
│   └── <name>.md            # one file per agent, filename = agent name
└── skills/
    └── <name>/
        └── SKILL.md         # one folder per skill, folder name = skill name
```

These are `COPY`'d into `/root/.config/opencode/` when the runner image is
built. Every pod created from that image sees them as cluster-wide defaults,
regardless of what workspace is cloned. The directory is empty by default —
add files and rebuild to ship them.

Rebuild + reload after changes:

```bash
docker build -t percussionist/runner:dev images/runner
# Then reload into your cluster — see scripts/minikube-load.sh
```

See `images/runner/content/README.md` for the expected file formats and
links to the OpenCode docs.

### Per-repo extensions (travel with the workspace)

Each user workspace repo can ship its own agents and skills without any image
change. Commit them under `.opencode/` in the workspace repository:

```
<repo>/
└── .opencode/
    ├── agents/
    │   └── <name>.md
    └── skills/
        └── <name>/
            └── SKILL.md
```

When the operator clones the repo via `spec.source.git`, files land in
`/workspace`. OpenCode walks up from `/workspace` (the runner's cwd) and
discovers them automatically — no operator or image changes required.

### Precedence

Both channels are additive. If the same agent or skill name exists in the
image baseline **and** in the workspace repo, the workspace version wins
(OpenCode loads the first match, project-local paths are searched before
global).

### Deferred: dynamic skills via init container

A future milestone will add `spec.source.skills` to the CRD, rendering a
second init container that clones a dedicated skills repo into
`/root/.config/opencode/`. This allows cluster-wide skills to be updated
without rebuilding the runner image.

---

## Session analytics

Every completed run is automatically recorded in a SQLite database embedded
in the web pod. The data covers the full conversation — prompts, assistant
responses, tool invocations with arguments, files read/written, token counts,
and timing — and is intended for periodic LLM-assisted pattern analysis to
improve agent prompts and tool usage.

### Architecture

```
Dispatcher sidecar  ──POST /api/stats/session──►  percussionist-web pod
                                                       │
                                                  bun:sqlite
                                                  /app/data/stats.db
                                                  (1 Gi PVC — survives restarts)
```

The dispatcher sends stats at the end of each successful run. The call is
fire-and-forget (non-fatal) and never blocks or delays the run completing.

### What is stored

| Table | Contents |
|-------|----------|
| `runs` | session ID, run name, task text, model, agent, phase, timestamps, token totals, error |
| `messages` | full part list (JSON), role, model, per-message token counts, timing |
| `tool_calls` | tool name, arguments (JSON), success, error, duration |
| `file_ops` | file path, operation (`read`/`write`), message index |

### Exporting for analysis

```bash
# Last 30 days (default)
curl http://app.<minikube-ip>.traefik.me:30080/api/stats/export > sessions.json

# All time
curl http://app.<minikube-ip>.traefik.me:30080/api/stats/export?days=0 > sessions.json

# Pipe straight into your LLM CLI of choice
curl .../api/stats/export | llm "find patterns in agent tool usage and prompt effectiveness"
```

The export is a JSON array where each element is a session with nested
`messages`, `toolCalls`, and `fileOps` arrays.

### Retention

Sessions are automatically deleted after **30 days** by an hourly cleanup
job running inside the web pod. Override via the `RETENTION_DAYS` env var
on the `percussionist-web` Deployment (set to `0` to keep data indefinitely):

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

The PVC (`percussionist-web-stats`, 1 Gi) is created by `deploy/web.yaml`
and survives pod restarts and redeployments.

### Operator configuration

The operator automatically injects `WEB_STATS_URL` into every dispatcher
pod, resolving to the web service in the same namespace:

```
http://percussionist-web.<namespace>.svc.cluster.local:8080
```

Override by setting `WEB_STATS_URL` on the operator Deployment if the web
pod lives in a different location. Set it to an empty string to disable
stats collection entirely.
