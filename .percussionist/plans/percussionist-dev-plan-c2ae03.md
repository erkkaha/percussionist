# BUG: force_retry uses default task agent instead of phase-appropriate agent for generating-builds

## Context

### The Problem

When `force_retry` is called on a PLAN task in the `generating-builds` phase, it creates a new run using the task's `spec.agent` (e.g., `"planner"`). This is incorrect because:

1. A PLAN task that has reached `generating-builds` has already been approved by human review
2. The next step should be BUILD task generation via the facilitator agent, not re-planning
3. Creating a planner run for an approved plan wastes time and produces wrong output

### Evidence

During the retrigger of `percussionist-dev-plan-7ab630`, `force_retry` created a planner run (`percussionist-dev-percussionist-dev-plan-7ab630-6c42fa2959`) even though the plan was already approved. The correct next step was to create a facilitator-buildgen run, but this had to be done manually by bypassing the tool entirely.

### Root Cause Analysis

The `force_retry` MCP tool (in `/workspace/packages/manager-controller/src/agent/tools.ts`, lines 918-997) calls `buildWorkerRun()` which defaults to `task.spec.agent`:

```typescript
// tools.ts:943
const workerRun = await buildWorkerRun(project, task, runName, retryCount, undefined, projectTasks);
if (agentOverride) workerRun.spec.agent = agentOverride;  // Only if explicitly provided
```

`buildWorkerRun()` in `/workspace/packages/manager-controller/src/worker-builder.ts:151`:
```typescript
spec: {
    ...
    agent: task.spec.agent,  // ← Always uses the Task CR's default agent
}
```

There is no phase-aware routing. The tool has no knowledge that `generating-builds` requires a different agent than what was used for initial planning.

### Additional Gap: Reconciler Does Not Create Initial Buildgen Run

The `decideGeneratingBuilds()` function in `/workspace/packages/manager-controller/src/reconciler/decision.ts:744-802` has a significant gap:

```typescript
if (!buildgenRunName) {
    return {
        taskName, fromPhase, toPhase: "generating-builds",
        effects: [],  // ← EMPTY! No effect creates the buildgen run!
        events: [makeEvent(input, fromPhase, "generging-builds", "BuildGenRunCreating")],
    };
}
```

The decision engine logs an event saying it's creating a buildgen run but produces **no effects**. This means tasks stuck in `generating-builds` with no recorded `buildTasksFacilitatorRun` will remain there indefinitely. The utility function `buildBuildTaskGeneratorRun()` exists in `/workspace/packages/manager-controller/src/facilitator.ts:216-320` but is **never called from anywhere** — it's dead code.

## Approach

### Strategy

Implement a phase-aware agent routing table that maps task phases to the appropriate agent name. This table will be used by both `force_retry` and `create_run` MCP tools, as well as the reconciler's effect system for creating initial buildgen runs.

### Key Decisions

1. **Phase-to-agent mapping**: Create a dedicated function `resolveAgentForPhase()` that returns the correct agent name based on task phase and type.
2. **Default to facilitator-buildgen for generating-builds**: When a PLAN task is in `generating-builds`, use `"facilitator-buildgen"` (the dedicated ClusterAgent defined at `/workspace/k8s/agents/facilitator-buildgen-agent.yaml`).
3. **Explicit override always wins**: If the user provides an explicit `agent` parameter to `force_retry`, it takes precedence over phase-based routing.
4. **Fix the reconciler gap**: Add a new effect type or modify `decideGeneratingBuilds` to actually create the initial buildgen run using `buildBuildTaskGeneratorRun()`.

### Agent Routing Table Design

| Phase | Task Type | Default Agent | Rationale |
|-------|-----------|---------------|-----------|
| `generating-builds` | PLAN | `facilitator-buildgen` | Build task generation from approved plan |
| `running` (retry) | any | `task.spec.agent` | Normal retry uses the same agent |
| `pending` → `scheduled` | any | `task.spec.agent` | Initial scheduling uses default |
| `rework-requested` | any | `task.spec.agent` | Rework by same agent unless facilitator says otherwise |
| `awaiting-human` | PLAN | N/A (no run) | Waiting for human decision, no worker run needed |

### Implementation Scope

**In-scope:**
1. Phase-aware agent resolution in MCP tools (`force_retry`, `create_run`)
2. Reconciler fix: create initial buildgen run when task enters `generating-builds`
3. Unit tests for the new routing logic and reconciler behavior

**Out-of-scope (future):**
- Changing how the scheduler resolves agents during normal scheduling
- Adding phase-aware agent resolution to other parts of the system that may need it later
- Modifying the facilitator's `buildBuildTaskGeneratorRun` to use `"facilitator-buildgen"` as default instead of `"facilitator"`

## Tasks

### Task 1: Create Phase-Aware Agent Resolution Function

**File:** `/workspace/packages/manager-controller/src/agent/tools.ts` (new helper function) or a new file like `agent-resolver.ts`

**Steps:**
1. Create a function `resolveAgentForPhase(task: Task, currentPhase: TaskPhase): string | undefined` that returns the phase-appropriate agent name.
2. The function should check:
   - If task is in `generating-builds` phase AND task type is PLAN → return `"facilitator-buildgen"`
   - Otherwise → return `undefined` (caller falls back to `task.spec.agent`)
3. Export the function for use by both MCP tools and reconciler effects.

**Acceptance Criteria:**
- Function correctly returns `"facilitator-buildgen"` for PLAN tasks in `generating-builds` phase
- Function returns `undefined` for all other phases (preserving existing behavior)
- Unit tests cover: generating-builds/PLAN, running/PLAN, pending/BUILD, awaiting-human/PLAN

### Task 2: Update force_retry to Use Phase-Aware Agent Resolution

**File:** `/workspace/packages/manager-controller/src/agent/tools.ts` (lines 918-997)

**Steps:**
1. After extracting `task`, `project`, and `currentPhase`, call the new resolution function.
2. If the function returns a non-undefined agent AND no explicit override was provided, use the resolved agent as the default.
3. The logic should be:
   ```typescript
   const resolvedAgent = resolveAgentForPhase(task, currentPhase);
   const effectiveAgentOverride = agentOverride ?? resolvedAgent;
   if (effectiveAgentOverride) workerRun.spec.agent = effectiveAgentOverride;
   ```

**Acceptance Criteria:**
- `force_retry` on a PLAN task in `generating-builds` creates a run with `"facilitator-buildgen"` agent
- Explicit `agent` parameter still takes precedence over phase-based resolution
- `force_retry` on tasks in other phases preserves existing behavior (uses `task.spec.agent`)

### Task 3: Update create_run to Use Phase-Aware Agent Resolution

**File:** `/workspace/packages/manager-controller/src/agent/tools.ts` (lines 797-861)

**Steps:**
1. Apply the same phase-aware agent resolution logic as in `force_retry`.
2. This ensures consistency between the two tools.

**Acceptance Criteria:**
- Same behavior as Task 2 but for `create_run` tool
- Explicit override still takes precedence

### Task 4: Fix Reconciler — Create Initial Buildgen Run Effect

**Files:** 
- `/workspace/packages/manager-controller/src/reconciler/decision.ts` (modify `decideGeneratingBuilds`)
- `/workspace/packages/manager-controller/src/reconciler/effects.ts` (add new effect type)
- `/workspace/packages/manager-controller/src/facilitator.ts` (use `"facilitator-buildgen"` as default for buildgen runs)

**Steps:**
1. Add a new effect type to `ReconcileEffect`: `{ type: "ScheduleBuildGenRun"; runName: string; sessionSummary: string }`.
2. Modify `decideGeneratingBuilds` to return this effect when `!buildgenRunName`:
   ```typescript
   if (!buildgenRunName) {
       const buildgenRunName = auxiliaryRunName(projectName, "buildgen", taskName, randomSuffix);
       return {
           taskName, fromPhase, toPhase: "generating-builds",
           effects: [{ type: "ScheduleBuildGenRun", runName: buildgenRunName, sessionSummary }],
           events: [makeEvent(input, fromPhase, "generating-builds", "BuildGenRunCreating")],
       };
   }
   ```
3. Add handler in `executeEffects` for the new effect type that calls `buildBuildTaskGeneratorRun()` and creates the Run CR.
4. Update `buildBuildTaskGeneratorRun` to use `"facilitator-buildgen"` as its default agent name (or accept it as a parameter).

**Acceptance Criteria:**
- When a PLAN task transitions to `generating-builds`, the reconciler automatically creates the buildgen run
- The buildgen run uses the `"facilitator-buildgen"` agent
- The effect is idempotent (already exists → silently skip)
- Unit tests for the new decision logic and effect handler

### Task 5: Update buildBuildTaskGeneratorRun Default Agent

**File:** `/workspace/packages/manager-controller/src/facilitator.ts` (line 222)

**Steps:**
1. Change `DEFAULT_FACILITATOR_AGENT_NAME` usage in `buildBuildTaskGeneratorRun` from `"facilitator"` to `"facilitator-buildgen"`.
2. This ensures the buildgen run uses the dedicated agent with strict permissions (no file read/write/bash).

**Acceptance Criteria:**
- Buildgen runs use `"facilitator-buildgen"` by default
- The function still accepts an override parameter for flexibility

### Task 6: Add Unit Tests

**File:** New test files or additions to existing test suites in `/workspace/packages/manager-controller/src/reconciler/__tests__/` and `/workspace/packages/manager-controller/src/agent/__tests__/`

**Steps:**
1. Test `resolveAgentForPhase()` for all phase/type combinations.
2. Test `force_retry` with explicit agent override vs. phase-based resolution.
3. Test `decideGeneratingBuilds` returns the new effect when no buildgen run exists.
4. Test the new effect handler in `executeEffects`.

**Acceptance Criteria:**
- All new code paths have test coverage
- Existing tests continue to pass (`pnpm test`)
- Typecheck passes (`pnpm typecheck`)

## Risks and Open Questions

### Risk 1: Agent Availability
The `"facilitator-buildgen"` agent is defined as a `ClusterAgent` CRD (not in the project's `spec.agents` list). The self-dev project (`percussionist-dev.yaml`) does not include it in its agents roster. Need to verify that ClusterAgents are available to all projects without explicit listing, or add it to the project's agent roster.

**Mitigation:** Check how facilitator runs currently resolve their agent name — if they already work with `"facilitator"` as a ClusterAgent, then `"facilitator-buildgen"` should work similarly.

### Risk 2: Backward Compatibility
Existing tasks that are in `generating-builds` phase without a recorded buildgen run will now get one created by the reconciler on the next reconcile cycle. This is the desired behavior (fixing the gap), but could cause unexpected runs if there are stale tasks.

**Mitigation:** The effect is idempotent — if a run already exists, it's silently skipped. Stale tasks in `generating-builds` will get their buildgen run created and proceed normally.

### Risk 3: Session Summary for Buildgen Run
The `buildBuildTaskGeneratorRun()` function requires a `sessionSummary` parameter (the completed PLAN run's session messages). The reconciler needs to fetch this from the succeeded worker run before creating the effect.

**Mitigation:** In `decideGeneratingBuilds`, when there's no buildgen run name, we need access to the succeeded worker run's session summary. This may require fetching it in the observation phase or passing it through the decision input. Alternatively, the buildgen agent can work without a detailed session summary (it has the task description and plan artifact path).

### Open Question 1: Should `create_run` also be updated?
The acceptance criteria focus on `force_retry`, but `create_run` has the same bug. Updating it ensures consistency.

**Decision:** Yes, update both tools for consistency. The phase-aware resolution is a general improvement that benefits any code path creating runs.

### Open Question 2: What about other phases?
The routing table currently only handles `generating-builds`. Should we add more mappings (e.g., `rework-requested` → facilitator, `awaiting-merge` → merge agent)?

**Decision:** Out of scope for this fix. Only address the specific bug reported (`generating-builds`). Other phase-agent mismatches can be addressed in follow-up PRs if they surface.

## Acceptance Criteria Summary

1. ✅ `force_retry` detects `generating-builds` phase on PLAN tasks and uses `"facilitator-buildgen"` agent
2. ✅ Explicit `agent` parameter on `force_retry` still takes precedence over phase-based resolution
3. ✅ Reconciler creates initial buildgen run when task enters `generating-builds` (fixing the gap)
4. ✅ Buildgen runs use `"facilitator-buildgen"` with strict permissions (no file read/write/bash)
5. ✅ Unit tests cover all new code paths
6. ✅ `pnpm typecheck` and `pnpm test` pass

## BUILD Task Breakdown

| # | Title | Description | Depends On |
|---|-------|-------------|------------|
| 1 | Create phase-aware agent resolution function | Implement `resolveAgentForPhase()` in a new or existing module | — |
| 2 | Update force_retry MCP tool for phase-aware agent selection | Apply routing to `force_retry` case handler | Task 1 |
| 3 | Update create_run MCP tool for phase-aware agent selection | Apply same routing to `create_run` case handler | Task 1 |
| 4 | Fix reconciler: create initial buildgen run effect | Add new effect type, modify `decideGeneratingBuilds`, add effect handler | — |
| 5 | Update buildBuildTaskGeneratorRun default agent | Change from `"facilitator"` to `"facilitator-buildgen"` | Task 4 |
| 6 | Add unit tests for all changes | Test routing function, MCP tools, reconciler effects | Tasks 1-5 |

