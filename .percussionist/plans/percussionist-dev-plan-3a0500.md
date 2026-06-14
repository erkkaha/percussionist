# Plan: Gate completion tools and agents to prevent wrong-tool usage

**Task:** percussionist-dev-plan-3a0500  
**Project:** percussionist-dev

## Context

1. **Dispatcher currently exposes all completion tools in every run**
   - `packages/dispatcher/src/mcp-server.ts`
   - `tools/list` always returns `complete_run`, `complete_plan`, and `complete_review`.
   - `tools/call` allows all three in any run context.
   - `complete_review` writes review verdict annotation, then calls `onCompleteRun(...)`, so a non-review run can still end through review semantics.

2. **No explicit run-context signal is passed to dispatcher**
   - `packages/operator/src/pod-builder.ts`
   - Dispatcher env currently includes `RUN_PROJECT`, `RUN_BOARD_TASK`, `RUN_AGENT`, etc., but no explicit context mode like `plan-worker`, `build-worker`, `review-facilitator`, `buildgen-facilitator`, `failure-facilitator`, `merge-facilitator`.

3. **Agent validation is roster-only at task creation**
   - Manager MCP `create_task`: `packages/manager-controller/src/agent/tools.ts` (checks roster membership only).
   - Dispatcher MCP `create_task`: `packages/dispatcher/src/mcp-server.ts` (checks roster membership only).
   - Web task creation route also follows roster-only validation.

4. **Run agent override paths are not role-gated**
   - Manager MCP `create_run` and `force_retry` allow overriding `agent` without checking task type compatibility.

5. **Buildgen prompt allows unsafe agent selection**
   - `k8s/agents/buildgen.yaml` says common agents include `reviewer` and `failure-analyst`, with only soft guidance to use `builder` “for most tasks.”
   - `packages/manager-controller/src/facilitator.ts` buildgen prompt includes available agents but does not hard-forbid reviewer/planner for BUILD tasks.

6. **Relevant agent/tool intent in current system**
   - `k8s/agents/builder.yaml`: BUILD implementation agent, calls `complete_run`.
   - `k8s/agents/planner.yaml`: PLAN agent, calls `complete_plan`.
   - `k8s/agents/reviewer.yaml`: review facilitator, must call `complete_review`.
   - `k8s/agents/buildgen.yaml`: BUILD task generator facilitator, currently ends with `complete_run`.
   - `k8s/agents/failure-analyst.yaml`: failure facilitator, currently ends with `complete_run`.
   - `k8s/agents/integrator.yaml`: merge/integration implementation, uses `complete_run`.

This matches the incident: buildgen assigned `reviewer` to a BUILD task; dispatcher allowed `complete_review`; task looped with repeated wrong-agent retries.

## Scope boundaries

In scope:
- Enforce agent-to-task compatibility for PLAN/BUILD creation and run overrides.
- Gate dispatcher completion tools by run context at both listing and invocation time.
- Harden buildgen/facilitator prompts to explicitly forbid wrong BUILD assignees.
- Include `failure-analyst` and `buildgen` in guardrail matrix.

Out of scope:
- Backward compatibility logic, migration shims, alias mapping, or capability metadata rollout.
- Broad lifecycle redesign or new completion primitives.

## Approach

Apply strict fail-closed guardrails in three layers.

### 1) Agent-to-task enforcement

Define a strict matrix (name-based, no compatibility fallback):

- PLAN task agent: `planner` only.
- BUILD task agent: `builder` or `integrator` only.
- BUILD/PLAN tasks must reject: `reviewer`, `buildgen`, `failure-analyst`.

Apply this matrix consistently to:
- manager MCP `create_task`
- dispatcher MCP `create_task`
- web task creation route
- manager MCP `create_run` / `force_retry` agent overrides

### 2) Dispatcher completion-tool gating by run context

Introduce explicit run context env from operator to dispatcher (derived from `Run.spec`), then gate tools:

- `plan-worker` → expose `complete_plan` only.
- `build-worker` / `merge-facilitator` / `buildgen-facilitator` / `failure-facilitator` → expose `complete_run` only.
- `review-facilitator` → expose `complete_review` only.

Enforce in two places:
- `tools/list` (prevent accidental misuse)
- `tools/call` (hard reject bypass attempts with deterministic `-32602`)

### 3) Prompt hardening (policy alignment)

- Update `k8s/agents/buildgen.yaml` to hard-rule BUILD assignment to `builder` or `integrator` only.
- Update `buildBuildTaskGeneratorRun()` prompt in `packages/manager-controller/src/facilitator.ts` with same hard rule.

## Tasks

1. **Add shared guardrail helper(s) for strict role checks**
   - Create a shared utility (prefer manager-controller local if fastest) that validates:
     - `PLAN -> planner`
     - `BUILD -> builder|integrator`
   - Return standardized error strings used by MCP and web.

2. **Enforce strict validation in manager MCP task creation**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - In `create_task`, after roster check, enforce type/agent matrix.

3. **Enforce strict validation in dispatcher MCP task creation**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - In `handleCreateTask`, add same type/agent gate for BUILD creation.

4. **Enforce strict validation in web task creation API**
   - File: `packages/web/src/server/routes/board.ts`
   - Apply same type/agent checks before persisting Task.

5. **Enforce strict agent override checks in manager run creation paths**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - In `create_run` and `force_retry`, validate `agentOverride` for task type.
   - Reject invalid override immediately.

6. **Add run-context enum/value and inject into pod env**
   - Files: `packages/api/src/index.ts`, `packages/operator/src/pod-builder.ts`
   - Add explicit run context field/value derivation from run spec.
   - Inject dispatcher env var (e.g. `RUN_CONTEXT`).

7. **Gate dispatcher completion tools in `tools/list`**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Build per-context completion tool set; remove invalid completions from list response.

8. **Gate dispatcher completion tools in `tools/call`**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Reject invalid completion call for current context with clear error.
   - Keep review annotation write path only for review context.

9. **Harden buildgen static prompt**
   - File: `k8s/agents/buildgen.yaml`
   - Replace soft guidance with hard assignment rule.

10. **Harden dynamic buildgen facilitator prompt**
    - File: `packages/manager-controller/src/facilitator.ts` (`buildBuildTaskGeneratorRun`)
    - Add explicit hard rule and forbidden agent examples for BUILD tasks.

11. **Add tests for guardrails**
    - Dispatcher tests: context-aware `tools/list` + rejection in `tools/call`.
    - Manager tests: `create_task`, `create_run`, `force_retry` reject invalid agents.
    - Web route tests: invalid agent/type pair rejected.
    - E2E deterministic test: BUILD task with `agent: reviewer` cannot enter wrong-tool retry loop.

12. **Document strict matrix and tool/context mapping**
    - Update internal docs (AGENTS or architecture/testing docs) with definitive allowed pairs and failure behavior.

## Risks / open questions

1. **Strict name-based policy is intentionally breaking for nonstandard agent names**
   - Accepted per task instruction: no backward compatibility planning.

2. **Run-context classification must be unambiguous**
   - Need deterministic mapping from `Run.spec` to context mode for review/buildgen/failure/merge.

3. **Potential future `complete_merge` addition**
   - Current plan keeps merge under `complete_run`; context model should remain extensible.

## Acceptance criteria mapping

1. **Map of agents/tools and contexts**
   - Provided above with strict role matrix and dispatcher completion gating.

2. **Agent-to-task validation proposal (buildgen + API-level)**
   - Enforced in manager/dispatcher/web creation paths + run overrides + buildgen prompt hard rules.

3. **Tool-context gating proposal**
   - Dispatcher gates both discovery (`tools/list`) and execution (`tools/call`) by run context.

4. **Backward compatibility handling**
   - Explicitly none: fail-closed strict enforcement.

5. **Extension to failure-analyst and buildgen**
   - Included: both forbidden as PLAN/BUILD worker assignees, allowed only in facilitator contexts.

## Proposed BUILD task breakdown

1. **BUILD A — Strict role validation helper + manager/web/dispatcher task-create enforcement**
2. **BUILD B — Manager create_run/force_retry override validation**
3. **BUILD C — Operator run-context env + dispatcher tools/list + tools/call gating**
4. **BUILD D — Buildgen prompt hardening (static + dynamic)**
5. **BUILD E — Regression tests + documentation updates**
