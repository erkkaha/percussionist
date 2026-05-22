# 02 — Failure and Retry Policy

## Summary

Make auto-retry opt-in (default: off). On failure, tasks go to `failed` phase 
(visible in review column) where humans decide next action. Add configurable 
backoff and poison-pill detection.

## Current Behavior (problems)

- Auto-retry is always on, up to 3 attempts (hard-coded `MAX_RETRIES = 3`)
- No backoff between retries
- No way to disable retry per project or task
- Facilitator/decision-engine complexity on failure path
- Tasks that always fail immediately burn through retries with no signal

## Target Behavior

### Default: No Auto-Retry

On failure: `running` → `failed` → board column **review**.

Human sees the failure (with logs/session link) and chooses:
- **Retry** — sets phase to `pending`, increments retryCount
- **Retry with different agent** — same, but overrides agent for next run
- **Rework** — sets phase to `rework-requested` with feedback
- **Abandon** — sets phase to `done` (marked as abandoned)

Agent picker available on retry/rework actions in the UI.

### Opt-in Auto-Retry

```yaml
# Project spec
spec:
  retryPolicy:
    enabled: false          # default
    maxAttempts: 3          # total attempts (includes first try)
    backoffSeconds: 30      # initial backoff
    backoffMultiplier: 2    # exponential: 30s, 60s, 120s
    maxBackoffSeconds: 300  # cap at 5 minutes
    poisonPillThresholdSeconds: 30  # if fails faster than this, stop retrying

# Task spec override (optional)
spec:
  retryPolicy:
    enabled: true
    maxAttempts: 5
    backoffSeconds: 60
```

### Retry With Backoff

When auto-retry is enabled and a run fails:

1. Poison-pill check: if run duration < `poisonPillThresholdSeconds` → stay `failed`
2. Attempt count: if `retryCount >= maxAttempts - 1` → stay `failed` (exhausted)
3. Backoff: `min(backoffSeconds * backoffMultiplier^retryCount, maxBackoffSeconds)`
4. Set phase to `pending` with `status.retryAfter = now + backoff`
5. Scheduler skips tasks where `retryAfter > now`

### lastFailureDuration Source

Computed by `running.ts` handler on transition to `failed`:
```typescript
const duration = (new Date(run.status.completedAt) - new Date(run.status.startedAt)) / 1000;
```

### Failure Path (deterministic)

```
running → failed → [auto-retry enabled?]
                     yes → [poison pill?]
                       yes → stay failed (human sees it)
                       no → [attempts remain?]
                         yes → pending (with retryAfter backoff)
                         no → stay failed (exhausted)
                     no → stay failed (human decides)
```

### Decision Engine — Clean Cut

- Delete `analyzeFailure()` — replaced by human decision or policy
- Delete `parseRawFacilitation()` — failure facilitator removed
- Keep `parseRawReview()` — needed by success-review (plan 03)
- Keep `parseRawBuildTaskGen()` — needed by buildgen facilitator
- Delete `buildFacilitationRun()` entirely

## Schema Changes

```typescript
// Project spec
retryPolicy: z.object({
  enabled: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffSeconds: z.number().int().min(5).max(600).default(30),
  backoffMultiplier: z.number().min(1).max(5).default(2),
  maxBackoffSeconds: z.number().int().min(5).max(3600).default(300),
  poisonPillThresholdSeconds: z.number().int().min(5).max(300).default(30),
}).optional()

// Task spec (overrides project)
retryPolicy: z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffSeconds: z.number().int().min(5).max(600).optional(),
}).optional()

// Task status
retryAfter: z.string().optional()
lastFailureReason: z.string().max(4096).optional()
lastFailureDuration: z.number().optional()
```

## Files to Change

| File | Change |
|------|--------|
| `packages/api/src/index.ts` | Add `retryPolicy` to ProjectSpec/TaskSpec; add retry status fields |
| `packages/manager-controller/src/reconciler/handlers/failed.ts` | Policy-based retry logic |
| `packages/manager-controller/src/reconciler/handlers/running.ts` | Compute lastFailureDuration |
| `packages/manager-controller/src/reconciler/config-resolver.ts` | Merge project + task retry policies |
| `packages/manager-controller/src/worker-builder.ts` | Remove `MAX_RETRIES` constant |
| `packages/manager-controller/src/agent/decision-engine.ts` | Delete `analyzeFailure`, `parseRawFacilitation` |
| `packages/manager-controller/src/facilitator.ts` | Remove `buildFacilitationRun` |
| `packages/manager-controller/src/reconciler/scheduler.ts` | Respect `retryAfter` |
| `packages/web/` | Retry/rework/abandon actions with agent picker |

## Removed Complexity

- `MAX_RETRIES` hard-coded constant
- `facilitationRunName`, `facilitated`, `facilitationResult` on WorkerStatus
- `buildFacilitationRun()` function
- `analyzeFailure()` function
- `parseRawFacilitation()` function
- Entire failure facilitator concept
- "Escalation" concept (replaced by: task is `failed`, human sees it)
