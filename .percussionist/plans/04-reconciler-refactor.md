# 04 — Reconciler Refactor

## Summary

Break the 1525-line monolithic reconciler into a phase-driven architecture 
with explicit state transition handlers. Highest-risk change.

## Current Problems

1. **Monolithic**: 1525 lines, deeply nested conditionals
2. **Column-driven**: Logic branches on `status.column` conflating UI with lifecycle
3. **Implicit transitions**: State changes scattered across PULL/MONITOR/REVIEW/REWORK
4. **Side effects interleaved**: Run creation, annotation reads, status patches mixed together
5. **Fragile**: Adding a new state requires touching multiple phases

## Target Architecture

### Phase Handler Pattern

```typescript
interface PhaseContext {
  task: Task;
  project: Project;
  allTasks: Task[];
  run?: Run;
  config: ResolvedConfig;
}

interface Transition {
  targetPhase: TaskPhase;
  sideEffects: SideEffect[];
}

type SideEffect =
  | { type: "createRun"; run: RunSpec }
  | { type: "deleteRun"; name: string }
  | { type: "patchWorker"; patch: Partial<WorkerStatus> }
  | { type: "cleanupWorktree"; runName: string }
  | { type: "emitEvent"; event: TaskEvent }
  | { type: "createTasks"; tasks: TaskSpec[] }

type PhaseHandler = (ctx: PhaseContext) => Promise<Transition | null>;
```

### File Structure

```
packages/manager-controller/src/
  reconciler/
    index.ts              # Orchestrator
    types.ts              # PhaseContext, Transition, SideEffect
    handlers/
      index.ts            # phase → handler registry
      pending.ts          # schedulable? → scheduled
      scheduled.ts        # create run → initializing
      initializing.ts     # run started? → running
      running.ts          # run result → succeeded | failed | waiting-for-input
      waiting-for-input.ts  # answer provided? → running
      succeeded.ts        # → reviewing | awaiting-human
      reviewing.ts        # AI result → awaiting-human | rework-requested
      awaiting-human.ts   # human action → merge | rework | builds | done
      awaiting-merge.ts   # merge result → done | failed
      rework-requested.ts # slot available? → scheduled
      generating-builds.ts # buildgen result → done
      failed.ts           # retry policy → pending | stay
    transitions.ts        # Apply: side effects then phase patch
    scheduler.ts          # Priority, WIP, predecessors, backoff
    config-resolver.ts    # Merge project + task policies
```

### Orchestrator

```typescript
async function reconcileProject(project: Project): Promise<void> {
  const tasks = await listTasks(project.metadata.name, ns);
  
  // Backfill old tasks (one-time)
  for (const task of tasks) {
    if (!task.status?.phase) {
      await patchTaskStatus(task.metadata.name, { phase: backfillPhase(task) }, ns);
    }
  }
  
  const active = tasks.filter(t => t.status.phase !== "idea" && t.status.phase !== "done");
  // Sort by priority for scheduling fairness
  active.sort(byPriority);

  for (const task of active) {
    if (task.status.blocked) continue;
    const handler = handlers[task.status.phase];
    if (!handler) continue;
    const ctx = await buildContext(task, project, tasks);
    const transition = await handler(ctx);
    if (transition) await applyTransition(task, transition);
  }

  await updateProjectMetrics(project, tasks);
}
```

### Idempotent Side Effect Application

```typescript
async function applyTransition(task: Task, transition: Transition): Promise<void> {
  // Side effects FIRST (idempotent)
  for (const effect of transition.sideEffects) {
    switch (effect.type) {
      case "createRun":
        try { await createRun(effect.run, ns); }
        catch (e) { if (!isAlreadyExists(e)) throw e; }
        break;
      case "deleteRun":
        try { await deleteRun(effect.name, ns); }
        catch (e) { if (!isNotFound(e)) throw e; }
        break;
      case "patchWorker":
        await patchWorker(task.metadata.name, effect.patch, ns);
        break;
      case "cleanupWorktree":
        try { await cleanupWorktree(effect.runName, project); }
        catch { /* best effort */ }
        break;
      case "createTasks":
        for (const t of effect.tasks) {
          try { await createTask(t, ns); }
          catch (e) { if (!isAlreadyExists(e)) throw e; }
        }
        break;
    }
  }
  // Phase patch LAST
  await patchTaskStatus(task.metadata.name, { phase: transition.targetPhase }, ns);
}
```

If phase patch fails: next reconcile re-enters, side effects are no-ops, retries patch.
If side effect fails: phase never patched, next reconcile retries everything. Safe.

### Handler: `pending.ts`

```typescript
async function handlePending(ctx: PhaseContext): Promise<Transition | null> {
  if (!canSchedule(ctx.task, ctx.project, ctx.allTasks)) return null;
  if (ctx.task.status.retryAfter && new Date(ctx.task.status.retryAfter) > new Date()) return null;
  return { targetPhase: "scheduled", sideEffects: [] };
}
```

### Handler: `scheduled.ts`

```typescript
async function handleScheduled(ctx: PhaseContext): Promise<Transition | null> {
  const retryCount = ctx.task.status.worker?.retryCount ?? 0;
  const runName = workerRunName(ctx.project.metadata.name, ctx.task.metadata.name, retryCount);
  const feedback = ctx.task.metadata.annotations?.[`percussionist.dev/rework-${ctx.task.metadata.name}`];
  const run = buildWorkerRun(ctx.project, ctx.task, runName, retryCount, feedback);
  
  return {
    targetPhase: "initializing",
    sideEffects: [
      { type: "createRun", run },
      { type: "patchWorker", patch: { runName, status: "Running", startedAt: new Date().toISOString() } },
    ],
  };
}
```

### Handler: `running.ts`

```typescript
async function handleRunning(ctx: PhaseContext): Promise<Transition | null> {
  if (!ctx.run) return { targetPhase: "failed", sideEffects: [
    { type: "patchWorker", patch: { status: "Failed" } },
  ]};
  
  switch (ctx.run.status?.phase) {
    case "Succeeded": {
      const duration = computeDuration(ctx.run);
      return { targetPhase: "succeeded", sideEffects: [
        { type: "patchWorker", patch: { status: "Succeeded", completedAt: new Date().toISOString() } },
      ]};
    }
    case "Failed": {
      const duration = computeDuration(ctx.run);
      return { targetPhase: "failed", sideEffects: [
        { type: "patchWorker", patch: { status: "Failed", completedAt: new Date().toISOString() } },
      ]};
    }
    case "Running": {
      // Staleness: 5 min no activity
      const lastEvent = ctx.run.status?.lastEventAt;
      if (lastEvent && Date.now() - new Date(lastEvent).getTime() > 5 * 60 * 1000) {
        return { targetPhase: "failed", sideEffects: [
          { type: "patchWorker", patch: { status: "Failed" } },
          { type: "emitEvent", event: { reason: "Stale", message: "No activity for 5 minutes" } },
        ]};
      }
      return null;
    }
    case "WaitingForInput": {
      if (ctx.task.spec.type !== "PLAN") {
        return { targetPhase: "failed", sideEffects: [
          { type: "patchWorker", patch: { status: "Failed" } },
          { type: "emitEvent", event: { reason: "BuildCannotWait", message: "BUILD tasks cannot wait for input" } },
        ]};
      }
      return { targetPhase: "waiting-for-input", sideEffects: [] };
    }
    default: return null;
  }
}
```

### Handler: `waiting-for-input.ts`

```typescript
async function handleWaitingForInput(ctx: PhaseContext): Promise<Transition | null> {
  // Answer stored as task annotation by UI action endpoint
  const answer = ctx.task.metadata.annotations?.[`percussionist.dev/answer-${ctx.task.metadata.name}`];
  if (!answer) return null;
  
  // Dispatcher polls this annotation and injects into agent session.
  // Once injected, run transitions back to Running phase.
  if (ctx.run?.status?.phase === "Running") {
    return { targetPhase: "running", sideEffects: [] };
  }
  return null; // answer set but run hasn't resumed yet
}
```

### Handler: `reviewing.ts`

```typescript
async function handleReviewing(ctx: PhaseContext): Promise<Transition | null> {
  const reviewRunName = ctx.task.status.worker?.reviewRunName;
  if (!reviewRunName) return { targetPhase: "awaiting-human", sideEffects: [] };
  
  const reviewRun = await getRun(reviewRunName, ns);
  
  // Review run gone or failed → skip to human
  if (!reviewRun || reviewRun.status?.phase === "Failed") {
    return { targetPhase: "awaiting-human", sideEffects: [] };
  }
  
  // Staleness (5min)
  if (reviewRun.status?.phase === "Running") {
    const lastEvent = reviewRun.status?.lastEventAt;
    if (lastEvent && Date.now() - new Date(lastEvent).getTime() > 5 * 60 * 1000) {
      return { targetPhase: "awaiting-human", sideEffects: [
        { type: "deleteRun", name: reviewRunName },
      ]};
    }
    return null;
  }
  
  if (reviewRun.status?.phase !== "Succeeded") return null;
  
  const result = await parseRawReview(reviewRunName, ns);
  
  if (result.decision === "approve") {
    return { targetPhase: "awaiting-human", sideEffects: [
      { type: "patchWorker", patch: { reviewApproved: true, reviewFeedback: result.feedback } },
    ]};
  }
  
  if (result.decision === "request_changes") {
    const aiCount = (ctx.task.status.worker?.aiReworkCount ?? 0) + 1;
    const ceiling = ctx.config.reviewPolicy.maxAutoReworks;
    
    if (aiCount >= ceiling) {
      return { targetPhase: "awaiting-human", sideEffects: [
        { type: "patchWorker", patch: { aiReworkCount: aiCount, reviewFeedback: result.feedback } },
      ]};
    }
    return { targetPhase: "rework-requested", sideEffects: [
      { type: "patchWorker", patch: { aiReworkCount: aiCount, reviewFeedback: result.feedback } },
    ]};
  }
  
  return { targetPhase: "awaiting-human", sideEffects: [] };
}
```

### Handler: `generating-builds.ts`

```typescript
async function handleGeneratingBuilds(ctx: PhaseContext): Promise<Transition | null> {
  const buildgenRunName = ctx.task.status.worker?.buildTasksFacilitatorRun;
  
  // No buildgen run yet → create one
  if (!buildgenRunName) {
    const runName = auxiliaryRunName(ctx.project.metadata.name, "build-gen", ctx.task.metadata.name);
    const planSession = await fetchPlanSessionSummary(ctx.task, ns);
    const run = buildBuildTaskGeneratorRun(ctx.project, ctx.task, runName, planSession);
    return { targetPhase: "generating-builds", sideEffects: [
      { type: "createRun", run },
      { type: "patchWorker", patch: { buildTasksFacilitatorRun: runName } },
    ]};
  }
  
  // Poll buildgen run
  const buildgenRun = await getRun(buildgenRunName, ns);
  if (!buildgenRun || buildgenRun.status?.phase === "Failed") {
    // Failed → back to awaiting-human
    return { targetPhase: "awaiting-human", sideEffects: [
      { type: "patchWorker", patch: { buildTasksFacilitatorRun: undefined } },
    ]};
  }
  if (buildgenRun.status?.phase !== "Succeeded") return null; // still running
  
  // Parse and create BUILD tasks
  const defs = await parseBuildTaskDefinitions(buildgenRunName, ns);
  if (!defs || defs.length === 0) {
    return { targetPhase: "awaiting-human", sideEffects: [
      { type: "patchWorker", patch: { buildTasksFacilitatorRun: undefined } },
    ]};
  }
  
  const taskSpecs = defs.map((def, i) => buildBuildTaskSpec(ctx, def, i));
  const taskNames = taskSpecs.map(t => t.metadata.name);
  
  return { targetPhase: "done", sideEffects: [
    { type: "createTasks", tasks: taskSpecs },
    { type: "patchWorker", patch: { buildTasksCreated: true, createdBuildTaskRefs: taskNames } },
  ]};
}
```

### Handler: `failed.ts`

```typescript
async function handleFailed(ctx: PhaseContext): Promise<Transition | null> {
  if (!ctx.config.retryPolicy.enabled) return null; // stay failed, wait for human
  
  const duration = ctx.task.status.lastFailureDuration ?? 0;
  if (duration < ctx.config.retryPolicy.poisonPillThresholdSeconds) return null;
  
  const retryCount = ctx.task.status.worker?.retryCount ?? 0;
  if (retryCount >= ctx.config.retryPolicy.maxAttempts - 1) return null;
  
  const backoff = Math.min(
    ctx.config.retryPolicy.backoffSeconds * (ctx.config.retryPolicy.backoffMultiplier ** retryCount),
    ctx.config.retryPolicy.maxBackoffSeconds
  );
  const retryAfter = new Date(Date.now() + backoff * 1000).toISOString();
  
  return { targetPhase: "pending", sideEffects: [
    { type: "patchWorker", patch: { retryCount: retryCount + 1 } },
  ]};
  // Note: retryAfter patched on task status separately
}
```

### Scheduler

```typescript
function canSchedule(task: Task, project: Project, allTasks: Task[]): boolean {
  const active = allTasks.filter(t => isActivePhase(t.status.phase));
  if (active.length >= (project.spec.maxParallel ?? 2)) return false;
  
  if (task.spec.predecessorRef) {
    const pred = allTasks.find(t => t.metadata.name === task.spec.predecessorRef);
    if (!pred || pred.status.phase !== "done") return false;
    if (project.spec.featureBranchingEnabled && !pred.status.worker?.mergedAt) return false;
  }
  
  if (task.status.retryAfter && new Date(task.status.retryAfter) > new Date()) return false;
  return true;
}

function isActivePhase(phase: TaskPhase): boolean {
  return ["scheduled", "initializing", "running", "waiting-for-input",
          "awaiting-merge", "generating-builds"].includes(phase);
}
```

## Migration

No dual-write, no feature flag for safety. Just replace.

1. Create `reconciler/` directory with all handlers
2. Update `index.ts` to import new orchestrator
3. Delete old `reconciler.ts`
4. Delete `decision-engine.ts` (move `parseRawReview` + `parseRawBuildTaskGen` to `facilitator.ts`)
5. Deploy

Backfill handles old tasks on first reconcile. If something breaks, fix forward.

## Files to Change

| Action | Files |
|--------|-------|
| Create | `packages/manager-controller/src/reconciler/` (entire tree) |
| Delete | `packages/manager-controller/src/reconciler.ts` |
| Update | `packages/manager-controller/src/index.ts` |
| Update | `packages/manager-controller/src/agent/tools.ts` |
| Keep | `packages/manager-controller/src/worker-builder.ts` |
| Keep | `packages/manager-controller/src/branch-resolver.ts` |
| Simplify | `packages/manager-controller/src/facilitator.ts` (success-review + buildgen only) |
| Delete | `packages/manager-controller/src/agent/decision-engine.ts` |
| Move | `packages/manager-controller/src/task-scheduler.ts` → `reconciler/scheduler.ts` |
