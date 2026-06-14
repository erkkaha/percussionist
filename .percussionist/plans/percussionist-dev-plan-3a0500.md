# Plan: Gate completion tools and agents to prevent wrong-tool usage

**Task:** percussionist-dev-plan-3a0500  
**Project:** percussionist-dev

## Context

1. **Completion tools are globally exposed in dispatcher run MCP today**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - `tools/list` currently always returns `complete_run`, `complete_plan`, and `complete_review` together.
   - `tools/call` currently allows all three in any run context.
   - `complete_review` writes verdict annotations and then calls `onCompleteRun(...)`, which means a BUILD run can be “completed” through review semantics.

2. **Agent assignment validation currently checks roster membership only**
   - Manager MCP create-task path: `packages/manager-controller/src/agent/tools.ts` (`create_task`)
   - Dispatcher MCP create-task path: `packages/dispatcher/src/mcp-server.ts` (`handleCreateTask`)
   - Web board task create path: `packages/web/src/server/routes/board.ts`
   - None of these enforce task-type compatibility (PLAN vs BUILD) for selected agent.

3. **Run-level override paths can perpetuate bad agent choice**
   - `create_run` / `force_retry` in `packages/manager-controller/src/agent/tools.ts` accept agent overrides.
   - No task-type compatibility checks are applied to override agent.

4. **No explicit agent capabilities model exists yet**
   - `ClusterAgentSpecSchema` in `packages/api/src/index.ts` has `content` and optional `model`, but no capability metadata.
   - Built-in agents under `k8s/agents/*.yaml` encode behavior in prompt prose only.

5. **Buildgen prompt guidance is advisory, not enforceable**
   - Static: `k8s/agents/buildgen.yaml`
   - Dynamic: `packages/manager-controller/src/facilitator.ts` (`buildBuildTaskGeneratorRun`)
   - Current prompt says “Use builder for most tasks,” but still permits choosing reviewer/planner-style agents for BUILD tasks.

6. **Observed incident aligns exactly with these gaps**
   - A BUILD task assigned to `reviewer` repeatedly called `complete_review`, producing verdict loops instead of implementation.
   - Retries reused the same incompatible agent, so the loop persisted.

## Scope boundaries

In scope:
- Add explicit agent capabilities and enforce them (no legacy permissive fallback behavior).
- Enforce agent↔task compatibility for task creation and run override entry points.
- Gate completion tools by run context + agent capability (advertising + execution guard).
- Harden buildgen so BUILD tasks are only assigned to implementation-capable agents.
- Cover failure-analyst and buildgen in the same capability model.

Out of scope:
- Introducing new completion tools (for example `complete_merge`).
- Redesigning task lifecycle phases.

## Approach

### A. Introduce explicit agent capability schema (fail-closed)

Add an enum and list field to `ClusterAgent.spec` in `packages/api/src/index.ts`, for example:
- `task.plan.execute`
- `task.build.execute`
- `task.build.generate`
- `task.review.evaluate`
- `task.failure.analyze`
- `task.merge.execute`
- `run.complete.plan`
- `run.complete.build`
- `run.complete.review`

Policy: **missing capability means denied**. No compatibility shim, no allow-all legacy mode.

### B. Enforce compatibility at all task/run creation entry points

Use one shared validator used by:
- manager MCP `create_task`
- dispatcher MCP `create_task`
- web board `POST /api/projects/:project/board/tasks`
- manager MCP `create_run` / `force_retry` when override agent is supplied

Rules:
- PLAN tasks require `task.plan.execute`.
- BUILD tasks require `task.build.execute`.
- buildgen-created BUILD tasks are not exempt.

### C. Gate completion tools in dispatcher by run context and capability

Apply gating in both phases:
1. `tools/list`: only include completion tool(s) valid for this run.
2. `tools/call`: reject disallowed completion calls with deterministic `-32602` error.

Run context source:
- infer from `RUN_BOARD_TASK`, task type, and `Run.spec.facilitation.successReview`
- add explicit context env from operator pod-builder if needed for clarity (`RUN_CONTEXT`)

Required mapping:
- PLAN worker run: `complete_plan` only, requires `run.complete.plan`
- BUILD/merge/buildgen/failure runs: `complete_run` only, requires `run.complete.build`
- review facilitator run: `complete_review` only, requires `run.complete.review`

### D. Buildgen and facilitator hardening

- Update buildgen static prompt (`k8s/agents/buildgen.yaml`) to hard rule: BUILD tasks must use agents with `task.build.execute`.
- Update dynamic buildgen prompt assembly (`packages/manager-controller/src/facilitator.ts`) to provide **eligible build agents only** (capability-filtered list, not raw roster).

### E. Update built-in ClusterAgent manifests to explicit capabilities

Patch agent manifests in `k8s/agents/` so defaults are valid under fail-closed enforcement:
- `planner`: `task.plan.execute`, `run.complete.plan`
- `builder`: `task.build.execute`, `run.complete.build`
- `reviewer`: `task.review.evaluate`, `run.complete.review`
- `failure-analyst`: `task.failure.analyze`, `run.complete.build`
- `buildgen`: `task.build.generate`, `run.complete.build`
- `integrator`: `task.merge.execute`, `run.complete.build`

This is required so first deployment of strict checks does not break default flows.

## Tasks

1. **API: add capability primitives and schema fields**
   - File: `packages/api/src/index.ts`
   - Add capability enum/type and `spec.capabilities` to `ClusterAgentSpecSchema`.
   - Keep schema strict: no implied defaults for missing capability entries.

2. **Manager: implement shared capability resolution + validation helper**
   - New helper under `packages/manager-controller/src/` (agent/reconciler shared location).
   - Inputs: project, task type, selected agent.
   - Output: pass/fail with deterministic message.

3. **Manager MCP create_task: enforce task-type capability checks**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - Validate after roster check, before `buildTask/createTask`.

4. **Manager MCP create_run + force_retry: enforce override compatibility**
   - File: `packages/manager-controller/src/agent/tools.ts`
   - When agent override exists, validate it for the current task type before creating run.

5. **Dispatcher MCP create_task: enforce BUILD capability checks**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Validate selected agent has `task.build.execute` before creating BUILD task.

6. **Web board API create task: enforce same capability rules**
   - File: `packages/web/src/server/routes/board.ts`
   - Ensure parity with manager/dispatcher behavior.

7. **Operator/dispatcher run-context signal for deterministic tool gating**
   - Files: `packages/operator/src/pod-builder.ts`, `packages/dispatcher/src/mcp-server.ts`
   - Inject/consume explicit run-context env if needed.

8. **Dispatcher tools/list completion gating**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Advertise only valid completion tool for that run context.

9. **Dispatcher tools/call completion gating**
   - File: `packages/dispatcher/src/mcp-server.ts`
   - Reject cross-context completion calls (`complete_review` in BUILD run, `complete_run` in review run, etc.).

10. **Buildgen hardening (static + dynamic prompts)**
    - Files: `k8s/agents/buildgen.yaml`, `packages/manager-controller/src/facilitator.ts`
    - Force capability-aware agent selection for BUILD task creation.

11. **Built-in agent manifests: add explicit capabilities**
    - Files: `k8s/agents/{planner,builder,reviewer,failure-analyst,buildgen,integrator}.yaml`
    - Ensure built-ins satisfy strict enforcement from first rollout.

12. **Web agent CRUD/UI: expose capability editing and visibility**
    - Server: `packages/web/src/server/routes/agents.ts`
    - Client types/API: `packages/web/src/client/lib/types.ts`, `packages/web/src/client/lib/api.ts`
    - UI: `packages/web/src/client/components/AgentForm.tsx`, `packages/web/src/client/components/AgentsPage.tsx`

13. **Tests: strict enforcement and wrong-tool prevention**
    - Unit tests for capability validation helper.
    - Dispatcher tests for completion-tool gating in both `tools/list` and `tools/call`.
    - Manager/dispatcher/web API tests for assignment rejection.
    - Deterministic E2E proving incompatible BUILD agent cannot be created/run and wrong-tool retry loop cannot recur.

14. **Docs updates**
    - Update MCP/tooling docs and task lifecycle docs to include capability matrix and strict fail-closed behavior.

## Backward compatibility policy (explicit)

**No backward-compatible permissive code will be added.**

Enforcement model is immediate and fail-closed:
- Agents without required capabilities are rejected.
- Disallowed completion tools are hidden and hard-rejected.
- Task/run creation paths do not permit legacy exceptions.

Operational requirement for rollout:
- Built-in `k8s/agents/*.yaml` must be updated in the same change set so default installations remain functional.
- Existing custom ClusterAgents in running clusters must be updated with capabilities before/with deployment of this change.

## Risks / open questions

1. **Strict rollout can break clusters with custom agents not updated yet**
   - Mitigation: include explicit upgrade notes and preflight checks; fail with clear error messages naming missing capability.

2. **Context detection ambiguity for special run types**
   - Mitigation: add explicit `RUN_CONTEXT` env in pod builder rather than inferring from prompts.

3. **Capability drift between prompt text and enforced behavior**
   - Mitigation: keep gating in runtime code authoritative; prompts only instructive.

4. **Buildgen/facilitator agent filtering needs deterministic source**
   - Mitigation: resolve capabilities from live ClusterAgent CRs, not free-form roster naming.

## Acceptance criteria mapping

1. **Map of agents/tools and intended contexts**
   - Delivered via explicit capability matrix and run-context completion-tool map.

2. **Agent-to-task validation proposal (buildgen + API-level)**
   - Enforced at manager/dispatcher/web creation APIs and run overrides; buildgen receives filtered eligible BUILD agents.

3. **Tool-context gating proposal**
   - Dispatcher enforces both visibility (`tools/list`) and execution (`tools/call`) gates.

4. **Backward compatibility handling**
   - Explicitly strict/fail-closed; no legacy permissive branch.

5. **Extension to failure-analyst and buildgen**
   - Included through `task.failure.analyze` / `task.build.generate` plus completion capability requirements.

## Proposed BUILD task breakdown

1. **BUILD A:** API capability schema + strict validation helper
2. **BUILD B:** Enforce compatibility in manager/dispatcher/web task/run entry points
3. **BUILD C:** Dispatcher completion-tool context/capability gating
4. **BUILD D:** Built-in agent capability updates + buildgen hardening
5. **BUILD E:** Agent UI/API capability surfaces
6. **BUILD F:** Tests + docs + rollout notes (strict mode)
