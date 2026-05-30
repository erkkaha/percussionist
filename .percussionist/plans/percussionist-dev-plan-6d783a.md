# PLAN: Fix Manager Ignoring Successful Facilitator (BuildGen) Output

## Context

### The Bug

When a PLAN task is approved by a human reviewer and the project flow has `plan.onApprove === "generate-builds"`, the manager transitions the task to `generating-builds` phase. In this phase, the manager should:

1. Create a **buildgen facilitator run** — an agent that reads the PLAN session context and outputs a JSON array of BUILD task definitions
2. Wait for the buildgen run to complete (Succeeded)
3. Parse the output and verify child BUILD Task CRs were created by the buildgen agent (via MCP `create_task` tool)
4. Transition the PLAN task to `done`

**The bug**: Step 1 never happens. The buildgen Run is **never created**. The task gets stuck in `generating-builds` indefinitely because:

- `decideAwaitingHuman()` transitions the task to `generating-builds` but emits no effect to create the run
- `decideGeneratingBuilds()` checks for `buildTasksFacilitatorRun` in status — if absent, it returns a no-op with just an event (`BuildGenRunCreating`) but **no effect creates the Run**
- The function `buildBuildTaskGeneratorRun()` exists in `facilitator.ts` (line 216) and builds the correct Run spec, but is **never imported or called anywhere**

### Evidence

For task `percussionist-dev-plan-7ab630`:
- BuildGen run `percussionist-dev-buildgen-percussionist-dev-plan-7ab630-2` completed with phase `Succeeded` and returned valid JSON with 4 BUILD task definitions
- But the manager never created this run in the first place — it was manually triggered or from a previous partial state
- The task remained stuck in `generating-builds` until manual intervention

### Existing Infrastructure (Already Built, Just Not Wired Up)

| Component | File | Status |
|-----------|------|--------|
| `buildBuildTaskGeneratorRun()` | `facilitator.ts:216` | ✅ Implemented but never called |
| `parseBuildTaskDefinitions()` | `facilitator.ts:620` | ✅ Implemented but never called from reconciler |
| `extractBuildTasksJson()` | `facilitator.ts:719` | ✅ Validates JSON, rejects off-script responses |
| `decideGeneratingBuilds()` | `decision.ts:744` | ✅ Detects child BUILD tasks and transitions to done |
| `buildgenStaleSeconds` timeout | `flow.ts:82` | ✅ Default 600s (10 min) — but not used in decision logic |
| Run informer triggers reconcile on phase change | `index.ts:154` | ✅ Works correctly |

## Approach

### Strategy

Fix the gap by wiring up the buildgen run creation into the reconciliation flow. The approach follows the existing pattern used for review runs (`ScheduleReviewRun` effect).

### Key Decisions

1. **New effect type `ScheduleBuildGenRun`** — Following the same pattern as `ScheduleReviewRun`, we add a new effect that the executor resolves into an actual Run CR creation. This keeps the decision engine pure (no K8s calls) and handles async run building in the executor.

2. **Make `buildBuildTaskGeneratorRun()` synchronous** — The function currently calls `getClusterSettings()` asynchronously. We change it to accept resolved runner config as a parameter (like `buildReviewRun` does), making it fully synchronous. This is necessary because effects are processed synchronously in the executor loop.

3. **Stale-timeout for empty buildgen output** — If the buildgen agent returns an empty array `[]`, no child BUILD tasks will be created, and the task would stay stuck forever. We add stale-timeout detection using the existing `buildgenStaleSeconds` config: if the buildgen run has been Succeeded for longer than the timeout with no child tasks, transition to `awaiting-human`.

4. **Parse facilitator output as fallback** — If the buildgen agent doesn't use MCP tools (malformed response), we attempt to parse its JSON output from session data and create BUILD Task CRs directly via a new effect type. This handles the case where the agent returns valid JSON but fails to call `create_task`.

## Tasks

### Task 1: Make `buildBuildTaskGeneratorRun()` synchronous

**File**: `packages/manager-controller/src/facilitator.ts` (line 216)

**Changes**:
- Remove `async` keyword from function signature
- Replace `await getClusterSettings().catch(() => undefined)` with a new parameter `runnerConfig?: { image?: string; resources?: Record<string, string> }`
- Pass `runnerConfig` directly to `resolveRunConfig()` instead of building it from cluster settings
- Update the JSDoc to document the new parameter

**Before**:
```typescript
export async function buildBuildTaskGeneratorRun(
  project: Project,
  planTask: Task,
  succeededRunName: string,
  runName: string,
  sessionSummary: string,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
  allTasks: Task[] = [],
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: { image: clusterSettings?.spec?.runner?.image, resources: clusterSettings?.spec?.runner?.resources },
  });
```

**After**:
```typescript
export function buildBuildTaskGeneratorRun(
  project: Project,
  planTask: Task,
  succeededRunName: string,
  runName: string,
  sessionSummary: string,
  runnerConfig?: { image?: string; resources?: Record<string, string> },
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME,
  allTasks: Task[] = [],
): Run {
  const resolved = resolveRunConfig(project.spec, undefined, undefined, {
    runner: runnerConfig ?? { image: undefined, resources: undefined },
  });
```

**Tests**: Update any existing tests that call this function (if any). The function is currently unused so no test changes needed.

---

### Task 2: Add `ScheduleBuildGenRun` effect type to effects.ts

**File**: `packages/manager-controller/src/reconciler/effects.ts`

**Changes**:
1. Add new union member to `ReconcileEffect`:
```typescript
| { type: "ScheduleBuildGenRun"; planTaskName: string; succeededRunName: string; sessionSummary: string }
```

2. Add handler in the `executeEffects()` switch statement (after `ScheduleReviewRun` case):
```typescript
case "ScheduleBuildGenRun": {
  if (!project) throw new Error("Project metadata required for ScheduleBuildGenRun effect");
  const fullProject = project as unknown import("@percussionist/api").Project;
  const planTask = allTasks.find(t => t.metadata.name === effect.planTaskName);
  if (!planTask) throw new Error(`Plan task ${effect.planTaskName} not found`);
  
  const { buildBuildTaskGeneratorRun } = await import("../facilitator.js");
  const runName = auxiliaryRunName(fullProject.metadata.name, "buildgen", effect.planTaskName, String(task.status?.worker?.retryCount ?? 0));
  const buildgenRun = buildBuildTaskGeneratorRun(
    fullProject, planTask, effect.succeededRunName, runName, effect.sessionSummary,
  );
  try { await createRun(buildgenRun, namespace); } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!/already exists/i.test(msg)) throw e;
  }
  // Update task status with the buildgen run name
  effectsApplied.push("ScheduleBuildGenRun");
  break;
}
```

Wait — there's a subtlety. The `ScheduleReviewRun` effect creates the review Run but does NOT update the task status with the run name. Looking at the code more carefully:

In `decideSucceeded()` (line ~428), when transitioning to `reviewing`, it sets `statusPatch.worker.reviewRunName = reviewRunName` in the decision, AND emits `ScheduleReviewRun` effect. The executor creates the Run but the status patch is applied separately by the effects executor at line 206-211.

So for buildgen, we need to:
1. In `decideAwaitingHuman()`, set `statusPatch.worker.buildTasksFacilitatorRun = runName` AND emit a new effect
2. The effect creates the Run CR

But there's another issue: the effects executor applies status patches at the end (line 206-211), but it doesn't know about the buildgen run name because that needs to be computed in the decision function. Let me re-examine...

Actually, looking more carefully at `decideAwaitingHuman()` for PLAN + approve:
```typescript
return {
  taskName, fromPhase, toPhase: "generating-builds",
  effects: [{ type: "ClearTaskAnnotations", keys: consumedKeys }],
  events: [makeEvent(input, fromPhase, "generating-builds", "PlanApprovedGenerateBuilds")],
};
```

It doesn't set any `statusPatch`. The buildgen run name needs to be computed and stored. Let me revise the approach:

**Revised approach for Task 2**: Instead of a new effect type, we compute the buildgen run name in the decision function (using `auxiliaryRunName`) and include it in both the status patch AND emit a `CreateRun` effect with the pre-built Run spec. This is simpler because:
- The decision function can call `buildBuildTaskGeneratorRun()` synchronously now
- We use the existing `CreateRun` effect type (already handles arbitrary Run objects)
- No new effect type needed

**Revised Task 2**: Modify `decideAwaitingHuman()` to emit a `CreateRun` effect when transitioning PLAN tasks to generating-builds.

---

### Task 2 (Revised): Wire up buildgen run creation in `decideAwaitingHuman()`

**File**: `packages/manager-controller/src/reconciler/decision.ts` (line ~615-634)

**Changes**:
In the PLAN + approve branch of `decideAwaitingHuman()`, when transitioning to `generating-builds`:

```typescript
if (task.spec.type === "PLAN") {
  if (flow.plan.onApprove === "done") {
    // ... existing done path unchanged ...
  }
  
  // NEW: generate-builds path with buildgen run creation
  const sessionSummary = task.status?.worker?.sessionSummary ?? "";
  const retryCount = task.status?.worker?.retryCount ?? 0;
  const buildgenRunName = auxiliaryRunName(
    input.project.metadata.name, "buildgen", taskName, String(retryCount),
  );
  
  return {
    taskName, fromPhase, toPhase: "generating-builds",
    statusPatch: { worker: { buildTasksFacilitatorRun: buildgenRunName } },
    effects: [
      { type: "ClearTaskAnnotations", keys: consumedKeys },
      { type: "CreateRun", run: /* built in executor */ }, // See below
    ],
    events: [makeEvent(input, fromPhase, "generating-builds", "PlanApprovedGenerateBuilds")],
  };
}
```

Wait — the `CreateRun` effect takes a `Run` object directly. But we need to build it synchronously in the decision function (since decisions are pure). Since we made `buildBuildTaskGeneratorRun()` synchronous, this works:

```typescript
const { buildBuildTaskGeneratorRun } = await import("../../facilitator.js"); // Can't use dynamic import in sync code!
```

Hmm — can't use dynamic imports in a synchronous function. Let me check if the decision functions are called synchronously...

Looking at `reconciler/index.ts`, the flow is:
1. `observe()` (async) → fetches runs, builds ReconcileInput
2. `decide()` (sync) → returns ReconcileDecision  
3. `executeEffects()` (async) → applies effects

So decisions are sync but effects execution is async. The decision function can't do async work or dynamic imports.

**Revised approach**: Use a new effect type that carries the parameters, and resolve them in the executor:

```typescript
// In ReconcileEffect union:
| { type: "ScheduleBuildGenRun"; planTaskName: string; succeededRunName: string; sessionSummary: string }

// In decideAwaitingHuman():
return {
  taskName, fromPhase, toPhase: "generating-builds",
  statusPatch: { worker: { buildTasksFacilitatorRun: buildgenRunName } },
  effects: [
    { type: "ClearTaskAnnotations", keys: consumedKeys },
    { type: "ScheduleBuildGenRun", planTaskName, succeededRunName, sessionSummary },
  ],
  events: [...],
};
```

The executor resolves `ScheduleBuildGenRun` by calling the async `buildBuildTaskGeneratorRun()` (which we keep as-is for other callers) or the sync version.

Actually wait — let me re-check if there are any other callers of `buildBuildTaskGeneratorRun()`. The grep showed only 1 match (the function definition itself). So it's truly unused. We can safely change its signature.

**Final approach**:
1. Keep `buildBuildTaskGeneratorRun()` as-is (async) — or make a sync version
2. Add new effect type `ScheduleBuildGenRun` with parameters
3. In executor, resolve the effect by calling `buildBuildTaskGeneratorRun()` and creating the Run CR

But there's still the issue of computing `buildgenRunName` in the decision function (for statusPatch) vs in the executor (for actual run creation). The name must be deterministic so both agree. Since it uses `auxiliaryRunName(project, "buildgen", taskName, retryCount)` which is pure/sync, we can compute it in the decision function and pass it via a new field on the effect or statusPatch.

**Simplest approach**: Compute run name in decision, store in statusPatch, emit effect with just parameters needed to rebuild the Run:

```typescript
// Effect type:
| { type: "ScheduleBuildGenRun"; planTaskName: string; succeededRunName: string; sessionSummary: string }

// In executor handler:
case "ScheduleBuildGenRun": {
  const fullProject = project as unknown import("@percussionist/api").Project;
  const planTask = allTasks.find(t => t.metadata.name === effect.planTaskName);
  if (!planTask) throw new Error(`Plan task ${effect.planTaskName} not found`);
  
  // Need to get retryCount from current task status — but we only have the original `task`, 
  // and effects executor re-fetches it. Let me check...
```

Looking at executeEffects() more carefully:
- It takes `task` as parameter (the original task)
- It re-fetches `currentTask` to verify phase hasn't changed
- The statusPatch is applied after all effects

So in the executor, we have access to `task.status?.worker?.retryCount`. We can compute the run name there too. But then we need to make sure the statusPatch already has the correct run name... 

Actually, let me look at how this works for review runs:
- In `decideSucceeded()`: sets `statusPatch.worker.reviewRunName = reviewRunName` AND emits `ScheduleReviewRun { reviewRunName, ... }`
- The effect handler creates the Run with that same name

So both the decision and executor know the run name. For buildgen:
- Decision computes `buildgenRunName = auxiliaryRunName(project, "buildgen", taskName, retryCount)` 
- Decision sets `statusPatch.worker.buildTasksFacilitatorRun = buildgenRunName`
- Decision emits effect with parameters needed to rebuild the Run
- Executor recomputes the same name and creates the Run

This works because `auxiliaryRunName()` is deterministic. Let me finalize:

```typescript
// Effect type in effects.ts:
| { type: "ScheduleBuildGenRun"; planTaskName: string; succeededRunName: string; sessionSummary: string }

// In decision.ts decideAwaitingHuman() PLAN+approve branch:
const retryCount = task.status?.worker?.retryCount ?? 0;
const buildgenRunName = auxiliaryRunName(input.project.metadata.name, "buildgen", taskName, String(retryCount));

return {
  taskName, fromPhase, toPhase: "generating-builds",
  statusPatch: { worker: { buildTasksFacilitatorRun: buildgenRunName } },
  effects: [
    { type: "ClearTaskAnnotations", keys: consumedKeys },
    { type: "ScheduleBuildGenRun", planTaskName: taskName, succeededRunName: task.status?.worker?.runName ?? "", sessionSummary: "" },
  ],
  events: [...],
};
```

Wait — what's the `succeededRunName`? For buildgen, it should be the PLAN worker run name. Let me check... Looking at `buildBuildTaskGeneratorRun()`:
- It takes `succeededRunName` as parameter (the PLAN task's completed worker run)
- The facilitation spec includes `targetRunName: succeededRunName`

So we need to pass the PLAN task's worker run name. This is in `task.status?.worker?.runName`.

**Executor handler for ScheduleBuildGenRun**:
```typescript
case "ScheduleBuildGenRun": {
  if (!project) throw new Error("Project metadata required for ScheduleBuildGenRun effect");
  const fullProject = project as unknown import("@percussionist/api").Project;
  const planTask = allTasks.find(t => t.metadata.name === effect.planTaskName);
  if (!planTask) throw new Error(`Plan task ${effect.planTaskName} not found`);
  
  // Recompute run name (must match what decision computed)
  const retryCount = currentTask.status?.worker?.retryCount ?? 0;
  const buildgenRunName = auxiliaryRunName(fullProject.metadata.name, "buildgen", effect.planTaskName, String(retryCount));
  
  const { buildBuildTaskGeneratorRun } = await import("../facilitator.js");
  // Need to pass runner config — but we don't have it here synchronously.
  // We need to make buildBuildTaskGeneratorRun accept resolved config as param.
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  const buildgenRun = buildBuildTaskGeneratorRun(
    fullProject, planTask, effect.succeededRunName, buildgenRunName, effect.sessionSummary,
    { image: clusterSettings?.spec?.runner?.image, resources: clusterSettings?.spec?.runner?.resources },
  );
  try { await createRun(buildgenRun, namespace); } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!/already exists/i.test(msg)) throw e;
  }
  effectsApplied.push("ScheduleBuildGenRun");
  break;
}
```

Hmm, but this still calls `getClusterSettings()` in the executor. That's fine since the executor is async — it just means we keep the original async signature of `buildBuildTaskGeneratorRun()`. But then why did I want to make it sync? 

Let me reconsider: if we keep it async and call from the executor, that works perfectly. The only reason to make it sync was for calling from the decision function, but we're NOT calling it from there — we're computing the run name separately using `auxiliaryRunName()`.

So the simplest approach is:
1. **Keep `buildBuildTaskGeneratorRun()` as-is** (async) — no changes needed to its signature
2. Add new effect type `ScheduleBuildGenRun` 
3. In executor, resolve it by calling `getClusterSettings()` and then `buildBuildTaskGeneratorRun()`

This is the cleanest approach with minimal changes. Let me finalize the plan.

---

### Task 2 (Final): Add `ScheduleBuildGenRun` effect type and handler

**File**: `packages/manager-controller/src/reconciler/effects.ts`

1. Add to `ReconcileEffect` union:
```typescript
| { type: "ScheduleBuildGenRun"; planTaskName: string; succeededRunName: string }
```

2. Add case in `executeEffects()` switch (after `ScheduleReviewRun`):
```typescript
case "ScheduleBuildGenRun": {
  if (!project) throw new Error("Project metadata required for ScheduleBuildGenRun effect");
  const fullProject = project as unknown import("@percussionist/api").Project;
  const planTask = allTasks.find(t => t.metadata.name === effect.planTaskName);
  if (!planTask) throw new Error(`Plan task ${effect.planTaskName} not found`);
  
  const { buildBuildTaskGeneratorRun, getClusterSettings } = await import("../facilitator.js");
  // Need to also import getClusterSettings from kube — or handle it inside facilitator
  // Actually, buildBuildTaskGeneratorRun already calls getClusterSettings internally.
  // But we need the run name. Let's compute it here too for consistency.
  
  const retryCount = currentTask.status?.worker?.retryCount ?? 0;
  const { auxiliaryRunName } = await import("../worker-builder.js");
  const buildgenRunName = auxiliaryRunName(fullProject.metadata.name, "buildgen", effect.planTaskName, String(retryCount));
  
  // Import getClusterSettings from kube module
  const { getClusterSettings: getCs } = await import("@percussionist/kube");
  const clusterSettings = await getCs().catch(() => undefined);
  
  const buildgenRun = await buildBuildTaskGeneratorRun(
    fullProject, planTask, effect.succeededRunName, buildgenRunName, "",
  );
  try { await createRun(buildgenRun, namespace); } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!/already exists/i.test(msg)) throw e;
  }
  effectsApplied.push("ScheduleBuildGenRun");
  break;
}
```

Wait — `buildBuildTaskGeneratorRun` is async and calls `getClusterSettings()` internally. If we call it from the executor, it will fetch cluster settings again (redundant but harmless). But there's a problem: the function signature expects specific parameters and returns a Promise<Run>. Let me check if calling it with just the required params works...

Looking at the function:
```typescript
export async function buildBuildTaskGeneratorRun(
  project, planTask, succeededRunName, runName, sessionSummary,
  facilitatorAgentName = DEFAULT_FACILITATOR_AGENT_NAME, allTasks = [],
): Promise<Run> {
  const clusterSettings = await getClusterSettings().catch(() => undefined);
  ...
}
```

It takes `runName` as a parameter. So we need to pass the computed run name. And it internally calls `getClusterSettings()` — which is fine, just redundant. The executor can call this function directly.

But wait — there's another issue. The effect handler needs access to `allTasks` (for branch resolution inside `buildFacilitatorRun`). Looking at the executeEffects signature:
```typescript
export async function executeEffects(
  task: Task, toPhase, effects, statusPatch, namespace, project, flow, allTasks,
): Promise<ExecutionResult>
```

Yes! `allTasks` is passed in. So we can pass it through.

**Final executor handler**:
```typescript
case "ScheduleBuildGenRun": {
  if (!project) throw new Error("Project metadata required for ScheduleBuildGenRun effect");
  const fullProject = project as unknown import("@percussionist/api").Project;
  const planTask = allTasks.find(t => t.metadata.name === effect.planTaskName);
  if (!planTask) throw new Error(`Plan task ${effect.planTaskName} not found`);
  
  const retryCount = currentTask.status?.worker?.retryCount ?? 0;
  const { auxiliaryRunName } = await import("../worker-builder.js");
  const buildgenRunName = auxiliaryRunName(fullProject.metadata.name, "buildgen", effect.planTaskName, String(retryCount));
  
  const { buildBuildTaskGeneratorRun } = await import("../facilitator.js");
  const buildgenRun = await buildBuildTaskGeneratorRun(
    fullProject, planTask, effect.succeededRunName, buildgenRunName, "",
    undefined, allTasks,
  );
  try { await createRun(buildgenRun, namespace); } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!/already exists/i.test(msg)) throw e;
  }
  effectsApplied.push("ScheduleBuildGenRun");
  break;
}
```

---

### Task 3: Emit `ScheduleBuildGenRun` effect in `decideAwaitingHuman()`

**File**: `packages/manager-controller/src/reconciler/decision.ts` (line ~615-634)

**Changes**: In the PLAN + approve branch, add the new effect:

```typescript
if (task.spec.type === "PLAN") {
  if (flow.plan.onApprove === "done") {
    return { /* ... existing done path ... */ };
  }
  
  // NEW: generate-builds with buildgen run creation
  const succeededRunName = task.status?.worker?.runName ?? "";
  return {
    taskName, fromPhase, toPhase: "generating-builds",
    statusPatch: {}, // No worker patch needed — executor will set it via the effect? 
                      // Actually no — the buildgen run name is computed in executor.
                      // We need to pass it somehow. Let me reconsider...
  };
}
```

Hmm, there's a chicken-and-egg problem:
- The statusPatch needs `buildTasksFacilitatorRun` set to the correct run name
- But the run name is computed in the executor (using `auxiliaryRunName`)
- The decision function doesn't know what the executor will compute

Options:
1. **Compute run name in both places** — Decision computes it for statusPatch, executor recomputes for Run creation. Both use same deterministic formula. ✅ This works because `auxiliaryRunName()` is pure and deterministic.
2. **Set run name after effect execution** — Not possible with current architecture (status patch applied at end of effects loop).
3. **Don't set buildTasksFacilitatorRun in statusPatch** — Let the executor set it via a separate PatchTaskStatus effect.

Option 1 is cleanest. The decision function computes:
```typescript
const retryCount = task.status?.worker?.retryCount ?? 0;
const buildgenRunName = auxiliaryRunName(input.project.metadata.name, "buildgen", taskName, String(retryCount));
```

And the executor recomputes the same thing. Both agree because `auxiliaryRunName()` is deterministic.

**Final decision.ts changes**:
```typescript
if (task.spec.type === "PLAN") {
  if (flow.plan.onApprove === "done") {
    return { /* ... existing done path ... */ };
  }
  
  // Generate-builds: create buildgen facilitator run
  const retryCount = task.status?.worker?.retryCount ?? 0;
  const buildgenRunName = auxiliaryRunName(input.project.metadata.name, "buildgen", taskName, String(retryCount));
  
  return {
    taskName, fromPhase, toPhase: "generating-builds",
    statusPatch: { worker: { buildTasksFacilitatorRun: buildgenRunName } },
    effects: [
      { type: "ClearTaskAnnotations", keys: consumedKeys },
      { type: "ScheduleBuildGenRun", planTaskName: taskName, succeededRunName: task.status?.worker?.runName ?? "" },
    ],
    events: [makeEvent(input, fromPhase, "generating-builds", "PlanApprovedGenerateBuilds")],
  };
}
```

---

### Task 4: Add stale-timeout handling in `decideGeneratingBuilds()`

**File**: `packages/manager-controller/src/reconciler/decision.ts` (line ~744-802)

**Problem**: If the buildgen run Succeeds but returns an empty array `[]`, no child BUILD tasks are created. The current code stays in `generating-builds` forever waiting for children that will never come.

**Solution**: Use the existing `buildgenStaleSeconds` timeout to detect this case:
- If buildgen run has been Succeeded for longer than `flow.timeouts.buildgenStaleSeconds` AND no child tasks exist → transition to `awaiting-human` with a note about manual BUILD task creation needed.

**Changes**:
```typescript
function decideGeneratingBuilds(input: ReconcileInput): ReconcileDecision {
  const { task, observed, flow, now } = input;
  // ... existing code up to child tasks check ...
  
  if (childTasks.length === 0) {
    // Check for stale buildgen run — agent may have returned empty array or failed silently.
    const buildgenRun = observed.buildgen;
    if (buildgenRun && buildgenRun.status?.phase === "Succeeded") {
      const completedAt = buildgenRun.status?.completedAt;
      if (completedAt) {
        const elapsedMs = new Date(now).getTime() - new Date(completedAt).getTime();
        const staleThresholdMs = flow.timeouts.buildgenStaleSeconds * 1000;
        if (elapsedMs > staleThresholdMs) {
          return {
            taskName, fromPhase, toPhase: "awaiting-human",
            statusPatch: { worker: { buildTasksFacilitatorRun: undefined } },
            effects: [],
            events: [makeEvent(input, fromPhase, "awaiting-human", "BuildGenStale", 
              `Buildgen run succeeded ${Math.round(elapsedMs / 1000)}s ago with no BUILD tasks created`)],
          };
        }
      }
    }
    // Buildgen still running or not yet stale — wait.
    return { taskName, fromPhase, effects: [], events: [] };
  }
  
  // ... existing child tasks exist → done path ...
}
```

---

### Task 5: Handle empty buildgen output (parse and create BUILD tasks)

**File**: `packages/manager-controller/src/reconciler/decision.ts` + `effects.ts`

**Problem**: The buildgen agent is supposed to create BUILD Task CRs via MCP `create_task`. But if it returns valid JSON without calling the tool, no tasks are created. We should parse the output and create tasks as a fallback.

**Solution**: When buildgen Succeeds but no child tasks exist (and not yet stale), attempt to parse the facilitator output. If valid BUILD task definitions are found, emit `CreateTask` effects for each one.

This requires:
1. Calling `parseBuildTaskDefinitions()` from the decision function — but it's async!
2. The decision function is sync... 

**Alternative**: Handle this in the executor after creating the buildgen run? No, that doesn't make sense timing-wise.

**Better approach**: Add a new effect type `ParseAndCreateBuildTasks` that the executor handles asynchronously:

```typescript
// In effects.ts ReconcileEffect union:
| { type: "ParseAndCreateBuildTasks"; runName: string; ns: string }
```

But this would need to be emitted from somewhere... The decision function can't call async code.

**Pragmatic approach**: Since the buildgen agent is supposed to use MCP `create_task` (which works), and parsing as fallback adds significant complexity, let's handle this in a separate concern:

1. **Primary path**: Buildgen agent uses MCP `create_task` → tasks created directly → manager detects them → PLAN transitions to done ✅
2. **Stale detection**: If no tasks after timeout → transition to awaiting-human for manual intervention ✅ (Task 4)
3. **Empty array handling**: Same as stale — if buildgen returns `[]`, the stale timeout catches it ✅

For now, we skip the parse-and-create fallback. It can be added later as an enhancement. The acceptance criteria mention parsing output but the primary mechanism is MCP tool calls.

Actually, re-reading the acceptance criteria:
> 1. After a facilitator-buildgen run completes with phase `Succeeded`, the manager must parse the output JSON array and create the corresponding BUILD task CRs

This explicitly requires parsing. So we need to implement it. Let me think about how...

**Approach**: Add a new effect type that's emitted when buildgen Succeeds but no child tasks exist yet:

```typescript
// In effects.ts:
| { type: "ParseBuildGenOutput"; runName: string }
```

But this needs to be emitted from `decideGeneratingBuilds()` which is sync. We can't call async parsing there.

**Alternative**: Emit the effect in the decision, handle it asynchronously in executor:

In `decideGeneratingBuilds()`:
```typescript
if (childTasks.length === 0) {
  // Buildgen succeeded — try to parse output and create tasks as fallback.
  const buildgenRun = observed.buildgen;
  if (buildgenRun && buildgenRun.status?.phase === "Succeeded") {
    return {
      taskName, fromPhase, effects: [
        { type: "ParseBuildGenOutput", runName: buildgenRun.metadata.name },
      ], events: [],
    };
  }
  // Still running — wait.
  return { taskName, fromPhase, effects: [], events: [] };
}
```

In executor:
```typescript
case "ParseBuildGenOutput": {
  const { parseBuildTaskDefinitions } = await import("../facilitator.js");
  const definitions = await parseBuildTaskDefinitions(effect.runName, namespace);
  if (!definitions || definitions.length === 0) break; // No valid output
  
  for (const def of definitions) {
    const buildTask = buildTaskFromDefinition(def, task, input.project, allTasks);
    effects.push({ type: "CreateTask", task: buildTask });
  }
  break;
}
```

But wait — the executor processes effects sequentially and doesn't return new effects. Looking at executeEffects():
```typescript
for (const effect of effects) {
  switch (effect.type) { ... }
  effectsApplied.push(effect.type);
}
```

It only iterates over the input `effects` array. It can't dynamically add more effects to be processed in the same call. But it CAN push `CreateTask` effects into a separate list that gets applied... Let me check if there's a pattern for this.

Looking at the code, each effect type is handled independently within the loop. The `CreateTask` handler already exists and creates tasks via K8s API. So we can have the `ParseBuildGenOutput` handler call `createTask()` directly (not emit effects):

```typescript
case "ParseBuildGenOutput": {
  const { parseBuildTaskDefinitions, buildTaskFromDefinition } = await import("../facilitator.js");
  const definitions = await parseBuildTaskDefinitions(effect.runName, namespace);
  if (!definitions || definitions.length === 0) break;
  
  for (const def of definitions) {
    const buildTask = buildTaskFromDefinition(def, task, fullProject, allTasks);
    try { await createTask(buildTask, namespace); } catch (e: unknown) {
      const msg = (e as Error).message;
      if (!/already exists/i.test(msg)) throw e;
    }
  }
  effectsApplied.push("ParseBuildGenOutput");
  break;
}
```

But `buildTaskFromDefinition` doesn't exist yet — we'd need to create it. And this adds significant complexity.

**Simpler approach**: Just call `parseBuildTaskDefinitions()` and if valid output found, use the existing MCP tool pattern or direct K8s creation. The key insight is that the buildgen agent SHOULD be using MCP `create_task` — if it's not, we fall back to parsing. But for now, let's focus on the primary fix (creating the run) and add parsing as a secondary concern.

Actually, re-reading the acceptance criteria more carefully:
> 1. After a facilitator-buildgen run completes with phase `Succeeded`, the manager must parse the output JSON array and create the corresponding BUILD task CRs

This says "must parse" — so it's required. But looking at the existing code flow, the buildgen agent is SUPPOSED to use MCP `create_task` to create tasks directly. The parsing infrastructure exists but isn't wired up because the primary mechanism is MCP tool calls.

I think the acceptance criteria are describing the DESIRED behavior (which should work via MCP), not requiring a separate parse-and-create path. The current design expects:
1. Buildgen agent outputs JSON + creates tasks via MCP `create_task`
2. Manager detects child BUILD Task CRs exist → transitions PLAN to done

The bug is that step 1 never happens because the run is never created. Fixing that should make the whole flow work.

But what if the buildgen agent returns valid JSON but doesn't call MCP? Then we need parsing as fallback. Let me include it in the plan but mark it as lower priority since the primary fix (creating the run) should resolve most cases.

**Revised approach for Task 5**: Add a `ParseBuildGenOutput` effect that's emitted when buildgen Succeeds with no child tasks yet. The executor parses output and creates BUILD Task CRs directly if valid definitions found. This serves as both:
- A fallback when MCP tool calls fail
- A way to handle the empty array case (parse returns null/empty → stale timeout catches it)

---

### Task 6: Add tests

**File**: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`

Add test cases for:
1. `awaiting-human + approve PLAN + buildgen → generating-builds with ScheduleBuildGenRun effect` (update existing test)
2. `generating-builds + buildgen stale with no children → awaiting-human` 
3. `generating-builds + buildgen succeeded with empty output → parse and create tasks`

**File**: `packages/manager-controller/src/reconciler/__tests__/effects.test.ts` (if exists, or add to decision tests)

Add test for:
4. `ScheduleBuildGenRun effect creates the buildgen Run CR`

---

## Risks / Open Questions

1. **Race condition on run creation**: If two reconcile cycles happen simultaneously, both might try to create the same buildgen Run. The `CreateRun` handler already handles "already exists" errors gracefully (ignores 409). ✅ Safe.

2. **Cluster settings availability**: `buildBuildTaskGeneratorRun()` calls `getClusterSettings()`. If cluster settings are unavailable, it falls back to undefined (`.catch(() => undefined)`). This is the same pattern used by other facilitator builders. ✅ Safe.

3. **Stale timeout value**: Default 600s (10 minutes) should be sufficient for buildgen runs. If a run takes longer, it will be marked stale and transition to awaiting-human. The user can re-trigger via manual approval. This is acceptable behavior — better than being permanently stuck.

4. **Parsing complexity**: Implementing the parse-and-create fallback adds significant code. Consider whether the MCP tool path (which already works) is sufficient for now, with parsing as a future enhancement.

5. **Session summary**: The buildgen run needs context from the PLAN worker session. Currently `sessionSummary` is passed as empty string in our effect. We should populate it from the PLAN task's status or fetch it separately. This may need additional work.

## BUILD Task Breakdown

| # | Title | Description |
|---|-------|-------------|
| 1 | Add `ScheduleBuildGenRun` effect type to effects.ts | New union member + executor handler that calls `buildBuildTaskGeneratorRun()` and creates the Run CR |
| 2 | Emit `ScheduleBuildGenRun` in `decideAwaitingHuman()` for PLAN+approve | Compute buildgen run name, set statusPatch, emit effect |
| 3 | Add stale-timeout handling in `decideGeneratingBuilds()` | Detect when buildgen Succeeded but no child tasks after timeout → transition to awaiting-human |
| 4 | Add `ParseBuildGenOutput` effect for fallback task creation | Parse facilitator output JSON and create BUILD Task CRs directly if MCP tool calls failed |
| 5 | Update tests for buildgen flow | Test cases for new decision paths, effect handling, stale timeout behavior |

## Acceptance Criteria Mapping

1. ✅ **Buildgen run created after PLAN approval** — Task 2 emits `ScheduleBuildGenRun` effect, executor creates the Run CR
2. ✅ **PLAN transitions to done after BUILD tasks created** — Existing code in `decideGeneratingBuilds()` already handles this (detects child BUILD Task CRs)
3. ✅ **Empty array → awaiting-human** — Task 3 stale timeout catches empty output; Task 4 parse effect creates no tasks → stale timeout triggers
4. ✅ **Malformed JSON handled gracefully** — Parse effect returns null for malformed JSON → stale timeout transitions to awaiting-human with informative event
5. ✅ **Unit tests** — Task 5 adds comprehensive test coverage

## Files Changed

| File | Changes |
|------|---------|
| `packages/manager-controller/src/reconciler/effects.ts` | Add `ScheduleBuildGenRun` + `ParseBuildGenOutput` effect types and handlers |
| `packages/manager-controller/src/reconciler/decision.ts` | Update `decideAwaitingHuman()` to emit buildgen effect; update `decideGeneratingBuilds()` for stale timeout |
| `packages/manager-controller/src/facilitator.ts` | (Optional) Add helper function to build BUILD Task CR from parsed definitions |
| `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` | New test cases for buildgen flow |

## Implementation Order

1. **Task 1** (effects.ts) — Foundation: add new effect types and handlers
2. **Task 2** (decision.ts) — Wire up run creation in decision function  
3. **Task 3** (decision.ts) — Add stale timeout detection
4. **Task 4** (facilitator.ts + effects.ts) — Parse-and-create fallback
5. **Task 5** (tests) — Comprehensive test coverage

Tasks 1 and 2 are the critical path; tasks 3-5 add robustness and testing.
