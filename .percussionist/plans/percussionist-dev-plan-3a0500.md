# Plan: Gate completion tools and agents using explicit capabilities

**Task:** percussionist-dev-plan-3a0500  
**Project:** percussionist-dev

## Context

1. **Dispatcher exposes all completion tools to every run today**
   - `packages/dispatcher/src/mcp-server.ts`
   - `tools/list` always returns `complete_run`, `complete_plan`, and `complete_review`.
   - `tools/call` accepts any of them regardless of run purpose.
   - `complete_review` currently writes the verdict and then calls `onCompleteRun(...)`, so a non-review worker can finish through review semantics.

2. **Task/agent compatibility is only “agent must exist in roster”**
   - Manager MCP `create_task`: `packages/manager-controller/src/agent/tools.ts`
   - Dispatcher MCP `create_task`: `packages/dispatcher/src/mcp-server.ts`
   - Web board task creation route: `packages/web/src/server/routes/board.ts`
   - None validates whether the chosen agent is actually capable of PLAN or BUILD execution.

3. **Retry / override paths can reassign incompatible agents**
   - Manager MCP `create_run` and `force_retry` accept `agent` overrides in `packages/manager-controller/src/agent/tools.ts`.
   - No capability check is applied to overrides.

4. **Agent model has no capability metadata yet**
   - `ClusterAgentSpecSchema` in `packages/api/src/index.ts` currently has only `content` and optional `model`.
   - Agent CRUD routes (`packages/web/src/server/routes/agents.ts`) and UI (`packages/web/src/client/components/AgentForm.tsx`, `AgentsPage.tsx`) do not support capability editing/display.

5. **Buildgen has soft guidance, not hard compatibility rules**
   - Static prompt: `k8s/agents/buildgen.yaml`
   - Dynamic prompt builder: `packages/manager-controller/src/facilitator.ts` (`buildBuildTaskGeneratorRun`)
   - Buildgen can select any roster agent, including reviewer-like agents, because there is no capability filter.

6. **Incident fit**
   - BUILD task assigned to `reviewer` produced `complete_review` verdicts repeatedly instead of implementation completion.
   - Because compatibility and tool exposure were ungated, retries repeated the same wrong behavior.

## Scope boundaries

In scope:
- Add explicit agent capabilities (not name-based role matching).
- Enforce capability-based task/agent compatibility in task creation and run override paths.
- Gate completion tools by run context and/or agent capabilities so wrong completion tools are unavailable and rejected.
- Expose and edit capabilities in the web UI.
- Include buildgen and failure-analyst in the capability model.

Out of scope:
- New task lifecycle phases or major flow redesign.
- Introducing new completion tools (e.g., `complete_merge`) in this change.

## Approach

### 1) Add explicit agent capability schema

Introduce a capability enum in `@percussionist/api` (single source of truth), stored on `ClusterAgent.spec.capabilities`.

Proposed capability set (minimum to solve this problem):
- `task.plan.execute` — may be assigned to PLAN tasks.
- `task.build.execute` — may be assigned to BUILD tasks.
- `run.complete.plan` — may call `complete_plan`.
- `run.complete.build` — may call `complete_run`.
- `run.complete.review` — may call `complete_review`.
- `task.build.generate` — may generate BUILD tasks from PLAN context (buildgen).
- `task.failure.analyze` — may run failure facilitation.
- `task.review.evaluate` — may run success review facilitation.
- `task.merge.execute` — may run merge/integration runs.

Notes:
- This avoids name-based special-casing (`reviewer`, `builder`, etc.).
- Keep capabilities additive/explicit; validation should be capability-driven only.

### 2) Capability-based compatibility checks at task and run entry points

Create a shared compatibility helper used by:
- Manager MCP `create_task`
- Dispatcher MCP `create_task`
- Web `POST /api/projects/:project/board/tasks`
- Manager MCP `create_run` / `force_retry` when `agent` override is provided

Validation rule examples:
- PLAN task assignment requires `task.plan.execute`.
- BUILD task assignment requires `task.build.execute`.
- Buildgen-created BUILD tasks must still pass the same check.

To avoid repeated cluster lookups and drift, helper should resolve capabilities from authoritative agent specs (ClusterAgent CRs; optionally allow project roster override if later added).

### 3) Completion-tool gating in dispatcher (list + call)

Gating should be done in both places:
- `tools/list`: only advertise completion tools allowed for the run context.
- `tools/call`: hard reject disallowed completion tools (`-32602`) even if client attempts direct call.

Context/capability mapping:
- PLAN worker run: require/expose `run.complete.plan` (`complete_plan` only).
- BUILD/merge/buildgen/failure runs: require/expose `run.complete.build` (`complete_run` only).
- Review facilitator runs: require/expose `run.complete.review` (`complete_review` only).

Source of truth for gating:
- Prefer explicit run context derived from `Run.spec.facilitation` + task type (already available in run metadata/env).
- Optionally combine with agent capabilities as defense-in-depth (context AND capability must allow tool).

### 4) Buildgen guardrails become capability-aware

- Update buildgen prompts (static and dynamic) to instruct selecting only agents with `task.build.execute` capability.
- In manager-side buildgen prompt assembly, provide a filtered “eligible build agents” list (capability-based) instead of raw roster names.

### 5) UI support for capabilities

Allow editing capabilities in agent management UI:
- Server routes: `packages/web/src/server/routes/agents.ts`
- Client API/types: `packages/web/src/client/lib/api.ts`, `packages/web/src/client/lib/types.ts`
- UI: `packages/web/src/client/components/AgentForm.tsx`, `AgentsPage.tsx`

Expected UX:
- Agent form includes capability multi-select/checklist.
- Agent list shows capability badges/tags.
- Validation errors surface when required capabilities for common workflows are missing.

## Tasks

1. **Define capability schema in API package**
   - Add capability enum/type and `capabilities` field to `ClusterAgentSpecSchema` in `packages/api/src/index.ts`.
   - Decide default behavior for missing capabilities (see risks) and encode explicitly.

2. **Add shared capability resolution + compatibility helper**
   - Implement reusable validation helper in manager-controller (or shared package if needed) that:
     - loads agent capabilities,
     - verifies task assignment compatibility by task type,
     - returns deterministic error text.

3. **Enforce compatibility in manager MCP `create_task`**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - After roster check, reject PLAN/BUILD task creation when chosen agent lacks required execution capability.

4. **Enforce compatibility in dispatcher MCP `create_task`**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Apply same capability check before creating BUILD task CR.

5. **Enforce compatibility in web board task creation**
   - File: `packages/web/src/server/routes/board.ts`
   - Apply same capability checks in `POST /:project/board/tasks`.

6. **Enforce compatibility in manager `create_run` and `force_retry` overrides**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - Validate `agentOverride` against task type capability requirements before run creation.

7. **Introduce explicit dispatcher run-context signal**
   - Files: `packages/operator/src/pod-builder.ts`, `packages/api/src/index.ts` (if adding enum constants)
   - Inject context env (e.g., `RUN_CONTEXT`) from run spec/facilitation intent.

8. **Implement completion-tool gating in dispatcher `tools/list`**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Return only completion tools allowed for current context/capability set.

9. **Implement completion-tool gating in dispatcher `tools/call`**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Reject disallowed completion calls with deterministic message.
   - Ensure `complete_review` path is unreachable outside review context.

10. **Capability-aware buildgen prompt hardening**
    - Files: `k8s/agents/buildgen.yaml`, `packages/manager-controller/src/facilitator.ts`
    - Instruct buildgen to choose only agents with `task.build.execute`.
    - Provide filtered eligible agent list.

11. **Expose capability editing in agent API/UI**
    - Server: `packages/web/src/server/routes/agents.ts`
    - Client types/API: `packages/web/src/client/lib/types.ts`, `packages/web/src/client/lib/api.ts`
    - UI: `packages/web/src/client/components/AgentForm.tsx`, `AgentsPage.tsx`

12. **Update compatibility checks where agent metadata is displayed/used**
    - Review project form roster surfaces (`AdvancedTab`, `useProjectForm`) for capability visibility hints.
    - Ensure no stale assumptions that agent is name-only.

13. **Add tests**
    - API schema tests for capability parsing/defaults.
    - Manager/dispatcher/web tests for capability-based rejection.
    - Dispatcher tests for completion-tool gating (`tools/list` + `tools/call`).
    - Deterministic E2E: BUILD task assigned to agent without `task.build.execute` is rejected and cannot enter wrong-tool loop.

14. **Document capability model and migration behavior**
    - Update docs describing agent capabilities, task compatibility rules, and completion-tool gating matrix.

## Backward compatibility handling

Because existing ClusterAgent CRs likely have no `capabilities` field, choose one explicit transition mode:

- **Preferred:** additive rollout with temporary permissive default for missing capabilities (`legacy-allow-all`) plus warnings/telemetry, then tighten later.
- **Alternative (strict now):** missing capabilities means incompatible by default; requires immediately updating built-in agents and existing clusters.

Plan assumption for this task: **implement a safe transitional mode first**, while still enforcing capability checks when capabilities are present. This avoids breaking all existing agents at once and allows UI-based editing to roll out cleanly.

## Risks / open questions

1. **Default behavior for missing capabilities is policy-critical**
   - Strict default improves safety but may break existing deployments instantly.
   - Transitional default reduces breakage but temporarily leaves some risk.

2. **Capability source precedence**
   - If capabilities can exist in both ClusterAgent and project roster entries later, precedence must be explicit.

3. **Context vs capability gating overlap**
   - Need clear rule when they disagree (recommended: fail closed).

4. **UI complexity / usability**
   - Too many capability flags may confuse users; may need grouped presets for common agent types.

## Acceptance criteria mapping

1. **Map of agents/tools and intended contexts**
   - Provided via explicit capability taxonomy and completion-tool matrix.

2. **Agent-to-task validation proposal (buildgen + API-level)**
   - Capability checks at manager/dispatcher/web creation points and override paths; buildgen filtered by `task.build.execute`.

3. **Tool-context gating proposal**
   - Dispatcher enforces context/capability-gated `tools/list` and `tools/call` for completion tools.

4. **Backward compatibility plan**
   - Explicit transitional handling for agents missing capabilities, with path to strict mode.

5. **Extension to failure-analyst and buildgen**
   - Included via dedicated facilitation capabilities and prompt/runtime compatibility checks.

## Proposed BUILD task breakdown

1. **BUILD A — API capability schema + shared compatibility helper**
2. **BUILD B — Enforce compatibility in manager/dispatcher/web task/run entry points**
3. **BUILD C — Dispatcher completion-tool gating by run context and capabilities**
4. **BUILD D — Buildgen capability-aware filtering + prompt hardening**
5. **BUILD E — Agent UI/API capability editing surfaces**
6. **BUILD F — Tests + docs + migration notes**
