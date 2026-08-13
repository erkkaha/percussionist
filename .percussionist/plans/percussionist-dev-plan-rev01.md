# Plan: Board deadlock — `waiting-for-input` has no exit and answers never reach the run

Task: `percussionist-dev-plan-rev01`

## Context

The task description was written against an older tree. **Parts of the described
breakage are already fixed** and must not be redone; the plan below focuses on the
gaps that remain. Verified against `HEAD` (9baaa98, branch
`feature/percussionist-dev-plan-rev01`):

### Already fixed (do not redo)

1. **Dead-run exits in `decideWaitingForInput`** — added by commit `60c7b5f`
   ("park BUILD tasks on waiting-for-input with dead-run exits"):
   `packages/manager-controller/src/reconciler/decision.ts:481-545` now handles
   run missing / `Failed` / `Cancelled` → task `failed` (`InputRunTerminated`),
   and `Succeeded` → task `succeeded` (`InputRunSucceeded`), with unit tests in
   `packages/manager-controller/src/reconciler/__tests__/decision.test.ts:342-379`.
   The dispatcher's idle-timeout path already funnels into this: when a run
   parked on `WaitingForInput` exceeds `IDLE_TIMEOUT_MS` (15 min,
   `packages/dispatcher/src/polling.ts:873-883`), `runPrompt` terminates and
   patches `RunPhase.Failed` ("session ended without completion signal",
   `polling.ts:1380-1384`), so `getEffectiveRunPhase` → `Failed` → the dead-run
   exit fails the task. The stranded-forever wedge and the permanent
   `maxParallel` slot leak are resolved for dead runs.

2. **Web answer UI + client callers** — added by commit `ce0f7ea` ("board answer
   flow for runs waiting for user input"):
   - `packages/web/src/client/components/board/TaskDetailPanel.tsx:1292-1336`
     renders an answer box when `task.workerRunPhase === 'WaitingForInput'`;
     `answerMutation` (lines 1034-1055) calls `replyToRun()` **then**
     `answerTask()`.
   - `packages/web/src/client/lib/api.ts:162-165` (`replyToRun`,
     `POST /api/runs/:name/reply`) and `api.ts:434-441` (`answerTask`,
     `POST /api/projects/:project/board/tasks/:taskName/answer`).
   - Push notifications ("Task is asking a question",
     `packages/web/src/server/lib/push-triggers.ts:67`) link to
     `/projects/:project/board?task=:name`, and `BoardView.tsx:49,127-140`
     auto-opens the task detail panel for that `task` param — which now contains
     the answer box.

### Gaps that remain (the actual work)

1. **`decideWaitingForInput` ignores `abandon` and `request-changes`.**
   `ManualActions.abandon` / `.requestChanges` are consumed only in
   `decideAwaitingHuman` (`decision.ts:847-885`). A task parked on
   `waiting-for-input` with `percussionist.dev/action-abandon` or
   `action-request-changes` set stays parked forever: the decision engine only
   branches on `manualActions.answer` (`decision.ts:530-544`). The
   "Request Changes" button is already visible for waiting-for-input tasks
   (they map to the `review` column, `computeBoardColumn` in
   `packages/api/src/index.ts:881`), so a human can set the annotation — it is
   just silently ignored. The transition table
   (`packages/api/src/index.ts:897`) only allows
   `waiting-for-input → [running, succeeded, failed]`; `done` and
   `rework-requested` are missing.

2. **Annotation-only answers never reach the run session.** The UI works
   because it separately calls `POST /api/runs/:name/reply` before writing the
   annotation. But `POST .../board/tasks/:taskName/answer` alone (or a
   CLI/kubectl annotation write) only sets `percussionist.dev/action-answer` —
   the annotation's only consumer is `ClearTaskAnnotations` (`decision.ts:539`).
   Nothing posts the answer text to the run's opencode session, so the run stays
   in `WaitingForInput` phase and `decideWaitingForInput` correctly-but-uselessly
   no-ops (documented + tested as "answer but run not resumed → no-op",
   `decision.test.ts:2078-2090`). The suggested fix #2 (a manager effect that
   posts the answer before clearing the annotation) is not implemented.

3. **No `/abandon` route or abandon UI anywhere.** Server routes in
   `packages/web/src/server/routes/board.ts` are: approve (516), request-changes
   (548), retry-review (596), answer (639), move (446). There is no abandon
   route, no `abandonTask()` in the client, and no abandon button. The `move`
   route only maps to `pending`/`idea` (board.ts:459-464).

## Approach

Close the three gaps end to end with the same annotation-driven mechanics the
board already uses, keeping `decision.ts` pure (no kube calls) and effect
execution in `effects.ts`:

### A. Decision-engine exits for `waiting-for-input` (abandon / request-changes)

Extend `decideWaitingForInput` to mirror `decideAwaitingHuman`'s semantics:

- `manualActions.abandon` → `toPhase: 'done'`, status patch
  `worker: { status: 'Succeeded', completedAt: now, abandoned: true }`,
  effect `ClearTaskAnnotations(getConsumedAnnotationKeys(manualActions))`,
  event reason `TaskAbandoned`.
- `manualActions.requestChanges` → `toPhase: 'rework-requested'`, status patch
  `worker: { reviewFeedback: capReviewFeedback(feedback ?? 'No feedback provided'), retryCount: retryCount + 1, aiReworkCount: 0 }`,
  effect `ClearTaskAnnotations(...)`, event reason `HumanRequestedChanges`.
  (`capReviewFeedback` and `getConsumedAnnotationKeys` already exist in
  `decision.ts` / `observations.ts`.)

Precedence: dead-run exits first (as today), then `abandon`, then
`requestChanges`, then `answer` — matching `decideAwaitingHuman`'s ordering for
the shared actions. If a human both answers and requests changes, abandon wins;
that mirrors the awaiting-human behavior.

Transition table (`packages/api/src/index.ts:897`):
`'waiting-for-input': ['running', 'succeeded', 'failed', 'done', 'rework-requested']`.
The table is the single source of truth shared by the CLI and MCP tools, so this
also unlocks `set_task_state`/CLI moves from `waiting-for-input` to those phases.

### B. Answer delivery — new `DeliverAnswer` effect

New effect type in `ReconcileEffect` union (`effects.ts:22-40`):

```ts
| { type: 'DeliverAnswer'; runName: string; text: string }
```

Executor (new `case 'DeliverAnswer'` in `executeEffects`):
1. `getRun(effect.runName, namespace)`; missing `status.serviceName` or
   `status.sessionID` → log warn, **do not fail** (run is gone; the dead-run
   exit handles the task on the next cycle).
2. Dedupe: `fetchSessionMessages(serviceName, sessionID)` and skip the post when
   the last `user` message's text already equals `effect.text` (message shape is
   `msg.info.role` + `msg.parts[].text` — see AGENTS.md). This prevents
   double-delivery in the common UI path, where the client already posted via
   `/reply` before the manager reconciles.
3. Otherwise `postSessionMessage(serviceName, sessionID, effect.text)`.

All three helpers (`getRun`, `fetchSessionMessages`, `postSessionMessage`) are
already exported from `@percussionist/kube` (`packages/kube/src/index.ts:989-1032`)
and used by the web `/reply` route. Delivery failure is non-fatal (warn and
continue) — consistent with fire-and-forget effects like `SummarizeSession`; if
the run pod is dead the dead-run exit fails the task regardless.

`decideWaitingForInput` answer branches become:
- `answer` + run `Running` → `toPhase: 'running'`, effects
  `[DeliverAnswer, ClearTaskAnnotations(['.../action-answer'])]` (existing
  transition preserved; `DeliverAnswer` is a no-op via dedupe when the client
  already delivered).
- `answer` + run `WaitingForInput` → **new**: effects `[DeliverAnswer]`, **no
  transition**, **annotation kept**. The run flips back to `Running` once the
  dispatcher observes the agent respond to the posted message
  (`polling.ts:840-849` flips `needsHumanInput` off); the next reconcile then
  takes the `Running` branch and consumes the annotation. If the run dies before
  flipping (idle timeout), the dead-run exit bounds the wait. This avoids a
  `running ↔ waiting-for-input` bounce that a forced immediate transition would
  cause (decideRunning would see `WaitingForInput` and bounce back).

This makes the standalone `/answer` route, CLI/kubectl annotation writes, and
any future MCP answer tool deliver the text to the run — the exact
"suggested fix #2" from the task.

### C. Abandon route + UI (web)

- New server route `POST /:project/board/tasks/:taskName/abandon` in
  `board.ts` mirroring the approve route (516-543): write
  `percussionist.dev/action-abandon: 'true'`, `appendTaskEvent(..., 'abandoned', {})`.
- `abandonTask(project, taskName)` in `packages/web/src/client/lib/api.ts`
  (mirror `approveTask`).
- `Abandon` button + confirmation in `TaskDetailPanel.tsx` action bar, shown for
  `waiting-for-input` tasks (and `awaiting-human`, where `decideAwaitingHuman`
  already honors abandon — small, safe addition). Update the "waiting hint" text
  (lines 1226-1231) to mention abandon as an exit.

## Tasks

### BUILD 1 — Manager: decision engine, transitions, DeliverAnswer effect

1. `packages/api/src/index.ts:897` — add `'done'` and `'rework-requested'` to
   the `waiting-for-input` allowed list in `TRANSITION_TABLE`.
2. `packages/manager-controller/src/reconciler/decision.ts` — in
   `decideWaitingForInput` (lines 481-545), after the dead-run exits and before
   the `!manualActions.answer` guard, add:
   - abandon branch → `done` + `worker.abandoned: true` + `ClearTaskAnnotations`
     + event `TaskAbandoned` (mirror `decision.ts:847-857`).
   - requestChanges branch → `rework-requested` + capped `reviewFeedback` +
     `retryCount + 1` + `aiReworkCount: 0` + `ClearTaskAnnotations` + event
     `HumanRequestedChanges` (mirror `decision.ts:859-885`).
   - Rework the answer branch to emit `DeliverAnswer` and to handle the
     run-still-`WaitingForInput` case (deliver, keep annotation, no transition).
3. `packages/manager-controller/src/reconciler/effects.ts` — add
   `{ type: 'DeliverAnswer'; runName: string; text: string }` to the
   `ReconcileEffect` union (line 22-40) and implement the executor case
   (getRun → resolve serviceName/sessionID → dedupe via
   `fetchSessionMessages` → `postSessionMessage`; non-fatal on failure).
4. `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` —
   add tests:
   - waiting + `manualActions.abandon` + run `WaitingForInput` → `done`,
     `worker.abandoned === true`, `ClearTaskAnnotations` contains
     `action-abandon`.
   - waiting + `manualActions.requestChanges` (+`reworkFeedback`) → 
     `rework-requested`, feedback capped, `retryCount + 1`.
   - answer + run `WaitingForInput` → no `toPhase`, effects contain
     `DeliverAnswer`, annotation NOT cleared.
   - answer + run `Running` → `running`, effects contain `DeliverAnswer` +
     `ClearTaskAnnotations`.
   - abandon takes precedence over answer when both set (if implemented as such).
   - **Update** the existing edge-case test at lines 2078-2090 ("answer but run
     not resumed → no-op") to the new behavior (deliver + keep annotation).
5. `packages/manager-controller/src/reconciler/__tests__/effects.test.ts` — add
   a `DeliverAnswer` describe block following the existing spy pattern
   (`spyOn(kube, 'getRun')`, `spyOn(kube, 'fetchSessionMessages')`,
   `spyOn(kube, 'postSessionMessage')`):
   - posts when the session tail has no matching user message;
   - skips post when the last user message text equals the answer;
   - run without `serviceName`/`sessionID` → applied, no throw;
   - `getRun` 404 → applied (non-fatal).
   - Extend `makeRun` fixture (`__tests__/fixtures.ts:127-166`) with a
     `serviceName` override if needed.
6. `packages/manager-controller/src/reconciler/__tests__/transitions.test.ts` —
   assert `isValidTransition('waiting-for-input', 'done')` and
   `('waiting-for-input', 'rework-requested')` are true.
7. Optional: `packages/manager-controller/src/reconciler/flow-introspection.ts`
   — add a waiting-for-input explainer noting the abandon / request-changes /
   answer annotations are now actionable (there is currently no
   `explainWaitingForInput`; awaiting-human has one at lines 94-121).

### BUILD 2 — Web: abandon route + UI

8. `packages/web/src/server/routes/board.ts` — add
   `board.post('/:project/board/tasks/:taskName/abandon', adminAuth(), ...)`
   mirroring the approve route (516-543): write
   `percussionist.dev/action-abandon: 'true'` via `patchTask`, then
   `appendTaskEvent(name, taskName, task.spec.type, 'abandoned', {})`.
9. `packages/web/src/client/lib/api.ts` — add `abandonTask(project, taskName)`
   (mirror `approveTask`, lines 390-398).
10. `packages/web/src/client/components/board/TaskDetailPanel.tsx` —
    - add `abandonMutation` (mirror `approveMutation`, lines 1010-1013) with a
      confirm step;
    - render an Abandon button for `task.status?.phase === 'waiting-for-input'`
      (and optionally `'awaiting-human'`) in the action bar (lines 1136-1223);
    - update the waiting hint (lines 1226-1231) to mention abandon.
11. Client verification: `pnpm build:client` (or root `pnpm build`) compiles;
    `TaskEventsPanel` already renders `abandoned` events (lines 19-39) so the
    new event type needs no icon changes.

### BUILD 3 (optional) — Deterministic E2E + docs

12. Optional extended-e2e: a deterministic test in `tests/e2e/` that drives a
    task to `waiting-for-input` via `set_task_state` (admin), patches
    `percussionist.dev/action-abandon`, and asserts the task reaches `done` —
    asserting only on `Task.status.phase` per the deterministic principles.
    Requires the transition-table change from task 1. Add to `e2e:extended`.
13. Update AGENTS.md / docs if the board docs describe the answer flow
    (note: current docs in AGENTS.md already describe `waiting-for-input` as
    parking; add one line about abandon/request-changes exits).

## Risks / open questions

- **Double-delivery window (mitigated by dedupe):** the web UI posts via
  `/reply` and then writes the annotation; the manager may reconcile before the
  run flips to `Running` and would otherwise re-post. The `fetchSessionMessages`
  tail-check in `DeliverAnswer` skips the duplicate. The dedupe relies on the
  exact message text matching; whitespace differences could defeat it (cheap and
  bounded — worth a `.trim()` comparison).
- **Permission-prompt resume is unverified** (noted in the existing client code
  comment, `TaskDetailPanel.tsx:1041-1045`): if opencode's *permission* prompt
  cannot be dismissed by a posted session message, the run never flips back to
  `Running` and the task stays `waiting-for-input` until the dispatcher's 15-min
  idle timeout kills the run → dead-run exit → `failed`. Bounded, not stranded,
  but the answer is then lost; the human retries after the failure.
- **Annotation left on the task while waiting for the run to flip:** if the
  answer is delivered but the run flips slowly, the annotation persists a few
  reconcile cycles — that is intentional (it gates the transition). Stale
  annotations after a dead-run failure are already surfaced by
  `flow-introspection.ts` diagnostics.
- **Non-fatal delivery:** `DeliverAnswer` failure must not block the task
  transition or crash `executeEffects` (it currently returns `applied: false`
  on effect errors, which would stall the cycle — the implementation must
  catch and warn instead).
- **`set_task_state`/CLI moves from `waiting-for-input` to `done`** become legal
  after the transition-table change; this is intended (admin escape hatch) and
  matches the task's "transition table allows" observation.
- **Scope boundaries:** no changes to the dispatcher idle timeout, no removal of
  `waiting-for-input` from `ACTIVE_PHASES` (the parked run pod consumes cluster
  resources, so counting it against `maxParallel` is correct), no new manager
  MCP tools, no change to the client's `replyToRun` behavior.

## Acceptance criteria

1. A task in `waiting-for-input` whose worker run is `Failed`, `Cancelled`, or
   missing transitions to `failed` (`InputRunTerminated`); `Succeeded` → 
   `succeeded` (regression-guarded by existing tests).
2. Setting `percussionist.dev/action-abandon: 'true'` on a `waiting-for-input`
   task transitions it to `done` with `worker.abandoned: true` and clears the
   annotation. `waiting-for-input → done` is in `TRANSITION_TABLE`.
3. Setting `action-request-changes` + `action-rework-feedback` on a
   `waiting-for-input` task transitions it to `rework-requested` with capped
   feedback, `retryCount + 1`, and clears the annotations.
   `waiting-for-input → rework-requested` is in `TRANSITION_TABLE`.
4. Writing `percussionist.dev/action-answer` (via the `/answer` route or
   annotation alone) results in the answer text being posted to the run's
   opencode session (once — dedupe skips repeats), and the task resumes to
   `running` once the run is `Running`, with the annotation cleared.
5. `POST /api/projects/:project/board/tasks/:taskName/abandon` exists and the
   task detail panel offers an Abandon action for `waiting-for-input` tasks.
6. `pnpm typecheck && pnpm test` pass in `@percussionist/api`,
   `@percussionist/manager-controller`, and `@percussionist/web`;
   `pnpm lint` clean.
