# PLAN: Fix Human Approval of Awaiting-Human PLAN Tasks — Buildgen Run Never Created

## Context

### The Bug

When a human clicks "approve" on a PLAN task in `awaiting-human` phase, the task transitions to `generating-builds`, but **no buildgen (facilitator-buildgen) run is ever created**. The task gets stuck in an infinite loop of no-op reconciliation cycles that log `BuildGenRunCreating` events without creating any resources.

### Evidence from `percussionist-dev-plan-7ab630`

The audit log showed repeated cycles:
```
approved → PlanApprovedGenerateBuilds → BuildGenRunCreating → BuildGenFailed
```

Three `BuildGenFailed` events occurred before one successful buildgen run (`-2`) that was never processed. The referenced task `percussionist-dev-plan-bug-human-approval-no-effect` does not exist — this issue was never formally investigated.

### Root Cause Analysis

The bug is a **missing effect** in the decision engine. Two functions are involved:

#### 1. `decideAwaitingHuman` (decision.ts:580–657)

When a PLAN task is approved with `flow.plan.onApprove === "generate-builds"`, this function returns:

```typescript
// Lines 627-633
return {
    taskName,
    fromPhase,
    toPhase: "generating-builds",
    effects: [{ type: "ClearTaskAnnotations", keys: consumedKeys }],
    events: [makeEvent(input, fromPhase, "generating-builds", "PlanApprovedGenerateBuilds")],
};
```

**Problem**: Only `ClearTaskAnnotations` effect is returned. No `CreateRun` or equivalent to create the buildgen run. No `statusPatch` sets `worker.buildTasksFacilitatorRun`.

#### 2. `decideGeneratingBuilds` (decision.ts:744–802)

```typescript
// Lines 750-758
if (!buildgenRunName) {
    return {
        taskName,
        fromPhase,
        toPhase: "generating-builds",  // same phase — no-op transition
        effects: [],                     // ZERO EFFECTS
        events: [makeEvent(input, fromPhase, "generating-builds", "BuildGenRunCreating")],
    };
}
```

**Problem**: When `buildgenRunName` is not set (because it was never created), this returns a no-op with empty effects. The reconciler sees no transition and applies nothing. This repeats every reconcile cycle forever.

### Infrastructure That Exists But Is Disconnected

The buildgen infrastructure exists but is **never wired into the decision flow**:

| Component | File:Line | Purpose |
|-----------|-----------|---------|
| `buildBuildTaskGeneratorRun()` | facilitator.ts:216–320 | Builds the full Run spec for buildgen |
| `parseBuildTaskDefinitions()` | facilitator.ts:620+ | Parses JSON output from buildgen agent |
| Buildgen run observation | observations.ts:41–48 | Fetches buildgen run by name from status |
| Buildgen success handling | decision.ts:776–801 | Checks child BUILD tasks and transitions to done |

The missing link is **creating the buildgen run** when transitioning from `awaiting-human` → `generating-builds`.

### Secondary Bug: Dead End on BuildGen Failure

When a buildgen run DOES exist (from external/manual creation) and fails, `decideGeneratingBuilds` at lines 761–769 transitions back to `awaiting-human`:

```typescript
if (!buildgenRun || buildgenRun.status?.phase === "Failed") {
    return {
        taskName, fromPhase, toPhase: "awaiting-human",
        statusPatch: { worker: { buildTasksFacilitatorRun: undefined } },
        effects: [],
        events: [makeEvent(input, fromPhase, "awaiting-human", "BuildGenFailed")],
    };
}
```

But the approval annotation was already cleared in the previous transition. With no approval action available, `decideAwaitingHuman` falls through to line 656 (`return { taskName, fromPhase, effects: [], events: [] }`) — **the task is stuck forever**.

---

## Approach

### Design Decisions

1. **Follow the existing pattern for async run creation**: The decision engine is a pure function (no K8s calls). Run building happens in the effects executor where side effects are allowed. This matches how `ScheduleReviewRun` works (decision returns effect, executor builds and creates the run).

2. **Deterministic run naming**: Use `auxiliaryRunName()` with a deterministic suffix based on task name + retry count, matching the pattern used for review runs. This prevents duplicate runs across reconcile cycles.

3. **Retry within generating-builds phase**: When buildgen fails, stay in `generating-builds` and increment a retry counter rather than bouncing back to `awaiting-human`. After max retries, transition to `failed` so the task-level retry mechanism can kick in. This avoids the dead-end scenario.

4. **Minimal changes**: Only modify the decision engine and effects executor. No schema changes needed — `buildTasksFacilitatorRetryCount` is an optional field on the existing worker status object.

### Files to Change

| File | Changes |
|------|---------|
| `packages/manager-controller/src/reconciler/effects.ts` | Add `ScheduleBuildGenRun` effect type + executor handler |
| `packages/manager-controller/src/reconciler/decision.ts` | Update `decideAwaitingHuman` to create buildgen run; update `decideGeneratingBuilds` for retry logic |
| `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` | Add tests for new behavior |

---

## Tasks

### Task 1: Add `ScheduleBuildGenRun` Effect Type in effects.ts

**File**: `packages/manager-controller/src/reconciler/effects.ts`, line ~14

Add a new effect type to the union:

```typescript
export type ReconcileEffect =
  | { type: "ScheduleRun"; runName: string; retryCount: number; reworkFeedback?: string }
  | { type: "ScheduleReviewRun"; reviewRunName: string; succeededRunName: string; reviewAgent: string }
+ | { type: "ScheduleBuildGenRun"; buildgenRunName: string; succeededPlanRunName: string; facilitatorAgentName?: string }
  | { type: "CreateRun"; run: Run }
  // ... rest unchanged
```

**Executor handler**: Add a new `case` in the switch statement (after `ScheduleReviewRun`, before `CreateRun`):

```typescript
case "ScheduleBuildGenRun": {
    if (!project) {
        throw new Error("Project metadata required for ScheduleBuildGenRun effect");
    }
    const fullProject = project as unknown import("@percussionist/api").Project;
    // Import the async build function (lazy to avoid circular deps).
    const { buildBuildTaskGeneratorRun } = await import("../facilitator.js");
    
    // Get session summary from succeeded plan run if available.
    let sessionSummary = "";
    try {
        const planRun = await getRun(effect.succeededPlanRunName, namespace);
        sessionSummary = planRun?.status?.message ?? "";
    } catch { /* best-effort */ }

    // Build the buildgen run spec (async).
    const buildgenRun = await buildBuildTaskGeneratorRun(
        fullProject,
        task,                    // this is the PLAN task
        effect.succeededPlanRunName,  // the succeeded worker run of the PLAN
        effect.buildgenRunName,       // deterministic name from statusPatch
        sessionSummary,
        effect.facilitatorAgentName ?? "facilitator",
        allTasks,
    );

    try {
        await createRun(buildgenRun, namespace);
    } catch (e: unknown) {
        const msg = (e as Error).message;
        if (!/already exists/i.test(msg)) throw e;
    }
    break;
}
```

### Task 2: Update `decideAwaitingHuman` to Create Buildgen Run

**File**: `packages/manager-controller/src/reconciler/decision.ts`, lines ~615–634

Update the PLAN approval branch (lines 627–633) to include run creation:

```typescript
if (task.spec.type === "PLAN") {
    if (flow.plan.onApprove === "done") {
        // ... unchanged, lines 619-625
    }
    
    // NEW: Buildgen path — create the buildgen facilitator run.
    const succeededRunName = task.status?.worker?.runName;
    if (!succeededRunName) {
        // No worker run to generate builds from — stay in awaiting-human with warning.
        return {
            taskName,
            fromPhase,
            effects: [{ type: "ClearTaskAnnotations", keys: consumedKeys }],
            events: [makeEvent(input, fromPhase, "awaiting-human", "NoWorkerRunForBuildGen")],
        };
    }

    // Compute deterministic buildgen run name.
    const retryCount = task.status?.worker?.buildTasksFacilitatorRetryCount ?? 0;
    const { auxiliaryRunName: genAuxiliaryRunName } = await import("../worker-builder.js");
    const randomSuffix = Math.random().toString(36).slice(2, 8); // non-deterministic one-shot
    const buildgenRunName = genAuxiliaryRunName(
        input.project.metadata.name, "buildgen", taskName, randomSuffix,
    );

    return {
        taskName,
        fromPhase,
        toPhase: "generating-builds",
        statusPatch: {
            worker: {
                buildTasksFacilitatorRun: buildgenRunName,
                buildTasksFacilitatorRetryCount: retryCount,
            },
        },
        effects: [
            { type: "ClearTaskAnnotations", keys: consumedKeys },
            { type: "ScheduleBuildGenRun", buildgenRunName, succeededPlanRunName: succeededRunName },
        ],
        events: [makeEvent(input, fromPhase, "generating-builds", "PlanApprovedGenerateBuilds")],
    };
}
```

**Note**: The `auxiliaryRunName` import needs to be handled carefully since the decision engine should ideally stay synchronous. Two options:
- **Option A (preferred)**: Make `buildgenRunName` deterministic using a hash of task name + retry count (like `workerRunName`). This avoids needing async in the decision function.
- **Option B**: Keep it non-deterministic but accept that each reconcile cycle generates a different run name until the effect is executed. The idempotency check (`already exists` error) handles duplicates.

I recommend **Option A** for correctness: use `workerRunName(project, taskName, retryCount)` or a similar deterministic function. Since buildgen runs are one-shot and don't need retries with different names, we can use the same naming scheme as worker runs but with a "buildgen" prefix concept.

Actually, looking more carefully at the codebase, `auxiliaryRunName` is used for review/facilitation runs which are also one-shot. The random suffix prevents collisions when multiple reviews run in parallel on the same task. For buildgen, we only ever have ONE buildgen per PLAN approval, so a deterministic name based on task + retry count works fine:

```typescript
// In worker-builder.ts — add new function:
export function buildGenRunName(projectName: string, taskName: string, retryCount: number = 0): string {
    const sanitized = taskName.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const suffix = createHash("sha256")
        .update(`${projectName}:buildgen:${taskName}:${retryCount}`)
        .digest("hex")
        .slice(0, 10);
    const reserved = projectName.length + 1 + 1 + suffix.length;
    const maxMid = 63 - reserved;
    const mid = maxMid > 0 ? sanitized.slice(0, maxMid).replace(/-+$/, "") : sanitized.slice(0, 1);
    return truncateK8sName(`${projectName}-bg-${mid}-${suffix}`);
}
```

### Task 3: Update `decideGeneratingBuilds` for Retry Logic

**File**: `packages/manager-controller/src/reconciler/decision.ts`, lines ~760–769

Replace the unconditional transition back to `awaiting-human` with retry logic:

```typescript
if (!buildgenRun || buildgenRun.status?.phase === "Failed") {
    const retryCount = task.status?.worker?.buildTasksFacilitatorRetryCount ?? 0;
    const maxRetries = input.flow.retry.maxAttempts - 1; // reuse existing flow config
    
    if (retryCount >= maxRetries) {
        // Max retries exceeded — transition to failed.
        return {
            taskName,
            fromPhase,
            toPhase: "failed",
            statusPatch: { 
                worker: { 
                    buildTasksFacilitatorRun: undefined,
                    buildGenError: `Build generation failed after ${retryCount + 1} attempt(s)`,
                }, 
            },
            effects: [],
            events: [makeEvent(input, fromPhase, "failed", "BuildGenMaxRetriesExceeded")],
        };
    }

    // Retry — stay in generating-builds with incremented counter.
    return {
        taskName,
        fromPhase,
        toPhase: "generating-builds",
        statusPatch: {
            worker: { 
                buildTasksFacilitatorRun: undefined,  // clear so next cycle creates new run
                buildTasksFacilitatorRetryCount: retryCount + 1,
            },
        },
        effects: [],
        events: [makeEvent(input, fromPhase, "generating-builds", "BuildGenRetrying", `Attempt ${retryCount + 2}/${maxRetries + 1}`)],
    };
}
```

**Key change**: Instead of bouncing back to `awaiting-human` (which creates a dead end), we stay in `generating-builds`, clear the failed run name, and increment the retry counter. On the next reconcile cycle, `decideAwaitingHuman` won't be called again — instead, `decideGeneratingBuilds` will see no buildgenRunName and... wait, that's a problem!

**Correction**: We need to also return an effect to create the new buildgen run on retry. But effects are only applied when there's a phase transition. Let me reconsider...

Actually, looking at how `decideScheduled` works: it returns both a statusPatch (setting `worker.runName`) AND a ScheduleRun effect. The executor creates the run and patches the status atomically. On subsequent cycles, the run name is set so the decision engine observes the existing run.

For buildgen retry, we need the same pattern but within the same phase. Since no phase transition means effects aren't applied (the reconciler skips tasks with `!decision.toPhase`), we have two options:

**Option A**: Transition to a new intermediate phase like `buildgen-retrying`, then back to `generating-builds`. This is ugly.

**Option B**: Always return an effect when retrying, even without phase transition. But the reconciler only applies effects when there's a transition...

Wait, let me re-read the reconciler loop:

```typescript
// index.ts lines 51-54
if (!decision.toPhase) {
    // No decision — task stays in current phase.
    continue;
}
```

So if `toPhase` is undefined (no transition), effects are skipped entirely. This means we CAN'T apply retry effects without a phase transition.

**Revised approach for Task 3**: When buildgen fails, transition to `failed` after max retries. The task-level retry mechanism (`decideFailed`) will handle re-queuing the task at `pending`, which eventually leads back through `scheduled → initializing → running → succeeded → awaiting-human`. On re-approval, a fresh buildgen run is created with an incremented retry count.

This means:
1. Buildgen fails once → transition to `failed` (not awaiting-human)
2. Task-level retry kicks in via `decideFailed` → back to `pending`
3. Eventually task runs again through the full lifecycle
4. On re-approval, buildgen is created with incremented retry count

But this is a significant change — it means every buildgen failure triggers a full task retry cycle. That might be too aggressive.

**Alternative approach**: Keep the transition to `awaiting-human` on first failure (so human can see what happened), but DON'T clear the approval annotation. Instead, add a new annotation key like `percussionist.dev/action-reapprove-buildgen` that allows re-approval specifically for buildgen failures.

Actually, the simplest fix is: **don't transition back to awaiting-human at all**. When buildgen fails, stay in `generating-builds`, clear the run name, and on the next cycle... we're back to the no-op problem.

Let me think about this differently. The reconciler only applies effects when there's a phase transition. But what if we make the retry create a new phase? Like:

1. Buildgen fails → transition `generating-builds` → `buildgen-retrying`
2. In `buildgen-retrying`, return an effect to create a new buildgen run + transition back to `generating-builds`
3. This creates the two-phase transition needed for effects to be applied

This is similar to how `scheduled → initializing` works — the scheduled phase returns an effect that creates the run and transitions to initializing.

**Final approach**: Add a new phase `buildgen-retrying` (or reuse existing infrastructure). Actually, let me check if there's already a pattern for this...

Looking at `decideScheduled`:
```typescript
return {
    taskName, fromPhase,
    toPhase: "initializing",  // transition!
    statusPatch: { worker: { runName, ... } },
    effects: [{ type: "ScheduleRun", ... }],
};
```

The key insight is that `toPhase` must be different from `fromPhase` for effects to apply. So for buildgen retry, we need a two-step transition:

1. Buildgen fails → `generating-builds` → `failed` (with status patch clearing run name)
2. Task-level retry via `decideFailed` → `pending` → eventually back through full lifecycle
3. On re-approval → fresh buildgen creation with incremented counter

This is the cleanest approach and leverages existing infrastructure. The downside is that a single buildgen failure triggers a full task retry cycle, but this is actually desirable — it ensures proper cleanup and state management.

**Revised Task 3**: When buildgen fails, transition to `failed` (not awaiting-human). This allows the task-level retry mechanism to handle recovery. Add a new event reason `BuildGenFailed` with message explaining the failure.

### Task 4: Update Transition Table

**File**: `packages/manager-controller/src/reconciler/transitions.ts`, line ~14

Add transition from `generating-builds` → `failed`:

```typescript
"generating-builds": ["done", "awaiting-human", "failed"],
//                                              ^^^^^^ added
```

### Task 5: Add Tests

**File**: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`

Add test cases for:
1. PLAN approval with `onApprove === "generate-builds"` creates buildgen run effect + status patch
2. Buildgen failure transitions to `failed` (not awaiting-human)
3. Buildgen success with child BUILD tasks transitions to `done`
4. No worker run on approval returns no-op warning event

### Task 6: Update `buildBuildTaskGeneratorRun` Session Summary

**File**: `packages/manager-controller/src/facilitator.ts`, line ~237

Currently passes empty string for sessionSummary. The effects executor (Task 1) will pass the actual session summary from the succeeded PLAN run, which gives the buildgen agent much better context for generating BUILD tasks.

---

## Risks / Open Questions

### Risk 1: `buildBuildTaskGeneratorRun` is async
The function calls `getClusterSettings()` internally (line 225). This requires handling in the effects executor where K8s operations are allowed — which is fine since we handle it there.

### Risk 2: Deterministic run naming for buildgen
We need a deterministic name to avoid duplicate runs across reconcile cycles. The `workerRunName` pattern (SHA-256 hash) works well. Need to add a new function in `worker-builder.ts`.

### Question 1: What if the PLAN task has no worker run?
If `task.status.worker.runName` is undefined when approving, we can't create a buildgen run (no session context). The fix handles this by returning a warning event and staying in `awaiting-human`.

### Question 2: Should buildgen retries be limited separately from task-level retries?
Currently reusing `flow.retry.maxAttempts` for both. This means if the task has maxAttempts=3, the buildgen can fail up to 2 times before the whole task goes to failed. This seems reasonable — a failing buildgen is likely a systemic issue.

### Question 3: What about the `-2` run suffix in the evidence?
The `percussionist-dev-plan-7ab630` plan had a successful buildgen run with suffix `-2`. This suggests either manual intervention or an external mechanism created it. Our fix ensures the reconciler creates these runs automatically, so this scenario shouldn't recur.

---

## Acceptance Criteria (from task)

1. ✅ When human clicks "approve" on PLAN in `awaiting-human`, task transitions to `generating-builds` — **fixed by adding ScheduleBuildGenRun effect + statusPatch**
2. ✅ A buildgen run is created for the task — **fixed by new ScheduleBuildGenRun effect handler in effects executor**
3. ✅ Approval event recorded in audit log — **already works (PlanApprovedGenerateBuilds event)**
4. ✅ BuildGenFailed events are handled properly without dead-end loop — **fixed by transitioning to `failed` instead of `awaiting-human`, leveraging task-level retry mechanism**

---

## BUILD Task Breakdown

### BUILD-1: Add `buildGenRunName()` function and `ScheduleBuildGenRun` effect type
- Add deterministic run name function in `worker-builder.ts`
- Add new effect type union member in `effects.ts`

### BUILD-2: Implement `ScheduleBuildGenRun` effect handler in effects executor
- Import `buildBuildTaskGeneratorRun` lazily
- Fetch session summary from succeeded PLAN run
- Build and create the buildgen Run spec
- Handle idempotency (already exists)

### BUILD-3: Update `decideAwaitingHuman` for buildgen creation
- Compute deterministic buildgen run name
- Return ScheduleBuildGenRun effect + statusPatch with buildTasksFacilitatorRun
- Handle edge case of missing worker run

### BUILD-4: Update `decideGeneratingBuilds` retry logic and transition table
- Transition to `failed` on buildgen failure (not awaiting-human)
- Add `generating-builds → failed` to transition table
- Add tests for all new paths
