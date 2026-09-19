# Plan: OpenCode 2 (`@opencode/sdk`) — what it enables for Percussionist

**Task ID:** `percussionist-dev-plan-57caf6`
**Type:** PLAN (research / architecture assessment + gated roadmap)
**Project:** percussionist-dev
**Source:** https://opencode.ai/v2/docs/build/sdk/ (plus `/v2/docs/build/client/`, `/v2/docs/build/plugins/`, npm registry metadata)

> This plan is deliberately a **spike-first** plan. OpenCode 2 is a major
> version with a new package surface and a changed HTTP/event contract. The
> immediate deliverable is a reproducible feasibility spike and a go/no-go
> decision. The larger adoption tracks are enumerated but must not start until
> the spike passes.

---

## Context

### Current OpenCode integration (v1, pinned)

Percussionist pins OpenCode **1.18.21** and treats it as an external HTTP
process in two places:

**Per-run worker pod** (`packages/operator/src/pod-builder.ts`):
- The runner container executes
  `opencode serve --hostname 0.0.0.0 --port <port>` (default 4096) — see the
  `runner.command ?? ['opencode','serve',...]` branches around lines 968–980.
- `packages/api/src/index.ts` defines `RunnerImageSpec`,
  `OPENCODE_RUNNER_DEFAULTS` (image `ghcr.io/anomalyco/opencode:latest`, port
  4096, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_BASE_URL`)
  and the `RunnerEngine` union (`opencode` | `claude`).
- `packages/operator/src/reconciler.ts` `injectDispatcherMcpStanza()` (line 166)
  injects a remote MCP server `percussionist-dispatcher` at
  `http://127.0.0.1:4097/mcp` into `opencode-config`; it also strips
  `local`/`stdio` MCP entries. `ensureOpencodeConfig()` copies that ConfigMap
  into every run namespace.
- The **dispatcher** sidecar (`packages/dispatcher`) is a separate container with
  the ServiceAccount token; it connects to OpenCode over HTTP
  (`dispatcher/src/session.ts` `BASE_URL`, `waitForHealthy`), creates a session,
  sends the task prompt, polls messages and consumes `/event` SSE
  (`dispatcher/src/polling.ts`), and snapshots sessions.
- The dispatcher runs an **MCP server on 127.0.0.1:4097**
  (`dispatcher/src/mcp-server.ts`, ~1862 lines) exposing `complete_run`,
  `fail_run`, `complete_plan`, `complete_merge`, `complete_review`,
  `get_status`, `create_task`, `search_code`, `read_session`, `write_plan`,
  `read_plan`, `report_unrelated_issue`. Agents call these tools.
- `packages/runner-claude/src/index.ts` reimplements the **v1 HTTP contract**
  (listed verbatim in its header: `GET /global/health`, `POST /session`,
  `GET /session`, `GET /session/:id/message`, `POST /session/:id/message`,
  `GET /event`) on top of the Claude Agent SDK.
- **Security boundary (must be preserved):** `pod-builder.ts` sets
  `automountServiceAccountToken: false` and projects the SA token into the
  **dispatcher container only** (see the comment at lines 926–930). The runner
  container executes untrusted, AI-generated code and is intentionally denied a
  Kubernetes credential.

**Manager pod** (`k8s/deploy/manager-controller.yaml`):
- The manager runs an `opencode-web` sidecar pinned to
  `ghcr.io/anomalyco/opencode:1.18.21` with `args: ["serve", ...]`, reading
  `OPENCODE_CONFIG_CONTENT` from the operator-managed `agent-config` ConfigMap
  (lines 180–218).
- `packages/manager-controller/src/agent/session.ts` is a raw Node `http`/`fetch`
  client (`createSession`, `sendPrompt`, `getMessages`, `waitForCompletion`,
  `waitForOpencodeWeb`) against `OPENCODE_URL` (127.0.0.1:4096).
- `agent/chat-handler.ts` (:4098) and `session-summarizer.ts` both drive that
  client; `reconciler/effects.ts` posts human answers into live run sessions.
- `agent/tools.ts` is the **manager** MCP server (separate from the dispatcher
  MCP server; also on :4097 inside the manager pod).
- The operator owns `agent-config`/`opencode-config` via server-side apply and
  rolls the manager pod when the rendered `agent-config` changes
  (`AGENT_CONFIG_HASH_ANNOTATION` in `reconciler.ts`, line 260).

### What changed in OpenCode 2

- `@opencode/sdk` (latest `2.0.10`) hosts OpenCode **in-process**. `OpenCode.create()`
  returns an owned host whose router runs in memory — no HTTP listener, no network
  hop. It exposes the full generated client plus `sessions` and `events` aliases,
  and is released via `await using` / `opencode.close()`. `OpenCode.create({ plugins })`
  customizes agents, models and tools at startup.
- `@opencode/client` (2.0.10) is a typed network client
  (`OpenCode.make({ baseUrl })`) with `AbortSignal` request options and
  `AsyncIterable` event streams. It also ships a Node-only `@opencode/client/service`
  with `Service.discover()/ensure()/stop()` that can start `opencode serve --service`.
  Plugin **RPC** (`client.rpc(Contract)`) provides typed plugin methods + events and
  a generic `POST /api/rpc/{rpcID}/{method}` route.
- `@opencode/plugin` (2.0.10) provides synchronous **transforms** and **hooks** over
  core domains: `agent`, `provider`, `model`, `mcp`, `tool`, `skill`, `command`,
  `integration`, `reference`, `vcs`, `worktree`, `websearch`, `permission`,
  `session`, `storage`; plus `ctx.generate.text` (transient generation, no session or
  history) and `ctx.event.subscribe()`.
- Worktrees are now a first-class API (`worktree.create/refresh/list/remove` keyed by
  `projectID`) with pluggable strategies registered through `ctx.worktree.transform`.
- Package facts verified from the npm registry (2.0.10): ESM-only, no `engines`
  field; `@opencode/sdk` → `@opencode/server` → `@effect/platform-node` (Node-viable),
  but `@opencode/core` depends on **both** `@ff-labs/fff-bun` and `@ff-labs/fff-node`,
  and `@opencode/client`/`@opencode/plugin` declare UI peer deps (`solid-js`,
  `@opentui/*`, `@opencode/theme`). Runtime support on Node 24 vs Bun is therefore
  the single most important spike question.
- The v2 client shape differs from v1 (e.g. `client.session.create({ location: { directory } })`,
  `client.session.prompt({ sessionID, text })`, `client.event.subscribe()`), so the
  **exact wire/schema delta vs 1.18.21 must be captured**, not assumed.

### Capability → opportunity map

| v2 capability | Repository pain point it addresses | Value | Risk |
|---|---|---|---|
| `@opencode/sdk` in-process host | Manager's `opencode-web` sidecar, `waitForOpencodeWeb`, ConfigMap→env→rollout dance | Remove a container and a startup race | Runtime (Node/Bun), config still needed |
| `@opencode/client` typed client + event iterables | Raw `http`/`fetch` in `dispatcher/src/session.ts`, `polling.ts`, `agent/session.ts` | Less bespoke protocol code, typed errors | Requires v2 server; message schema may differ |
| `ctx.tool.transform/add` + plugin RPC | `injectDispatcherMcpStanza`, MCP lifecycle tools, `/mcp` path footgun | Tools registered in-process; no MCP config | Executors run in the runner process (no SA token) — still must forward |
| `ctx.permission.rules/reply` | Headless pods cannot answer `permission.updated`; runner-claude bypasses permissions | Real permission policy instead of blanket bypass | Semantics must be validated per agent |
| `ctx.agent.transform` | ConfigMap-rendered agent markdown + `agent-skills` volume + rollout hash; `adapters/claude-config.ts` | Agents from `ClusterAgent` CRs at runtime | v1 agent-file → v2 `Agent.Info` shape |
| `ctx.provider/model.transform` | `runnerConfig`/`opencode-config`, `list_models`, cost control | Dynamic providers + model budget policy | Provider schema churn |
| `ctx.generate.text` / `session.generate` | `session-summarizer.ts` create-session/send/wait loop; facilitator/buildgen prompts | Cheaper, no history pollution | None material |
| `ctx.session.wait` + typed events | `waitForCompletion` polling; SSE reconnect loop | Removes polling and the reconnect-storm fix | Event schema change |
| `worktree.*` + `ctx.vcs` | Init-container git-mirror/worktree shell; board diff view | Native strategy + diff/status APIs | Large, optional |
| `ctx.storage` | plugin caches | Minor | Local only, not authoritative |

---

## Approach

**Do not do a big-bang upgrade.** Adopt v2 behind an explicit, independently
verifiable gate, and keep the existing v1 path working throughout. Two
independent tracks emerge:

- **Track A — Manager embedding (lower risk).** The manager already holds the
  ServiceAccount token and already runs the decision agent in-process, so
  embedding `OpenCode.create()` in the manager crosses **no new security
  boundary**. It removes one container, `waitForOpencodeWeb`, and most of the
  HTTP client in `agent/session.ts`.
- **Track B — Worker runner host (higher value, higher risk).** Run a small
  `@opencode/sdk` **host process inside the runner container** (replacing the
  `opencode serve` binary) and load a Percussionist plugin that registers tools,
  permission rules, agents, and provider/model transforms. The dispatcher
  container keeps the SA token and continues to talk to the runner over
  localhost. **Do not embed OpenCode in the dispatcher process**: that would put
  AI-generated code execution in the same process that holds the cluster
  credential and would break the documented security model.

Because Track B replaces the OpenCode binary/contract that the entire dispatcher,
stats reporter, and web stack depend on, its first step must be a **spike** that
captures the actual v2 wire contract and message/part schema and proves the SDK
runs in our containers. The spike is the only BUILD task created now.

**Compatibility hard requirement:** the deterministic E2E suite drives agent
behaviour through the MCP control points (`CRITICAL OVERRIDE` ClusterAgent
fixtures calling `complete_run` / `complete_plan` / `fail_run`). Any v2 adoption
must preserve those tool names, schemas and semantics, or the test fixtures and
suites must be updated in lockstep. Never trust model prose for pass/fail.

---

## Tasks

### Phase 0 — Reject/accept gate (create now)

#### BUILD 1 (critical path) — Spike: OpenCode 2 SDK feasibility + contract capture

**Agent:** builder · **Priority:** high · **No production code paths may change.**

Deliverable A — a runnable POC, isolated from production (e.g. a throwaway
package under `packages/spike-opencode-v2/` or `scripts/spike-opencode-v2/`,
excluded from the workspace build), that:

1. Adds `@opencode/sdk@2.0.10`, `@opencode/client@2.0.10`,
   `@opencode/plugin@2.0.10` with **exact pins** and records install
   behaviour under `pnpm --frozen-lockfile` with `skipLibCheck`.
2. Starts `OpenCode.create()` under **Node 24 (Alpine/musl)** and under **Bun 1.4**
   and records which runtime works. This is the go/no-go question. Include the
   `@opencode/server` `@effect/platform-node` and `@ff-labs/fff-*` findings.
3. Creates a session with `location.directory = /workspace`, sends a prompt
   against an available provider (reuse `agent-auth`/LM Studio if reachable, else
   a stubbed/mock provider), and consumes `events.subscribe()`; dumps the raw
   event payloads.
4. Loads a `Plugin.define()` instance that exercises `ctx.agent.transform`,
   `ctx.tool.transform`/`add`, `ctx.permission.rules`, `ctx.mcp.transform`, and
   `ctx.generate.text`, and records what each produces.
5. Measures cold start, RSS, and image/package size delta.
6. Tests container viability in the real base image: build a minimal Alpine/Node
   24 (or Bun) image with the packages and run the POC headless, with no SA
   token mounted.

Deliverable B — `docs/opencode-v2-assessment.md` containing:
- The **v2 vs v1 contract delta** for every endpoint/method the repo currently
  uses: `POST /session`, `POST /session/:id/message`, `GET /session/:id/message`,
  `GET /session`, `GET /event`, `GET /global/health` — and the exact v2
  replacements from `@opencode/client`.
- The **v2 message/part schema** vs the v1 shape consumed by
  `dispatcher/src/session.ts` (`msg.info.role`, `msg.parts[]`, `tool`/`tool-use`/
  `tool-result`/`step-finish`, `info.tokens`, `info.cost`), `stats-reporter.ts`,
  and the web dashboard. Identify every field that changed.
- The **v2 config/agent/MCP schema** vs `opencode.json` (`mcp`, `skills.directories`,
  agent markdown files).
- Confirmation of how plugin tools run with respect to the process/security
  boundary, and whether tools can reach the dispatcher at `127.0.0.1:4097`.
- A **go/no-go recommendation** with exact version pins and the runtime chosen.

**Acceptance criteria**
- POC runs reproducibly on a dev box/CI with documented commands.
- Both runtime results are recorded with evidence (logs), not asserted.
- Contract delta covers every v1 call site listed above.
- `pnpm typecheck` / `pnpm lint` / `pnpm test` remain green (spike is isolated).
- No changes to `packages/operator`, `packages/dispatcher`,
  `packages/manager-controller`, `k8s/`, or the pinned images.
- Assessment doc committed at `docs/opencode-v2-assessment.md` (or a clearly
  linked location) and referenced from `README.md`/`docs/architecture.md` only if
  a small doc pointer is agreed.

**Stop condition / gate:** if Node 24 and Bun both fail to host the SDK, or the
packages require UI/OpenTUI peer deps that cannot be installed headlessly, the
recommendation is **no-go for now**, the follow-up tracks below are dropped, and
the only follow-up is to re-check at the next v2 minor.

---

### Phase 1 — Follow-ups, only after a documented go (do NOT create yet)

These are ordered by risk/complexity. Each must land on the existing suite and
be independently revertible.

#### BUILD 2 — Manager: typed client migration (Track A1)
Replace the raw HTTP helpers in `packages/manager-controller/src/agent/session.ts`
with `@opencode/client` (or the SDK client if Track A2 lands first). Reimplement
`waitForCompletion` using the v2 wait/event API instead of polling. Update
`chat-handler.ts`, `stats-reporter.ts`, and `session-summarizer.ts` call sites.
Unit tests under `agent/__tests__/`. Keep `OPENCODE_URL` external-server mode
working so it can ship before embedding.

#### BUILD 3 — Manager: embed the SDK and delete the `opencode-web` sidecar (Track A2)
Add `@opencode/sdk` embedding in `packages/manager-controller`, remove the
`opencode-web` container (and its readiness probe/env) from
`k8s/deploy/manager-controller.yaml`, remove `waitForOpencodeWeb`, and simplify
the `agent-config` rollout-hash plumbing if the manager can read config directly.
Consider replacing `session-summarizer.ts`'s session dance with transient
generation. Keep the manager runtime Node unless BUILD 1 mandates Bun.

#### BUILD 4 — Dispatcher: typed client + event iterables (Track B1)
Replace `dispatcher/src/session.ts` fetches and the `polling.ts` SSE/polling
loops with `@opencode/client` methods and `event.subscribe()`. Preserve the Run
status contract and snapshot/compaction behaviour. Update
`dispatcher/src/__tests__/sse-stream.test.ts`, `poll-status.test.ts`,
`session.test.ts`. This is independent of the runner host and can validate v2
against the stock `opencode serve` v2 binary first.

#### BUILD 5 — Runner host + `@percussionist/opencode-plugin` (Track B2, largest)
Add a runner-host process (new package, e.g. `packages/runner-opencode`) that
starts `OpenCode.create({ plugins: [percussionistPlugin] })` inside the runner
container. The plugin:
- registers the dispatcher lifecycle tools (same names/schemas as today) that
  forward to the dispatcher endpoint;
- sets `ctx.permission.rules` so headless runs never stall on a prompt;
- maps agents from the resolved `ClusterAgent` roster via `ctx.agent.transform`;
- maps providers/models from runner config via provider/model transforms.
Wire it as an **opt-in** `RunnerImageSpec`/engine (leave `opencode serve` v1 as
the fallback), updating `pod-builder.ts` command/health handling and
`packages/api/src/index.ts` defaults. Keep the dispatcher container and SA-token
boundary. Validate with `pnpm e2e:core`.

#### BUILD 6 — Delete the legacy MCP config path (Track B3)
Once BUILD 5's tools are authoritative, remove `injectDispatcherMcpStanza` and
the MCP stanza in `ensureOpencodeConfig`, shrink/retire `dispatcher/src/mcp-server.ts`,
and update `docs/guide/configuration.md`, `docs/reference/mcp-tools.md`, and the
operator unit tests (`reconciler-cluster-settings.test.ts`,
`reconciler.test.ts`). Confirm all `k8s/tests/*` ClusterAgent fixtures still pass.

#### BUILD 7 (backlog, optional) — Worktree/VCS strategy plugin
Register a `ctx.worktree.transform` strategy backed by the data-PVC git mirror
and map `ctx.vcs` to the board's diff view. Only if Tracks A/B prove stable.

---

## Scope boundaries

- **In scope:** the feasibility spike, the assessment doc, and (post-gate) the
  incremental client/embedding/plugin migration tracks above.
- **Out of scope for this plan:** CRD/schema changes; board/web UI changes;
  the operator reconciler; adopting Cloudflare Durable Objects; any change to
  the two-container SA-token security boundary in run pods; auto-upgrading the
  pinned `1.18.21` image without a deliberate release step.
- **Non-goal:** deleting `runner-claude`. Its hand-rolled v1 HTTP adapter will
  need updating if the dispatcher moves to v2, but engine parity work is a
  separate decision that follows the spike findings.
- **Version pins that a real upgrade would touch (recorded for the spike):**
  `images/runner/Dockerfile` `ARG RUNNER_BASE`,
  `k8s/deploy/manager-controller.yaml` sidecar image,
  `packages/api/src/index.ts` `OPENCODE_RUNNER_DEFAULTS.image`, and the default
  command in `packages/operator/src/pod-builder.ts`.

## Risks / open questions

1. **Runtime support (highest).** `@opencode/sdk` → `@opencode/server` →
   `@effect/platform-node` implies Node, but `@opencode/core` hard-depends on
   `bun-pty`, `@ff-labs/fff-bun` and `@lydell/node-pty`/`@ff-labs/fff-node`, and
   the client/plugin declare `solid-js`/`@opentui/*` peers. Does the SDK run on
   Node 24 Alpine/musl, only Bun, or neither without UI deps? Spike answer decides
   everything.
2. **Effect 4.0.0-rc.112.** An RC transitive dependency is a churn and
   reproducibility risk; pin exact versions and avoid leaking Effect types into
   our public packages.
3. **Breaking contract.** The v2 client is location-scoped and method-shaped
   differently from v1. `dispatcher/src/session.ts`/`polling.ts`,
   `runner-claude`, and the message-part consumers (`stats-reporter.ts`, web
   session views) all assume the v1 shape. A silent schema change would break
   stats/snapshots — the spike must diff the schema field by field.
4. **Test-fixture compatibility.** Deterministic E2E depends on the MCP tool
   control points. Tool renames or schema drift would silently break the
   `CRITICAL OVERRIDE` fixtures. Preserve names/schemas or update fixtures in the
   same change.
5. **Security boundary.** Any embedding of OpenCode into a process holding the
   SA token (dispatcher, manager) must be scrutinised. Manager embedding is
   acceptable (it already holds the token); dispatcher embedding is **not**.
6. **Offline/air-gapped installs.** v2 pulls a large Effect/AI-SDK/OpenTUI
   dependency tree and a native binary (`@opencode/cli` postinstall). The image
   build must vendor or pre-fetch these; confirm it works without public network
   at image-build time.
7. **Image/base-image change.** `ghcr.io/anomalyco/opencode:2.0.x` may change the
   bundled Bun/Node versions and toolchain (the runner image layers git/ssh/pnpm
   on top of it). Validate `runner-doctor` and `spec.initScript` after any base
   bump.
8. **Upstream maturity.** v2.0.10 is early; APIs are marked experimental in
   places (e.g. WebSocket hooks) and a v1→v2 plugin migration guide exists.
   Pin exactly and re-evaluate on minor upgrades.
9. **Manager config plumbing.** If the manager embeds the SDK, the
   `agent-config` ConfigMap + SSA + `AGENT_CONFIG_HASH_ANNOTATION` rollout logic
   in `reconciler.ts` may need rework; scope this in BUILD 3, not the spike.

## Acceptance criteria (plan-level)

- The spike POC runs headlessly in both candidate runtimes (or clearly proves
  one works and the other does not) with committed, reproducible commands.
- `docs/opencode-v2-assessment.md` captures the v1→v2 HTTP, event, message/part,
  config/agent/MCP schema deltas for every call site named above.
- A go/no-go recommendation with pinned versions and a chosen runtime.
- No production code paths, CRDs, manifests, or image pins are modified by the
  spike.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` stay green.

## Suggested BUILD task decision summary

- **Create now:** BUILD 1 — Spike + assessment (no production changes).
- **Create only after a documented go:** BUILD 2 → BUILD 3 (manager, independent
  of runner), BUILD 4 → BUILD 5 → BUILD 6 (runner; BUILD 4/5 gated on the spike,
  BUILD 6 gated on BUILD 5).
- **Backlog/nice-to-have:** BUILD 7 (worktree/VCS), and a separate follow-up to
  reconcile `runner-claude` with the v2 contract if the dispatcher migrates.
