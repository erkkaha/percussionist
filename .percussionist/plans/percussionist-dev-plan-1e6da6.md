# Plan: Task flow introspection tool and lifecycle docs for manager agent

## Context

The manager already has all raw lifecycle primitives, but not a single tool that explains them in task context:

- Phase state machine is defined in `packages/manager-controller/src/reconciler/transitions.ts` via `TRANSITION_TABLE` and `isValidTransition()`.
- Resolved flow settings are computed by `resolveFlow(project)` in `packages/manager-controller/src/reconciler/flow.ts`.
- Actual “what happens next” logic lives in `decide*` functions in `packages/manager-controller/src/reconciler/decision.ts` (especially `decideSucceeded`, `decideReviewing`, `decideAwaitingHuman`, `decideAwaitingMerge`, `decideAwaitingChildren`, `decideAwaitingFeatureMerge`, `decideFailed`).
- Manager MCP tools are registered and executed in `packages/manager-controller/src/agent/tools.ts` (`TOOLS` array + `callTool` switch).
- Existing docs describe lifecycle (`docs/reference/task-lifecycle.md`, `docs/task-lifetime.md`) but are static and not surfaced as structured runtime context through MCP.

Root issue from PLAN-902b57 is consistent with this gap: phase names alone are not sufficient to infer legal transitions and flow-dependent expected next action.

## Scope boundaries

In scope:

1. Add manager MCP introspection capability (new tool) for task lifecycle visibility.
2. Return task-phase legality + resolved flow + actionable next-step guidance.
3. Update lifecycle/MCP docs to include how this tool should be used.
4. Add tests for tool schema/behavior and next-step interpretation.

Out of scope:

- Changing lifecycle semantics or transition table behavior.
- Rewriting reconcile decisions in `decision.ts`.
- Altering web UI board logic.

## Key decisions

### 1) Runtime tool vs static prompt docs

Use a **hybrid** approach:

- **Primary:** runtime MCP tool (`inspect_task_flow`) so the agent can query live task/project/run state and resolved flow.
- **Secondary:** short system-prompt guidance for manager decision agent to call `inspect_task_flow` before phase-changing actions.

Rationale: static docs alone will drift from runtime state/config, while tool-only without prompt nudging may be underused.

### 2) Source of truth for “expected next steps”

Compute human-readable guidance from existing canonical rules:

- transition legality from `TRANSITION_TABLE`
- flow config from `resolveFlow(project)`
- phase behavior from the same decision branches used by reconciler (`decision.ts`)

Implementation should avoid duplicating a second independent state machine; instead centralize a reusable “explanation” helper for both MCP output and future diagnostics.

### 3) PLAN vs BUILD handling

Tool output must include `task.spec.type` and type-specific branch interpretation (e.g., PLAN approval → `generating-builds`; BUILD approval may go `awaiting-merge` or `done` depending on flow).

## Approach

1. **Add a new MCP tool in manager-agent server**
   - Define `inspect_task_flow` in `TOOLS` (schema: `project`, `task`, optional `namespace`, optional verbosity/diagnostics toggle).
   - Implement switch case in `callTool` to load Task + Project (+ optionally relevant runs/tasks for context).

2. **Build deterministic flow-inspection result shape**
   - Return:
     - task metadata (`name`, `type`, `phase`, `worker status markers`)
     - allowed transitions (`TRANSITION_TABLE[currentPhase]`)
     - resolved flow (`resolveFlow(project)` full object)
     - flow-sensitive interpretation block (`expectedNext`, `why`, `blockingConditions`, `suggestedActions`)
     - optional `examples` for common human actions from current phase.

3. **Add explanatory helper(s) in reconciler layer**
   - Introduce helper module (e.g., `packages/manager-controller/src/reconciler/flow-introspection.ts`) that:
     - accepts `(task, project, allTasks, observedRuns?)`
     - computes summary from `Task.status.phase`, `task.spec.type`, `resolveFlow(project)`, `TRANSITION_TABLE`
     - maps known high-signal states to explicit narratives (e.g., `awaiting-human` + BUILD + `build.onApprove=merge` + `merge.mode!=disabled` ⇒ “human approve should transition to awaiting-merge”).
   - Keep helper read-only and side-effect free.

4. **Wire docs and operator-facing guidance**
   - Update `docs/reference/mcp-tools.md` with new tool contract and example responses.
   - Update `docs/reference/task-lifecycle.md` or `docs/task-lifetime.md` with a short “introspect current task flow” section mapping this tool to troubleshooting.
   - Update default manager decision-agent content in `packages/operator/src/reconciler.ts` to instruct using `inspect_task_flow` before lifecycle-changing tool calls when uncertain.

5. **Add tests**
   - Tool registration + switch-case coverage tests in `packages/manager-controller/src/agent/__tests__` (pattern used by `memory-tools.test.ts` source checks).
   - Unit tests for introspection helper covering critical branches:
     - `awaiting-human` BUILD (merge vs done)
     - `awaiting-human` PLAN (generate-builds vs done)
     - `reviewing` outcomes
     - `awaiting-merge` interpretation
     - `awaiting-children` with integration modes.
   - Ensure tests fail if transition table keys diverge from introspection logic.

## Proposed output contract (`inspect_task_flow`)

Suggested response envelope:

```json
{
  "project": "percussionist-dev",
  "task": "...",
  "taskType": "PLAN|BUILD",
  "currentPhase": "awaiting-human",
  "validTargetPhases": ["awaiting-merge", "rework-requested", "done", "failed"],
  "resolvedFlow": { "...": "full resolveFlow output" },
  "statusSummary": {
    "worker": { "runName": "...", "reviewRunName": "...", "mergeRunName": "...", "mergeError": "..." },
    "manualActionFlagsPresent": ["approved", "requestChanges", "abandon", "answer"]
  },
  "expectedNext": {
    "primary": "Await human approval; on approve transitions to awaiting-merge",
    "reason": "BUILD task + build.onApprove=merge + merge.mode=auto",
    "blockingConditions": [],
    "suggestedActions": [
      "If approved, use action-approved annotation or set_task_state only if admin override is intended",
      "If changes requested, set action-request-changes + action-rework-feedback"
    ]
  }
}
```

Notes:

- Keep this machine-readable first, natural-language second.
- Avoid embedding irreversible recommendations (e.g., don’t instruct forced admin overrides by default).

## Tasks (implementation breakdown)

1. Add `inspect_task_flow` entry to `TOOLS` in `packages/manager-controller/src/agent/tools.ts` with strict input schema.
2. Add `callTool` switch branch for `inspect_task_flow` in `tools.ts`.
3. Implement reusable introspection helper module under `packages/manager-controller/src/reconciler/` (no side effects).
4. In helper, expose function to compute:
   - current phase summary
   - valid transitions from `TRANSITION_TABLE`
   - resolved flow via `resolveFlow(project)`
   - explanatory `expectedNext` text with reason codes.
5. Add branch rules for high-risk phases (`awaiting-human`, `awaiting-merge`, `awaiting-feature-merge`, `reviewing`, `failed`, `awaiting-children`).
6. Ensure helper distinguishes PLAN vs BUILD using `task.spec.type`.
7. Include lightweight status context from task worker fields (`reviewApproved`, `reviewFeedback`, `mergeError`, `mergeRunName`, `buildTasksFacilitatorRun`, `mergedAt`).
8. Add/extend manager-agent tests to assert tool appears in TOOLS and is handled in switch-case.
9. Add unit tests for introspection helper scenarios aligned with `decision.test.ts` semantics.
10. Add docs entry in `docs/reference/mcp-tools.md` (inputs/outputs/example).
11. Add lifecycle docs note in `docs/reference/task-lifecycle.md` and/or `docs/task-lifetime.md` showing when to call tool.
12. Update default decision-agent prompt text in `packages/operator/src/reconciler.ts` to instruct proactive usage of `inspect_task_flow` when uncertain.
13. Run targeted tests for manager-controller package and docs lint/format checks as needed.
14. Verify no behavior changes to transition legality or reconcile outcomes (tooling-only introspection feature).

## Risks / open questions

1. **Logic drift risk:** if explanatory helper duplicates decision logic too literally, it can diverge from reconciler behavior over time.
   - Mitigation: keep helper declarative and add tests aligned to `decision.ts` scenarios.

2. **Ambiguity in “expected next step”:** some phases legitimately have multiple valid actions (human decision points).
   - Mitigation: return prioritized recommendation + alternatives with explicit conditions.

3. **Tool output size:** full `resolvedFlow` + status context may be verbose.
   - Mitigation: include compact default output with optional `verbose: true` expansion if needed.

4. **Prompt update coupling:** updating default manager-decision prompt in operator affects all clusters after rollout.
   - Mitigation: keep prompt changes minimal and additive, not behavioral.

## Acceptance criteria

1. Manager MCP exposes `inspect_task_flow` and returns successful response for valid `project` + `task`.
2. Response includes at minimum: current phase, valid transitions, resolved flow, and natural-language expected next step.
3. Response accurately reflects BUILD approval path (`awaiting-human` → `awaiting-merge`) when flow config requires merge.
4. Response accurately reflects PLAN approval path per flow (`generate-builds` vs `done`).
5. Tests cover tool registration/dispatch and multiple phase/type interpretation scenarios.
6. Docs include the new tool and troubleshooting guidance for phase confusion.
7. Manager decision-agent default instructions explicitly mention using this tool for lifecycle uncertainty.

## Proposed BUILD task breakdown

1. **BUILD A (manager-controller):** Implement `inspect_task_flow` MCP tool and reusable introspection helper.
2. **BUILD B (tests):** Add/extend unit tests for tool wiring and phase interpretation matrix.
3. **BUILD C (docs + prompt):** Update MCP/lifecycle docs and default manager decision-agent prompt guidance.

Dependency suggestion: A → B → C (or C can run in parallel after tool contract stabilizes).
