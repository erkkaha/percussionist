# Plan: Evaluate ACP-based harness alternatives to OpenCode

## Context

Percussionist currently has a **strong OpenCode runtime coupling** across operator, dispatcher, manager-controller, web, and shared kube helpers, despite having an initial abstraction shape in `@percussionist/api`:

- `packages/api/src/index.ts`
  - Defines `RunnerAdapter` interface and `RunnerImageSpec` (adapter-like concept), but runtime code does not instantiate a concrete adapter object.
  - `OPENCODE_RUNNER_DEFAULTS` hard-codes OpenCode-specific defaults (`image`, env var names, config mount path, config key, port 4096).
- `packages/operator/src/reconciler.ts` + `packages/operator/src/pod-builder.ts`
  - Reconciles/syncs `opencode-config` and `agent-config` ConfigMaps.
  - Injects OpenCode-specific MCP config via `injectDispatcherMcp()`.
  - Builds runner pod command defaults to `opencode web ...` and sets OpenCode env var names.
- `packages/dispatcher/src/session.ts` + `packages/dispatcher/src/polling.ts`
  - Calls OpenCode HTTP endpoints directly (`/global/health`, `/session`, `/session/:id/message`, `/event`, permissions endpoints).
  - Message/event parsing assumes OpenCode schema and event types.
- `packages/manager-controller/src/agent/session.ts` + `packages/manager-controller/src/agent/index.ts`
  - Uses direct OpenCode API for manager-side decision chat.
- `packages/kube/src/index.ts` + `packages/web/src/server/routes/session.ts`
  - Live session proxying and reads use OpenCode endpoint structure and `OPENCODE_RUNNER_DEFAULTS.port`.
- Deployment manifests (`k8s/deploy/manager-controller.yaml`, `k8s/deploy/agent-config.yaml`) are explicitly OpenCode-based.

Important starting point: there is already a **cluster-level override hook** (`ClusterSettings.spec.runnerAdapter`) merged by `packages/operator/src/adapters/opencode-config.ts`, but this only affects container launch/env wiring and does not abstract protocol behavior.

## Assumptions

1. “ACP” means a protocol intended to normalize harness/runtime interaction so Percussionist can support non-OpenCode harnesses.
2. The goal is **user-selectable harness runtime** (per cluster/project/run, final scope to be decided), not replacing dispatcher/manager orchestration itself.
3. Backward compatibility for existing OpenCode projects is required.

## Scope boundaries

### In scope (PLAN)
- Compare viable architecture options for ACP adoption.
- Define an implementation path that keeps OpenCode working while enabling additional harnesses.
- Identify concrete code seams/files to change and migration strategy.

### Out of scope (for immediate BUILD unless explicitly added)
- Implementing a full non-OpenCode harness integration.
- Rewriting all runtime logic in one pass.
- Changing task/board semantics unrelated to harness I/O protocol.

## Option review

### Option A — Thin ACP translation layer in dispatcher/manager (minimal disruption)

Create protocol client modules in dispatcher and manager that speak ACP, while leaving most control flow intact.

**Pros**
- Lowest short-term blast radius.
- Fastest route to first “non-OpenCode harness works” milestone.

**Cons**
- Risks duplicating abstraction logic across packages.
- OpenCode assumptions may continue leaking in pod/web/kube layers.

### Option B — First-class harness adapter architecture (recommended)

Introduce explicit runtime abstraction package/contract and make OpenCode one adapter implementation; add ACP adapter implementation next.

**Pros**
- Cleaner long-term model.
- Makes harness selection explicit, testable, and extensible.
- Aligns with existing but underused `RunnerAdapter` concept.

**Cons**
- Higher upfront refactor cost.
- Requires coordinated changes across multiple packages.

### Option C — Sidecar compatibility gateway (ACP↔OpenCode shim)

Deploy a separate gateway sidecar translating ACP to OpenCode-like API so existing code remains mostly unchanged.

**Pros**
- Minimal source changes initially.
- Keeps operator/dispatcher mostly as-is.

**Cons**
- Adds operational complexity and another failure surface.
- Technical debt if gateway semantics diverge from native runtime behavior.

## Recommended approach

Adopt **Option B with phased delivery**, using Option A tactics in phase 1 where useful.

### Key decisions

1. **Separate “launch config” from “protocol client.”**
   - Keep `RunnerImageSpec` (how pod starts) but add explicit protocol selection and adapter client contract (how controller/dispatcher interact).
2. **OpenCode remains default adapter initially.**
   - Existing clusters continue operating without migration steps.
3. **ACP adapter becomes an additive capability.**
   - Introduce via config (cluster first; optionally project/run later).
4. **Normalize message/event schema internally.**
   - Dispatcher, manager, and web operate on neutral internal types; adapters translate protocol-specific payloads.

## Acceptance criteria (for implementation)

1. Harness protocol behavior is abstracted behind a concrete adapter interface used by dispatcher and manager agent modules (no direct OpenCode endpoint calls outside OpenCode adapter implementation).
2. Operator supports selecting harness adapter metadata/config without breaking existing OpenCode setups.
3. At least one non-OpenCode adapter path (ACP) is wired end-to-end behind feature/config selection.
4. Existing OpenCode projects run unchanged when no ACP selection is made.
5. Session streaming and completion/failure signaling still function through dispatcher MCP tools.
6. Docs and sample manifests show how users choose harness mode.

## Tasks

1. **Define canonical harness protocol model in API package**
   - Update `packages/api/src/index.ts` to formalize adapter contracts (health/session/message/event/permissions/list-sessions) and adapter selection config schema.
   - Clarify relationship between existing `RunnerImageSpec` and new protocol adapter config.

2. **Design config surface for adapter selection**
   - Extend `ClusterSettingsSpecSchema` (and optionally Project/Run inheritance path) with explicit harness protocol selection (`opencode` default, `acp` optional).
   - Document precedence rules (cluster → project → run) in code comments and docs.

3. **Refactor dispatcher to adapter-driven runtime client**
   - Introduce adapter client boundary in `packages/dispatcher/src` (replace direct OpenCode calls in `session.ts`/`polling.ts`).
   - Keep dispatcher MCP server behavior unchanged (`packages/dispatcher/src/mcp-server.ts`, `index.ts`).

4. **Refactor manager agent runtime client**
   - Replace OpenCode-specific calls in `packages/manager-controller/src/agent/session.ts` and startup checks in `agent/index.ts` with adapter-backed implementations.
   - Preserve existing manager MCP tools behavior.

5. **Decouple OpenCode-specific naming/constants in shared kube and web access paths**
   - Update `packages/kube/src/index.ts` and `packages/web/src/server/routes/session.ts` to use resolved runtime adapter/port/config instead of `OPENCODE_RUNNER_DEFAULTS` assumptions.

6. **Generalize operator config reconciliation for harness-specific config assets**
   - In `packages/operator/src/reconciler.ts` and `pod-builder.ts`, separate generic runner config handling from OpenCode-specific `opencode-config`/`agent-config` assumptions.
   - Maintain OpenCode compatibility path and add ACP-specific config map/env wiring.

7. **Implement OpenCode adapter as baseline**
   - Move current OpenCode endpoint logic into dedicated OpenCode adapter modules (dispatcher + manager runtime clients) without behavior changes.

8. **Implement ACP adapter prototype**
   - Add ACP client implementation matching the canonical adapter contract.
   - Map ACP session/events/messages to normalized internal structures.

9. **Add harness-selection plumbing through run creation**
   - Ensure run build/reconcile flow (`packages/manager-controller/src/worker-builder.ts`, `packages/operator/src/reconciler.ts`) resolves and propagates selected adapter settings to pods/sidecars.

10. **Testing matrix and regression protection**
    - Add/extend tests for adapter selection, default fallback, and core run lifecycle semantics (dispatcher completion, fail path, token updates, session snapshot behavior).
    - Include at least one ACP-path integration test (or e2e smoke equivalent) and OpenCode regression tests.

11. **Docs and migration guidance**
    - Update AGENTS/README and deployment samples to describe harness options, ACP prerequisites, and rollback/default behavior.

## Proposed BUILD task breakdown

1. **BUILD-1: API + config schema for harness selection**
   - Deliverables: schema/types, precedence docs/comments, generated CRD updates if needed.

2. **BUILD-2: Dispatcher runtime abstraction + OpenCode adapter extraction**
   - Deliverables: dispatcher uses adapter boundary; no behavioral regression.

3. **BUILD-3: Manager agent runtime abstraction + OpenCode adapter extraction**
   - Deliverables: manager chat/decision runtime uses same abstraction style.

4. **BUILD-4: Operator and pod-builder harness config generalization**
   - Deliverables: launch/config wiring supports adapter selection while preserving OpenCode defaults.

5. **BUILD-5: ACP adapter prototype implementation**
   - Deliverables: ACP client, mapping, and end-to-end run path behind config flag/selection.

6. **BUILD-6: Web/kube session access decoupling + tests**
   - Deliverables: shared helpers and web routes avoid hard OpenCode assumptions; tests pass matrix.

7. **BUILD-7: Documentation and migration notes**
   - Deliverables: user-facing docs, sample manifests, operational guidance.

## Risks / open questions

1. **ACP spec compatibility**
   - Exact ACP session/message/event semantics and permission workflow may not map 1:1 with current dispatcher assumptions.
2. **Streaming semantics differences**
   - SSE/event behavior, backpressure, and reconnect patterns may differ from OpenCode (`/event`), impacting polling logic.
3. **Manager sidecar architecture**
   - Current manager deploy embeds an OpenCode sidecar; ACP may require a different sidecar or direct remote endpoint.
4. **Config migration complexity**
   - Existing `opencode-config` and `agent-config` ownership must remain stable during transition.
5. **Operational support burden**
   - Multi-harness support expands troubleshooting surface; clear diagnostics and feature gates are needed.
6. **Scope choice**
   - Need explicit decision whether harness selection is cluster-only initially or also project/run-level in first release.

## Suggested sequencing policy

- Land BUILD-1 through BUILD-4 first to establish stable abstraction and preserve OpenCode behavior.
- Gate BUILD-5 (ACP adapter) behind feature flag/config.
- Complete BUILD-6/BUILD-7 before declaring general availability.
