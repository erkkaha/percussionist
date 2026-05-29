# Task Reconciliation Architecture Plan

## Goal

Make task reconciliation testable, auditable, repeatable, and user-configurable without increasing controller fragility.

The current reconciler has useful phase separation, but policy, state transitions, Kubernetes side effects, human actions, retry behavior, review behavior, build generation, and merge orchestration are still tightly coupled. The next architecture should separate pure lifecycle decisions from side-effect execution.

## Current Problems

### Reliability Risks

- Active task counting can drift during a reconcile cycle because active-to-active transitions increment `activeCount` even though the task was already counted.
- Side effects are applied before the authoritative phase patch. If the final patch fails, the next reconcile can repeat the transition against partially applied effects.
- Worker status patches merge against stale in-memory task state, not the latest server state.
- `rework-requested` can become stuck because it refuses to schedule when the previous run is terminal, which is the common state after rework is requested.
- Staleness thresholds are hard-coded to 5 minutes for worker, review, and merge runs.
- MCP tools and UI endpoints can bypass the normal phase flow by directly patching task phase/status.
- Human actions are split across Project annotations and Task annotations.
- Documentation and API naming still mix legacy board columns with authoritative task phases.

### Configurability Gaps

- PLAN approval always triggers BUILD generation.
- BUILD approval always triggers merge behavior.
- Review behavior is controlled by a small `reviewPolicy`, but the broader lifecycle is hard-coded.
- Retry policy exists, but stale timeout, review behavior, merge behavior, human approval requirements, and build generation behavior are not expressed as one coherent flow.
- Users cannot select a simpler lifecycle for projects that do not need PLAN/BUILD/review/merge orchestration.

## Target Pattern

Use a pure reducer plus effect executor architecture.

```ts
Task + Project + ObservedRuns + ManualActions + FlowConfig + now
  -> ReconcileDecision

ReconcileDecision = {
  fromPhase,
  toPhase?,
  statusPatch?,
  effects[],
  auditEvents[],
}
```

The reducer must be deterministic and side-effect free. It should not call Kubernetes, read the clock, fetch sessions, mutate inputs, or log as part of decision-making.

The executor applies the returned effects to Kubernetes, validates transition legality, handles conflicts, and persists audit events.

## Proposed Module Layout

```text
packages/manager-controller/src/reconciler/
  decision.ts          # pure decision engine
  effects.ts           # effect types and executor
  flow.ts              # flow schema resolver and presets
  transitions.ts       # allowed transition table and validation
  observations.ts      # converts Kubernetes resources into reducer input
  audit.ts             # audit event model/helpers
  scheduler.ts         # pure scheduling eligibility/capacity logic
  index.ts             # orchestration only: list resources, decide, execute
  __tests__/
    decision.test.ts
    flow.test.ts
    transitions.test.ts
    scheduler.test.ts
```

## Data Model Changes

### Project Flow Configuration

Add `spec.flow` to `ProjectSpecSchema` in `packages/api/src/index.ts`.

Initial schema should support presets and a small set of overrides:

```yaml
spec:
  flow:
    preset: plan-build-review-merge
    humanApproval:
      plan: required
      build: required
    plan:
      onApprove: generate-builds
      buildGeneration: ai
    build:
      onSuccess: human-review
      onApprove: merge
    merge:
      mode: auto
    review:
      aiReviewerEnabled: false
      aiReviewerAgent: reviewer
      maxAutoReworks: 2
    retry:
      enabled: false
      maxAttempts: 3
      backoffSeconds: 30
      backoffMultiplier: 2
      maxBackoffSeconds: 300
      poisonPillThresholdSeconds: 30
    timeouts:
      runningStaleSeconds: 1800
      reviewStaleSeconds: 600
      mergeStaleSeconds: 600
```

Supported initial presets:

- `simple`: run task, mark done on success, fail on failure. No review, no build generation, no merge.
- `review`: run task, move successful tasks to human review, approval marks done, rework schedules another run.
- `plan-build`: PLAN approval generates BUILD tasks; BUILD approval marks done. No automatic merge.
- `plan-build-review-merge`: current intended full workflow. PLAN approval generates BUILD tasks; BUILD approval creates merge run.

Keep existing `spec.retryPolicy` and `spec.reviewPolicy` as compatibility inputs. `resolveFlow(project, task)` should merge them into a single `ResolvedFlow`. New code should read only `ResolvedFlow`.

### Task-Local Manual Actions

Move manual actions to Task annotations or status:

```text
percussionist.dev/action-approved
percussionist.dev/action-request-changes
percussionist.dev/action-rework-feedback
percussionist.dev/action-abandon
percussionist.dev/action-answer
```

The reducer input should expose these as normalized `manualActions`, not raw annotations.

For migration, handlers may read legacy Project annotations as a fallback, but all new UI/MCP writes should target Task annotations.

## Reconcile Input

Introduce a normalized input model:

```ts
export interface ReconcileInput {
  task: Task;
  project: Project;
  allTasks: Task[];
  observed: ObservedRuns;
  manualActions: ManualActions;
  flow: ResolvedFlow;
  capacity: CapacitySnapshot;
  now: string;
}

export interface ObservedRuns {
  worker?: Run;
  review?: Run;
  merge?: Run;
  buildgen?: Run;
}

export interface ManualActions {
  approved?: boolean;
  requestChanges?: boolean;
  reworkFeedback?: string;
  abandon?: boolean;
  answer?: string;
}

export interface CapacitySnapshot {
  activeCount: number;
  maxParallel: number;
}
```

`observations.ts` can perform Kubernetes reads, session ConfigMap reads, and annotation normalization. `decision.ts` should receive already-normalized data.

## Reconcile Decision

```ts
export interface ReconcileDecision {
  taskName: string;
  fromPhase: TaskPhase;
  toPhase?: TaskPhase;
  statusPatch?: Partial<TaskStatus>;
  effects: ReconcileEffect[];
  events: AuditEvent[];
}
```

Effects should be explicit and idempotent:

```ts
export type ReconcileEffect =
  | { type: "CreateRun"; run: Run }
  | { type: "DeleteRun"; name: string; reason: string }
  | { type: "PatchTaskStatus"; patch: Partial<TaskStatus> }
  | { type: "CreateTask"; task: Task }
  | { type: "ClearTaskAnnotations"; keys: string[] }
  | { type: "ClearProjectAnnotations"; keys: string[]; legacyOnly?: boolean }
  | { type: "CleanupWorktree"; runName: string };
```

Avoid generic side effects like `emitEvent` without structured fields. Audit events should be first-class.

## Transition Validation

Define allowed transitions centrally:

```ts
const allowedTransitions: Record<TaskPhase, TaskPhase[]> = {
  idea: ["pending"],
  pending: ["scheduled"],
  scheduled: ["initializing", "failed"],
  initializing: ["running", "succeeded", "failed"],
  running: ["waiting-for-input", "succeeded", "failed"],
  "waiting-for-input": ["running", "failed"],
  succeeded: ["reviewing", "awaiting-human", "done"],
  reviewing: ["awaiting-human", "rework-requested"],
  "awaiting-human": ["awaiting-merge", "generating-builds", "rework-requested", "done", "failed"],
  "awaiting-merge": ["done", "failed"],
  "rework-requested": ["scheduled"],
  "generating-builds": ["done", "awaiting-human", "failed"],
  failed: ["pending", "awaiting-human"],
  done: [],
};
```

The executor should reject illegal transitions unless a caller explicitly uses an administrative override path. MCP tools should use the same validation by default.

## Audit Events

Every decision that changes state or emits effects should produce an audit event.

```ts
export interface AuditEvent {
  project: string;
  task: string;
  fromPhase: TaskPhase;
  toPhase?: TaskPhase;
  reason: string;
  message?: string;
  effects: string[];
  observedRuns?: Record<string, string | undefined>;
  at: string;
}
```

Persist audit events to the existing web `taskEvents` table and optionally Kubernetes Events. Console logs should remain useful but must not be the only audit trail.

Suggested event reasons:

- `TaskScheduled`
- `WorkerRunCreated`
- `WorkerRunRunning`
- `WorkerRunSucceeded`
- `WorkerRunFailed`
- `WorkerRunMissing`
- `WorkerRunStale`
- `WaitingForInput`
- `HumanApproved`
- `HumanRequestedChanges`
- `TaskAbandoned`
- `ReviewRunCreated`
- `ReviewApproved`
- `ReviewRequestedChanges`
- `ReviewUnparseable`
- `BuildGenerationRunCreated`
- `BuildTasksCreated`
- `MergeRunCreated`
- `MergeSucceeded`
- `MergeFailed`
- `RetryScheduled`
- `RetryExhausted`

## Executor Requirements

The effect executor should:

- Re-fetch the Task before applying a decision.
- Verify `current.status.phase === decision.fromPhase` before applying normal transitions.
- Validate `toPhase` against the central transition table.
- Apply idempotent effects with stable names.
- Re-read latest worker status before patching worker fields when necessary.
- Patch the final phase and status in one status patch where possible.
- Persist audit events after successful application.
- Return a structured execution result for logging and tests.

Execution should prefer one final `patchTaskStatus` containing phase and worker/status updates instead of multiple independent status patches.

## Scheduling Semantics

`scheduler.ts` should remain pure.

Fix active count accounting:

- Compute initial active count from current task phases.
- For each decision, adjust count only if active membership changes.
- Active-to-active transition: no change.
- Inactive-to-active transition: increment.
- Active-to-inactive transition: decrement.

Active phases should likely remain:

```ts
scheduled
initializing
running
waiting-for-input
awaiting-merge
```

Decide whether `reviewing` counts toward `maxParallel`. It currently does not. That may be reasonable if review runs are facilitator/auxiliary work, but it should be explicit in `ResolvedFlow` or scheduler constants.

## Decision Rules By Phase

### `pending`

- If task is blocked, no-op.
- If predecessor is incomplete, no-op.
- If retry backoff has not elapsed, no-op.
- If capacity is full, no-op.
- Else transition to `scheduled`.

### `scheduled`

- Build deterministic worker run name from project/task/retry count.
- Emit `CreateRun` and patch worker status to Running.
- Transition to `initializing`.

### `initializing`

- Missing run: transition to `failed` with `WorkerRunMissing`.
- Run `Running` or `WaitingForInput`: transition to `running`.
- Run `Succeeded`: transition to `succeeded`.
- Run `Failed`: transition to `failed`.
- Otherwise no-op.

### `running`

- Missing run: transition to `failed`.
- Run `Succeeded`: transition to `succeeded`.
- Run `Failed`: transition to `failed` with failure duration.
- Run `WaitingForInput`: transition to `waiting-for-input` for PLAN tasks; for BUILD tasks use flow policy to either allow or fail.
- Run `Running` and stale beyond configured timeout: transition to `failed`.
- Otherwise no-op.

### `waiting-for-input`

- If no answer, no-op.
- If answer exists and run resumed to `Running`, clear answer annotation and transition to `running`.
- If answer exists but run has not resumed, no-op.

### `succeeded`

- Use `ResolvedFlow` to choose next step.
- If flow says done, transition to `done`.
- If flow says human review, transition to `awaiting-human`.
- If flow says AI review and reviewer agent is available, create review run and transition to `reviewing`.
- If AI reviewer is configured but unavailable, follow fallback policy: human review by default.

### `reviewing`

- Missing/failed/stale review run: transition according to fallback policy, usually `awaiting-human`.
- Succeeded review run with parseable approve: patch review fields and transition according to flow, usually `awaiting-human` or `done`.
- Succeeded review run with request changes and below auto-rework ceiling: transition to `rework-requested`.
- Succeeded review run with request changes over ceiling: transition to `awaiting-human`.
- Unparseable review: transition to `awaiting-human` with feedback.

### `awaiting-human`

- `abandon`: transition to `done` or `failed` based on configured semantics. Default should remain `done` for current behavior.
- `requestChanges`: increment retry count, store feedback, transition to `rework-requested`.
- `approved` PLAN:
  - `plan.onApprove=generate-builds`: transition to `generating-builds`.
  - `plan.onApprove=done`: transition to `done`.
- `approved` BUILD:
  - `build.onApprove=merge`: create merge run and transition to `awaiting-merge`.
  - `build.onApprove=done`: transition to `done`.
- No action: no-op.

### `rework-requested`

- If capacity unavailable, no-op.
- Else transition to `scheduled`.
- Do not block solely because the previous run is terminal.

### `failed`

- If retry disabled, no-op or transition to `awaiting-human` depending on flow.
- If poison-pill threshold says do not retry, no-op or `awaiting-human`.
- If attempts exhausted, no-op or `awaiting-human`.
- Otherwise increment retry count, set `retryAfter`, transition to `pending`.

### `generating-builds`

- If no buildgen run exists, create one and remain in `generating-builds`.
- If buildgen failed/missing/stale, transition to `awaiting-human` with feedback.
- If buildgen succeeded and parsed zero tasks, transition to `done`.
- If buildgen succeeded and parsed tasks, create Task CRs, patch created refs, transition to `done`.
- Build task dependency behavior should be controlled by flow. Avoid defaulting every generated task into a serial predecessor chain unless the generator requested it.

### `awaiting-merge`

- Missing merge run: transition to `failed` or recreate based on flow. Default should fail to avoid hidden repeated merges.
- Succeeded merge run: transition to `done` and set `mergedAt`.
- Failed/stale merge run: transition to `failed` with merge error.
- Otherwise no-op.

## Testing Plan

Add a lightweight test framework. Recommended: Vitest.

Root package scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Initial dependency:

```sh
pnpm add -D vitest
```

### Unit Tests

Start with pure tests that do not touch Kubernetes.

#### Scheduler Tests

- `pending` task schedules when capacity is available.
- `pending` task does not schedule when `activeCount >= maxParallel`.
- predecessor blocks scheduling until predecessor is `done`.
- feature branching predecessor also requires `mergedAt`.
- retry backoff blocks until `retryAfter` has elapsed.
- active count adjusts only when active membership changes.

#### Transition Tests

- Valid transitions are accepted.
- Invalid transitions are rejected.
- Terminal `done` has no normal outgoing transition.
- Administrative override is explicit and separate.

#### Flow Resolution Tests

- `simple` preset resolves success to done.
- `review` preset resolves success to awaiting human.
- `plan-build` preset resolves approved PLAN to build generation and approved BUILD to done.
- `plan-build-review-merge` resolves approved BUILD to merge.
- Legacy `reviewPolicy` is reflected in `ResolvedFlow`.
- Legacy `retryPolicy` is reflected in `ResolvedFlow`.
- Project flow overrides preset defaults.

#### Decision Tests

- `pending + capacity -> scheduled`.
- `scheduled -> initializing + CreateRun + worker patch`.
- `initializing + missing run -> failed`.
- `initializing + Running run -> running`.
- `running + Succeeded run -> succeeded`.
- `running + Failed run -> failed + lastFailureDuration`.
- `running + stale run -> failed` using injected `now`.
- `running + WaitingForInput PLAN -> waiting-for-input`.
- `waiting-for-input + answer + Running run -> running + clear annotation`.
- `succeeded + simple flow -> done`.
- `succeeded + review flow -> awaiting-human`.
- `succeeded + AI review enabled -> reviewing + CreateRun`.
- `reviewing + approve -> awaiting-human or done based on flow`.
- `reviewing + request_changes under ceiling -> rework-requested`.
- `awaiting-human + approve PLAN + buildgen enabled -> generating-builds`.
- `awaiting-human + approve PLAN + buildgen disabled -> done`.
- `awaiting-human + approve BUILD + merge enabled -> awaiting-merge + CreateRun`.
- `awaiting-human + approve BUILD + merge disabled -> done`.
- `rework-requested + old terminal worker run -> scheduled`.
- `failed + retry enabled + attempts left -> pending with retryAfter`.
- `failed + retry exhausted -> no-op or awaiting-human based on flow`.
- `awaiting-merge + Succeeded run -> done + mergedAt`.

#### Idempotency Tests

- Same input produces the same decision.
- Run names are stable for the same retry count.
- Repeated `scheduled` decision with an existing deterministic run remains safe.
- Build generation task names are stable.

### Integration-Style Tests Without Kubernetes

Add golden fixture tests that simulate full workflows by repeatedly feeding output state back into the reducer.

Scenarios:

- Simple BUILD task: pending -> scheduled -> initializing -> running -> succeeded -> done.
- Review BUILD task: pending -> running -> succeeded -> awaiting-human -> done.
- Rework BUILD task: success -> awaiting-human -> rework-requested -> scheduled retry -> success -> done.
- PLAN with generated BUILD tasks.
- BUILD merge flow.
- Retry after failure with backoff.

## Migration Plan

### Phase 1: Stabilize Current Reconciler

- Fix active count accounting.
- Fix `rework-requested` terminal-run guard.
- Move hard-coded stale thresholds into resolved config with safer defaults.
- Ensure MCP `create_run` and `force_retry` do not skip normal lifecycle unless explicitly using an admin override.
- Update README references from legacy columns to phases where applicable.

### Phase 2: Add Test Harness

- Add Vitest.
- Add tests for scheduler and transition validation.
- Add tests for the known bugs fixed in Phase 1.
- Keep tests small and fixture-driven.

### Phase 3: Add Flow Resolver

- Add `spec.flow` schema.
- Add `ResolvedFlow` type and presets.
- Map existing `retryPolicy` and `reviewPolicy` into `ResolvedFlow`.
- Regenerate CRDs with `pnpm codegen`.
- Add flow resolver tests.

### Phase 4: Extract Decision Engine

- Create `decision.ts` and move phase behavior into pure decision functions.
- Keep current handlers as thin adapters initially if that reduces risk.
- Pass `now` explicitly.
- Normalize observations before calling decision functions.
- Add decision tests for each phase.

### Phase 5: Introduce Effect Executor

- Add central effect executor.
- Re-fetch current task before execution.
- Validate source phase and target transition.
- Apply phase and worker patches atomically where possible.
- Persist audit events.
- Keep idempotent behavior for already-existing deterministic runs.

### Phase 6: Normalize Human Actions

- Update web routes to write Task annotations for approve/request-changes/abandon.
- Update reconciler observation layer to read Task annotations first and legacy Project annotations second.
- Update MCP tools to use the same action model.
- Add cleanup effects for consumed annotations.

### Phase 7: Make Flow User-Visible

- Document `spec.flow` presets and overrides.
- Add examples under `k8s/samples/`.
- Optionally expose preset selection in the web UI after YAML support is stable.

## Verification Commands

Run after implementation milestones:

```sh
pnpm codegen
pnpm typecheck
pnpm build
pnpm test
```

## Acceptance Criteria

- Reconciliation decisions are covered by pure unit tests with no Kubernetes dependency.
- Current full workflow remains available as a default preset.
- A simple one-task workflow can be configured without PLAN generation, AI review, human approval, or merge.
- Human approval and rework actions are task-local.
- Rework after a terminal run schedules a new deterministic retry run.
- Stale timeout behavior is configurable and tested.
- Illegal phase jumps are rejected by default.
- Every state-changing decision emits a structured audit event.
- Documentation reflects phases and configurable flow rather than legacy fixed columns.
