# Plan: Gate completion tools and agent assignment by run context

**Task:** percussionist-dev-plan-3a0500  
**Project:** percussionist-dev

## Context

### What exists today (and where)

1. **Dispatcher exposes all completion tools to all run contexts**
   - `packages/dispatcher/src/mcp-server.ts`
   - `tools/list` always returns `complete_run`, `complete_plan`, and `complete_review` together.
   - `tools/call` accepts any of those tools regardless of task/run context.
   - `complete_review` currently calls `onCompleteRun(...)`, so review completion is routed through normal success completion semantics after writing review annotations.

2. **Run pods do not carry explicit run-context env for MCP gating**
   - `packages/operator/src/pod-builder.ts`
   - Dispatcher container gets env like `RUN_PROJECT`, `RUN_BOARD_TASK`, `RUN_AGENT`, but no dedicated context enum (e.g. `worker-build`, `worker-plan`, `facilitator-review`, `facilitator-buildgen`, `facilitator-failure`).

3. **Task creation validates only roster membership, not role compatibility**
   - Manager MCP `create_task` in `packages/manager-controller/src/agent/tools.ts` validates `agent` is in project roster, but does not enforce PLAN/BUILD role rules.
   - Dispatcher MCP `create_task` in `packages/dispatcher/src/mcp-server.ts` also validates only roster membership.
   - Web route creation (`packages/web/src/server/routes/board.ts`) also validates only roster membership.

4. **Run creation allows agent override with no role guardrails**
   - Manager MCP `create_run` and `force_retry` (`packages/manager-controller/src/agent/tools.ts`) allow `agent` override and patch the run spec without checking task type vs agent role.

5. **Buildgen prompt guidance is soft and currently allows bad choices**
   - `k8s/agents/buildgen.yaml` explicitly says common agents include planner/builder/reviewer/failure-analyst/buildgen and says “Use builder for most tasks unless specialized agent needed.”
   - This is advisory only and does not prohibit assigning reviewer to BUILD tasks.

6. **Agent intent is currently encoded only in prompt text, not enforceable metadata**
   - Role intent exists in ClusterAgent content (`k8s/agents/builder.yaml`, `reviewer.yaml`, `planner.yaml`, `buildgen.yaml`, `failure-analyst.yaml`, `integrator.yaml`) but cannot be machine-validated by reconciler/MCP tooling.

### Incident fit

This exactly explains the observed failure loop: buildgen emitted `agent: reviewer` for a BUILD task; reviewer then used `complete_review`; dispatcher accepted it; task lifecycle diverged from intended build-worker semantics and retries reused the same agent.

## Scope boundaries

In scope:
- Guardrails for agent-to-task compatibility at task creation and run creation entry points.
- Dispatcher tool-surface gating by run context so incompatible completion tools are unavailable/rejected.
- Buildgen guardrails (prompt + API-level checks).
- Backward compatibility and migration behavior for existing invalid tasks.
- Optional extension policy for `failure-analyst` and `buildgen` misuse prevention.

Out of scope:
- Redesigning entire task lifecycle/flow presets.
- Replacing reviewer verdict schema.
- Non-guardrail UX enhancements beyond surfacing actionable errors.

## Approach

Use **defense-in-depth in three layers**:

1. **Assignment validation (creation-time):**
   - Reject invalid agent/type combinations when creating tasks and when overriding run agent.
2. **Tool-surface gating (execution-time):**
   - Expose only context-appropriate completion tools from dispatcher MCP and reject mismatches at `tools/call` as a second line of defense.
3. **Prompt hardening (behavioral):**
   - Strengthen buildgen/reviewer/planner prompts so model policy aligns with enforced system policy.

### Proposed normative role matrix

Initial strict policy (can be made configurable later):

- **PLAN worker tasks**: `planner` only (or allow configurable alias set with planner default).
- **BUILD worker tasks**: `builder` and `integrator` only.
- **Review facilitation runs**: `reviewer` only, and only `complete_review` as completion primitive.
- **Buildgen facilitation runs**: `buildgen` only, completion via `complete_run`.
- **Failure facilitation runs**: `failure-analyst` only, completion via `complete_run`.
- **Merge runs**: `integrator` only, completion via `complete_run`.

Assumption: project roster still gates *availability*; this matrix gates *compatibility*.

### Agent metadata enhancement (from retry feedback)

Current agent matching is name-based string comparison, which is fragile and opaque to buildgen.
To reduce ambiguity, introduce lightweight agent metadata in project roster entries:

- Extend `AgentRefSchema` (or add parallel config in `Project.spec.flow`) with optional fields such as:
  - `description`: short human-readable role intent (surfaced in prompts/UI)
  - `capabilities`: optional enum/list (e.g. `plan`, `build`, `review`, `merge`, `facilitate-failure`, `facilitate-buildgen`)
- Keep defaults backward-compatible by deriving capabilities from known names (`builder`, `reviewer`, etc.) when metadata is absent.
- Update buildgen prompt construction to include agent descriptions/capabilities instead of bare names, so model selection is guided by explicit semantics.

This can be delivered incrementally: hard-enforce known-safe defaults first, then expand to metadata-driven policies for custom agent names.

### Custom agent compatibility strategy (required for backward compatibility)

To avoid breaking deployments that use non-default names (for example `my-builder-v2`), implement guardrails with a layered resolver instead of strict name-only checks:

1. **Explicit project-level mapping (highest priority)**
   - Add optional mapping under flow/project settings (for example `flow.agentRoleMap`) from role → allowed agent names.
   - Example roles: `planWorker`, `buildWorker`, `reviewFacilitator`, `buildgenFacilitator`, `failureFacilitator`, `mergeFacilitator`.
   - This gives operators a deterministic override without requiring ClusterAgent schema migration on day one.

2. **Capability metadata (medium-term)**
   - Add optional `capabilities` metadata on agent references (or ClusterAgent spec in a follow-up) so compatibility can be inferred from declared capabilities rather than string names.

3. **Safe built-in defaults (fallback)**
   - If neither mapping nor metadata is present, fall back to built-in defaults (`builder`, `integrator`, `reviewer`, `planner`, `buildgen`, `failure-analyst`).

4. **Fail-closed only when role cannot be resolved**
   - If role resolution fails, reject with actionable error listing:
     - required role,
     - configured aliases/capabilities detected,
     - allowed agents currently recognized.

This satisfies the retry feedback requirement: initial rollout is safe for default deployments, while custom deployments can opt in via explicit alias mapping and later capabilities.

## Tasks

1. **Introduce shared agent-role compatibility helpers**
   - Add a shared utility (prefer `@percussionist/api`, alternatively manager-local then promoted) encoding:
     - run context classification
     - allowed agents by task type/run type
     - human-readable validation errors.
    - Ensure helpers accept both task-based context (PLAN/BUILD) and facilitation context (`Run.spec.facilitation.successReview`, buildgen run, merge run).
    - Include compatibility-mode behavior for custom agents (name-derived fallback now, metadata-driven in follow-up).

2. **Define run-context and agent-capability enums in API layer**
   - Add explicit, reusable enums/types for:
     - run completion context (`plan-worker`, `build-worker`, `review-facilitator`, `buildgen-facilitator`, `failure-facilitator`, `merge-facilitator`, `legacy`)
     - agent capability/role tags (if metadata extension is accepted).
   - Use these types across operator/dispatcher/manager to avoid stringly-typed drift.

3. **Add API-level validation for task creation endpoints**
   - Update manager MCP `create_task` in `packages/manager-controller/src/agent/tools.ts`:
     - after roster check, enforce compatibility (`BUILD` -> allowed build agents; `PLAN` -> planner).
   - Update dispatcher MCP `create_task` in `packages/dispatcher/src/mcp-server.ts` similarly.
   - Update web route `POST /api/projects/:project/board/tasks` in `packages/web/src/server/routes/board.ts` with same checks.
    - Return deterministic 4xx errors that explain required role and allowed agents for that task type under the resolved mapping.

4. **Add run-override validation for `create_run` and `force_retry`**
   - In `packages/manager-controller/src/agent/tools.ts`, validate `agentOverride` (and resolved phase agent where relevant) against current task context.
   - Reject invalid overrides early with explicit remediation text.
   - Keep existing admin behavior (phase override) but do not bypass role/tool safety unless an explicit admin escape hatch is added.

5. **Propagate explicit run context into dispatcher env**
   - In `packages/operator/src/pod-builder.ts`, add one or more env vars for dispatcher container (e.g. `RUN_COMPLETION_MODE` / `RUN_CONTEXT`), derived from `Run.spec`:
     - plan worker
     - build worker
     - review facilitator
     - buildgen facilitator
     - failure facilitator
     - merge facilitator
   - Keep backward-compatible default when env missing (`legacy` context with permissive behavior gated by feature flag).

6. **Implement dispatcher tool-list gating by context**
   - In `packages/dispatcher/src/mcp-server.ts`, make `tools/list` context-aware:
     - review context: include `complete_review`, exclude `complete_run`/`complete_plan`.
     - plan worker: include `complete_plan`, exclude `complete_review`.
     - build/merge/buildgen/failure contexts: include `complete_run`, exclude `complete_review` and `complete_plan` (except plan worker).
   - Preserve non-completion tools (`fail_run`, `get_status`, `create_task`, etc.) as appropriate.

7. **Implement dispatcher call-time enforcement (hard gate)**
   - In `tools/call`, reject forbidden completion tool calls even if a client bypasses tool listing.
   - Use `-32602` with clear context-specific error messages.
   - Keep `complete_review` behavior of writing review verdict annotation + completion signaling in review context only.

8. **Harden buildgen instructions and defaults**
   - Update `k8s/agents/buildgen.yaml`:
     - hard rule: BUILD tasks must use `builder` (or `integrator` only for explicit merge/integration tasks).
     - remove suggestion that reviewer/planner/failure-analyst are common BUILD assignees.
   - Update facilitator buildgen prompt builder in `packages/manager-controller/src/facilitator.ts` (`buildBuildTaskGeneratorRun`) to repeat this hard rule inline.

9. **Decide and implement policy for failure-analyst/buildgen misuse**
   - Extend same matrix so worker BUILD/PLAN tasks cannot be assigned `failure-analyst` or `buildgen`.
   - Ensure facilitation runs continue to use those agents where intended.

10. **Backward compatibility and migration handling**
   - Define behavior for existing invalid tasks in-flight:
     - Option A (recommended): do not auto-mutate; fail fast on next run creation with actionable error + facilitator guidance.
     - Option B: auto-rewrite invalid `task.spec.agent` to flow default build/planner agent and emit Task event.
   - Add explicit manager log/task-event messaging so operators can repair tasks using `set_task_state` / patch / retry with override.

11. **Add/extend deterministic tests**
   - Dispatcher unit tests (`packages/dispatcher/src/...`):
     - tool list gating by context
     - forbidden tool call rejection.
   - Manager/controller tests:
     - create_task / create_run / force_retry role validation.
   - Web route tests:
     - board task creation rejects invalid agent for type.
   - E2E test (core or extended):
     - BUILD task with reviewer agent is rejected at creation or run start and does not enter retry loop.

12. **Document guardrails**
   - Update AGENTS or architecture docs with:
     - role matrix
     - completion tool availability per run type
     - troubleshooting steps for legacy invalid tasks.

## Risks / open questions

1. **Strict name-based role checks may break custom deployments**
   - Some projects may use custom agent names (e.g., `my-builder-v2`).
   - Mitigation: support allowlisted aliases or future `ClusterAgent.spec.capabilities` metadata; initial implementation can ship with defaults + configurable mapping in flow/project settings.

2. **Need robust context detection for facilitation subtypes**
   - Review vs buildgen vs failure runs all use facilitation patterns; misclassification could expose wrong tools.
   - Mitigation: classify using explicit env from operator rather than inference-only logic.

3. **Back-compat behavior impacts operator toil**
   - Fail-fast may surface more manual fixes initially; auto-rewrite may hide intent mistakes.
   - Decision needed before implementation.

4. **Potential coupling with related merge-flow work**
   - If `complete_merge` is introduced later, this matrix must remain extensible.

## Acceptance criteria mapping

1. **Clear map of agents/tools and intended contexts**
   - Delivered via role matrix + dispatcher context mapping and docs updates.

2. **Agent-to-task validation proposal (buildgen + API-level)**
   - Enforced in buildgen prompts + manager/dispatcher/web task creation + run override paths.

3. **Tool-context gating proposal**
   - Dispatcher `tools/list` and `tools/call` enforce completion-tool availability by run context.

4. **Backward compatibility plan**
   - Explicit policy and handling for already-created invalid tasks with deterministic remediation messaging.

5. **Extension to failure-analyst/buildgen considered**
   - Included in same compatibility matrix and validation paths.

## Proposed BUILD task breakdown

1. **BUILD A — Shared compatibility matrix + validation helpers**
   - Implement reusable role/context compatibility module and unit tests.

2. **BUILD B — Enforce compatibility at task/run creation boundaries**
   - Wire checks into manager MCP (`create_task`, `create_run`, `force_retry`), dispatcher `create_task`, and web board route.

3. **BUILD C — Dispatcher completion-tool gating by run context**
   - Add run-context env wiring in operator pod builder and enforce gated `tools/list` + `tools/call` in dispatcher MCP.

4. **BUILD D — Buildgen/facilitator prompt hardening**
   - Tighten `k8s/agents/buildgen.yaml` and facilitator buildgen prompt text to forbid reviewer/planner assignment for BUILD tasks.

5. **BUILD E — Regression tests + docs**
   - Add dispatcher/manager/web tests + e2e scenario for wrong-agent prevention and document operational remediation for legacy tasks.
