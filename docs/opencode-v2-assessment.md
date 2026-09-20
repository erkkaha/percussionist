# OpenCode 2 (`@opencode/sdk`) — assessment and the `runner-opencode` image

Status: **shipped**. `packages/runner-opencode` and the
`ghcr.io/erkkaha/percussionist/runner-opencode` image are the default runner
since v0.2.27; the v1 image stays published as `runner` for opt-out.

This documents the feasibility spike behind plan task
`percussionist-dev-plan-57caf6` ("Opencode 2 is out") and the design that came
out of it. Numbers are from 2026-09-19 against `@opencode/sdk` 2.0.10.

## Runtime verdict

`OpenCode.create()` hosts OpenCode 2 in-process — no listener, no binary — and
runs on every runtime that matters, including the real runner image:

| Where | Runtime | `create()` | RSS after a session | Result |
|---|---|---|---|---|
| `runner:v0.2.17` (Alpine 3.24, musl) | Node 24.18 | 124 ms | 405 MB | pass |
| `runner:v0.2.17` (Alpine 3.24, musl) | Bun 1.4.0 | 110 ms | 322 MB | pass |
| dev box (glibc) | Node 26.5 | 47 ms | 375 MB | pass |
| dev box (glibc) | Bun 1.4.0 | 53 ms | 345 MB | pass |

`npm install --ignore-scripts` takes about a minute and produces ~445 MB of
`node_modules`; no native build is needed (the SDK's native transitive deps
ship prebuilt binaries). A real turn through `opencode-go/deepseek-v4.1-flash`
called a plugin-registered tool and returned in two steps for $0.0016.

## What changed in v2 that Percussionist had to absorb

| v1 (`opencode serve` 1.18) | v2 (`@opencode/sdk` 2.0) | Where it is handled |
|---|---|---|
| HTTP API: `POST /session`, `GET/POST /session/:id/message`, `GET /event`, `GET /global/health` | Typed in-process client; `sessions.create/prompt/switchModel/switchAgent`, `message.list`, `events.subscribe()` | `runner-opencode/src/index.ts` re-serves the v1 API on 4096 |
| Transcript: `{ info: { role, tokens, cost, model }, parts[] }` with `text`/`tool`/`step-finish` parts | Flat messages typed `user`/`assistant`/`idle`/`model-switched`; assistant `content[]` of `text`/`reasoning`/`tool`; `tokens`/`cost` on the message | `src/translate.ts` (+ tests) |
| Tool parts name the tool directly | "Code Mode": the model calls one `execute` tool; real calls sit in `state.metadata.toolCalls[]` | `translate.ts` unwraps them into per-tool parts |
| SSE `message.updated`, `session.idle`, `permission.updated` | `session.step.ended`, `session.execution.succeeded/failed`, `session.usage.updated`, … | `src/host.ts` event pump maps to the three v1 events |
| `OPENCODE_AUTH_CONTENT` (v1 `auth.json`) | No auth env var; credentials live in the SDK database (in-memory when embedded) | `host.ts` registers `type: api` keys via `integration.connect.key` after the catalog loads; `prompt()` waits for the requested model to become listed. The github-copilot `oauth` entry is really the long-lived GitHub token (`gho_…`, `expires: 0`); v2's integration only offers a device flow or `GITHUB_TOKEN`, so `index.ts` exposes that token as `GITHUB_TOKEN` before the SDK boots (not clobbering a pod-provided one) |
| `OPENCODE_CONFIG_CONTENT` | Still read; also `OpenCode.create({ config: { content } })`. v1 keys are normalized (`provider→providers`, `npm→package`, `options→settings`, `mcp→mcp.servers`, `agent→agents`) | `src/config.ts` builds one document from config + auth + agent files |
| Agent files in `~/.config/opencode/agents/*.md` | Not observed to load from the XDG directory in 2.0.10 | `config.ts` inlines mounted agent files under the legacy `agent` key (`prompt`, `mode`, `permission`, …) |
| Permissions answered by config / a human | Plugin permission hook (`ctx.permission.hook("evaluate")`) | `src/plugin.ts` auto-allows in headless pods (`RUNNER_PERMISSION_MODE=ask` to disable) |
| Remote MCP stanza in `opencode.json` | Same stanza, normalized to `mcp.servers` | The operator's injected `percussionist-dispatcher` entry works unchanged |
| Model per prompt (`model: {providerID, modelID}` in the POST body) | `sessions.switchModel({ model: { providerID, id } })`; prompt has no model field | `host.ts` switches model/agent before `prompt()` |

Two behaviours cost real debugging time and are worth knowing:

- **Readiness race.** After `integration.connect.key`, the provider's models
  become routable a few hundred ms later, in the batch that also emits
  `models-dev.refreshed` / `integration.updated`. Nothing simpler flips:
  `provider.get` and `integration.get` answer from the catalog immediately, and
  `model.list` already lists a provider's catalog models *before* any
  credential is connected (18 of 27 for opencode-go). A prompt sent in between
  fails with `Model unavailable`. The dispatcher posts its prompt right after
  creating the session, so `prompt()` waits until the *specific* requested
  model is listed (`waitForModel`, 15 s cap).
- **Pagination.** `message.list` cursors encode the order; passing `cursor`
  together with `order` is rejected (`InvalidCursorError`).

Other observations:

- `opencode/*-free` models return 403 "OpenCode's free tier can only be used
  from within OpenCode" to an embedded host. The gate is the client header the
  SDK sets from its `app.name` option; Percussionist does not spoof it.
- An API key in the config document alone (`provider.<id>.options.apiKey`) does
  not connect a *catalog* provider; it does still configure a fully
  config-defined provider such as the cluster's `llama.cpp` entry. Worse, a
  config-side key for a catalog provider makes its models appear listed before
  the connection is routable, so the runner deliberately does not write keys
  into the config document.
- `server.info().version` is `unknown` for embedded hosts; `/global/health`
  reports the pinned SDK version instead.
- The v1 line is still maintained (1.18.x releases continue), so there is no
  forcing function; the migration is opt-in.

## Design: a drop-in image, not a new engine

`packages/runner-claude` already proved the pattern: serve the v1 runner
contract, and nothing downstream changes. `runner-opencode` does the same over
the embedded SDK, and its image additionally ships an `opencode` shim that
accepts the operator's default command (`opencode serve --hostname … --port …`).
That makes it a **drop-in for the default engine**:

```yaml
apiVersion: percussionist.dev/v1alpha1
kind: Run
spec:
  image: ghcr.io/erkkaha/percussionist/runner-opencode:latest
  # everything else unchanged: authSecret, opencode-config ConfigMap, agents
```

or cluster-wide through `ClusterSettings.spec.runnerAdapter.image` (note that
override applies to every engine, so leave it unset if `engine: claude` runs
share the cluster). No CRD, operator, dispatcher or e2e-fixture change is
required; the security boundary (SA token only in the dispatcher container) is
untouched because the runner container's contents are the only thing that
changed. Since v0.2.27 `runner-opencode` is the default (`DEFAULT_RUNNER_IMAGE` in
`packages/api`, the Run and ClusterSettings CRD defaults, and
`RUNNER_IMAGE_DEFAULT` on the operator and manager Deployments); the v1
`runner` image remains published for opt-out. Note that `beatctl attach` /
the dashboard terminal exec `opencode attach` inside the runner container,
which the v2 image cannot serve (no TUI); the shim exits with a clear error.

The interactive path on the v2 runner is the dashboard's Session tab instead,
and it goes entirely through the v1 runner contract both images serve:

- the composer under the transcript posts turns with `POST /session/:id/message`
  (the web's existing `POST /api/runs/:name/reply` route);
- **Stop** calls `POST /api/runs/:name/interrupt`, which tries the facade's
  `POST /session/:id/interrupt` and falls back to v1's `/abort`;
- **Start session** on an interactive run calls `POST /api/runs/:name/session`,
  which creates the session with `POST /session`; the dispatcher's discovery
  loop adopts it within a few seconds and publishes `status.sessionID`.

Shipping the OpenCode 2 CLI in the image for a TUI was tried and dropped: it is
a 200 MB binary, the v2 CLI has no `attach` (its TUI takes `--server`), and it
needs the v2 HTTP API exposed from the embedded host, which the SDK does not
hand out. Permission prompts in `RUNNER_PERMISSION_MODE=ask` still have no
dashboard reply on this runner (the facade serves no `/permissions` route).

Inputs the image consumes are exactly the v1 runner's:

| Input | Source | Used for |
|---|---|---|
| `OPENCODE_CONFIG_CONTENT` | `opencode-config` ConfigMap (or `spec.secrets.configMap`) | providers, models, MCP servers |
| `OPENCODE_AUTH_CONTENT` | `spec.secrets.authSecret` (`auth.json`) | `type: api` entries → `integration.connect.key`; github-copilot → `GITHUB_TOKEN`; other OAuth entries are warned about and left to the SDK's legacy import |
| `/root/.config/opencode/agents/*.md` | agents ConfigMap rendered from `ClusterAgent`s | inlined as `agent.<name>` config |
| `RUN_MODEL`, `RUN_AGENT` | via the dispatcher's POST body | `switchModel`, `switchAgent` |

Extra knobs: `RUNNER_PERMISSION_MODE=ask` (emit `permission.updated` instead of
auto-allowing), `RUNNER_LOG_EVENTS=1` (log every SDK event type),
`OPENCODE_AGENTS_DIR`, `DISPATCHER_MCP_URL`.

## Local smoke test

`packages/runner-opencode/scripts/smoke.mjs` drives the facade exactly as the
dispatcher does (health → session → SSE → prompt → transcript → second turn):

```sh
export OPENCODE_AUTH_CONTENT="$(jq -c '{"opencode-go": ."opencode-go"}' ~/.local/share/opencode/auth.json)"
export OPENCODE_CONFIG_CONTENT='{"mcp":{"percussionist-dispatcher":{"type":"remote","url":"http://127.0.0.1:4097/mcp","enabled":true}}}'
export OPENCODE_AGENTS_DIR=/path/to/agents WORKSPACE_DIR=/tmp/ws PORT=4396
pnpm --filter @percussionist/runner-opencode start &
BASE_URL=http://127.0.0.1:4396 MODEL=opencode-go/deepseek-v4.1-flash AGENT=builder \
  node packages/runner-opencode/scripts/smoke.mjs
```

## Manager: the sidecar is now in-process

`k8s/deploy/manager-controller.yaml` no longer has an `opencode-web`
container. `packages/manager-controller/src/agent/embedded.ts` starts the same
runner-opencode facade inside the manager process, bound to 127.0.0.1:4096, so
`agent/session.ts`, `stats-reporter.ts`, the chat handler and the `list_models`
tool (which needs `GET /provider`, added to the facade) keep speaking the v1
HTTP API unchanged. The manager container now receives what the sidecar used
to: `OPENCODE_CONFIG_CONTENT` from `agent-config`, `OPENCODE_AUTH_CONTENT`
from `agent-auth`, the `llm-keys` envFrom and the `agent-skills` mount. Memory
limit went from 512Mi to 1536Mi (the SDK host adds ~300–400 MB RSS).
`AGENT_OPENCODE_EMBEDDED=0` reverts to an external server at
`AGENT_OPENCODE_URL`.

Verified locally on 2026-09-19 by running the manager with the live cluster's
agent-config: all four providers connected (github-copilot, opencode-go,
opencode, llama.cpp), `POST /chat` answered through the `manager-decision`
agent on github-copilot/gpt-5.6-luna in 4 s.

**Upgrade note.** Any Flux patch that targets the `opencode-web` container
(the cluster bootstrap raised its memory limit to 1Gi) must be removed in the
same step as the release that drops the sidecar; a strategic-merge patch on a
container that no longer exists re-adds it without an image and the
Kustomization fails to apply.

The shared `images/node/Dockerfile` now builds each image's own workspace
subgraph (`pnpm --filter "{packages/<pkg>}..."`), so only the manager image
carries the SDK's ~450 MB of `node_modules`.

## Not done, and why

- **Dispatcher / manager migration to the typed v2 client** (plan tracks A and
  B). Everything the dispatcher needs is reachable through the facade, and the
  message-shape translation lives in one file with tests. Moving the dispatcher
  itself to `@opencode/client` would remove that file but rewrite
  `polling.ts`, `stats-reporter.ts` and the dashboard's transcript views for a
  schema that is still moving several times a week. Revisit once the v2 API
  settles.
- **Percussionist tools as plugin tools instead of MCP.** The remote MCP stanza
  works unchanged in v2, and the MCP control points are what the deterministic
  e2e fixtures rely on.
