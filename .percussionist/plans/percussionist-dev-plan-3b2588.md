# Plan: Continue work on a task in the PR stage (`awaiting-feature-merge`)

Task: `percussionist-dev-plan-3b2588` — "PR stage changes"
Project: `percussionist-dev`

## Context

### PR-mode integration today

Projects with `flow.integration.mode: 'pr'` (resolved in
`packages/manager-controller/src/reconciler/flow.ts`, `resolveFlow`) do **not** push
the PLAN feature branch straight to the target. Instead:

1. All child BUILD tasks reach `done` → `decideAwaitingChildren` →
   `decideChildrenCompleteNext` (`packages/manager-controller/src/reconciler/decision.ts`)
   transitions the PLAN to `awaiting-feature-merge` and emits `SchedulePrOpenRun`.
2. `SchedulePrOpenRun` (`packages/manager-controller/src/reconciler/effects.ts`) calls
   `buildPrOpenRun` (`packages/manager-controller/src/worker-builder.ts`). The run pushes
   the feature branch, opens a GitHub PR, and reports `outcome=pr-opened` + `prNumber`
   via `complete_merge`.
3. The reconciler records `worker.prNumber`, clears `worker.mergeRunName`, and stays in
   `awaiting-feature-merge`. `observe()` (`reconciler/observations.ts`) then polls
   `getPrState`/`getPrComments` (`reconciler/github-client.ts`) each cycle.
4. `decidePrStateOutcome` (`reconciler/decision.ts`) routes the outcome:
   - PR merged → `done`
   - PR closed without merge → `awaiting-human` (clears `prNumber`)
   - open PR with unevaluated human comments → schedules a PR-feedback evaluation run
     (`decidePrFeedbackEvalOutcome`) which, on `request_changes`, creates a follow-up
     BUILD child via the `CreatePrFollowUpTask` effect and moves the PLAN to
     `awaiting-children`
   - otherwise → keep polling

When the follow-up child merges into the feature branch, `decideChildrenCompleteNext`
re-schedules `SchedulePrOpenRun`; because `worker.prNumber` is still set,
`buildPrOpenRun` runs in **update mode** (`prUpdatePromptLines`) and pushes the revised
head to the *same* PR. This is the existing "continue work in PR stage" loop.

### The gap

The PR-comment feedback loop is the **only** way to continue work once a task is parked
in `awaiting-feature-merge`. That requires posting a comment on GitHub, and it is
invisible to the board and CLI. A human who wants to change scope through
Percussionist has no path:

- `packages/web/src/client/components/board/TaskDetailPanel.tsx` renders
  Approve / Request Changes only when `col === 'review'`; `awaiting-feature-merge`
  maps to the **in-progress** column (`computeBoardColumn`), so no action buttons show.
- `packages/cli/src/board.ts` `requireAwaitingHuman()` rejects every phase except
  `awaiting-human`; `runBoardTaskRequestChanges` uses it.
- `packages/manager-controller/src/reconciler/decision.ts` honors
  `manualActions.requestChanges` only in `decideAwaitingHuman` and
  `decideWaitingForInput`. `decideAwaitingFeatureMerge`/`decidePrStateOutcome` ignore it.
- `packages/manager-controller/src/agent/tools.ts` `manager_approve` errors for
  `awaiting-feature-merge`, and there is no request-changes MCP tool at all.
- `packages/manager-controller/src/reconciler/flow-introspection.ts`
  `explainAwaitingFeatureMerge` does not even understand PR mode (`prNumber` polling,
  no `mergeRunName`), so `inspect_task_flow` reports a misleading "merge run will be
  scheduled".

The web `POST .../request-changes` route (`packages/web/src/server/routes/board.ts`)
is already **ungated** — it writes `percussionist.dev/action-request-changes` +
`percussionist.dev/action-rework-feedback` for any task. So the annotation plumbing
exists; only the reconciler and the human-facing affordances are missing.

### What already works and must be reused

- The transition `awaiting-feature-merge → awaiting-children` already exists in
  `TRANSITION_TABLE` (`packages/api/src/index.ts`), and `awaiting-children →
  awaiting-feature-merge` closes the loop. **No schema/CRD change is needed.**
- `CreatePrFollowUpTask` (`reconciler/effects.ts`) creates a BUILD child with
  `parentTaskRef = planTaskName`, idempotent on AlreadyExists.
- `getConsumedAnnotationKeys` / `ClearTaskAnnotations` handle annotation consumption
  *after* a successful status patch (`executeEffects` defers clears).
- `decidePrFeedbackEvalOutcome` already implements "distil verdict → follow-up BUILD
  child → `awaiting-children`" and is the template for the manual path.

## Approach

Make the human `request-changes` action first-class for a PLAN task parked in the PR
stage, reusing the existing follow-up-child mechanism so the revised head flows to the
same PR with no new run types or CRD fields.

- **Trigger**: a PLAN task in phase `awaiting-feature-merge` with an open PR
  (`worker.prNumber` set, no `mergedAt`/`mergeError`) receives
  `percussionist.dev/action-request-changes: "true"` +
  `percussionist.dev/action-rework-feedback: "<text>"` (written by web, CLI, or the new
  MCP tool).
- **Reconciliation**: `decidePrStateOutcome` consumes the annotation and emits the same
  decision the feedback evaluator emits on `request_changes`:
  `CreatePrFollowUpTask` (title `[PR #N scope change] <plan title>`, description from the
  human feedback, agent `flow.build.defaultAgent`, `parentTaskRef = PLAN`) +
  `ClearTaskAnnotations`, transitioning the PLAN to `awaiting-children`.
- **Continue**: the child is scheduled on `feature/{plan}--{child}`, merged into the
  PLAN branch via the normal `awaiting-merge` path, then `decideChildrenCompleteNext`
  re-runs `SchedulePrOpenRun`; `buildPrOpenRun` sees `worker.prNumber` and updates the
  PR head. No new machinery.
- **Placement / precedence inside `decidePrStateOutcome`** (in order):
  1. `prState.state === 'closed'` (unchanged — a dead PR always wins; it already routes
     to `done` or `awaiting-human`)
  2. `prFeedbackRunName` in flight (unchanged — let the evaluation finish; the human
     annotation persists and is consumed on a later cycle, avoiding an orphaned run)
  3. **NEW**: `manualActions.requestChanges` → follow-up child + `awaiting-children`
  4. open PR + unevaluated comments (unchanged)
  5. keep polling (unchanged)
- **Gating**: only PLAN tasks, only `flow.integration.mode === 'pr'`, only when
  `prNumber` is set and no `mergeRunName` (i.e. the PR is open and polling). Auto-merge
  and manual integration modes are unchanged. BUILD tasks are never in a PR stage.
- **Deterministic child naming** (idempotency): `roundKey` derived from the current
  feedback text plus `createdBuildTaskRefs.length`, so a crash between effect execution
  and the status patch recomputes the *same* name (`CreatePrFollowUpTask` collapses it
  via AlreadyExists) while successive rounds get fresh names.
- **Surfacing**: show a "Request Changes" action in the web detail panel for the PR-stage
  task; relax the CLI gate; teach `inspect_task_flow` about PR mode; update docs.

### Scope boundaries

**In scope**

- Reconciler support for human `request-changes` on `awaiting-feature-merge` PLAN tasks
  in `pr` mode (follow-up BUILD child route).
- Web board action button + inline feedback form for the PR-stage task.
- CLI `beatctl board task request-changes` accepting PR-stage tasks.
- `inspect_task_flow` PR-mode awareness and the suggested action.
- Unit tests + web/CLI tests + docs.
- Optional: `manager_approve`-style `request_changes` MCP tool for parity.
- Optional (extended E2E): deterministic reconciler-wiring test without GitHub.

**Out of scope**

- Scope changes in `auto-merge`/`manual`/`disabled` integration modes (no PR to update).
- Re-running the PLAN worker / buildgen for a PR-stage task (risks duplicate BUILD
  children; the follow-up-child route is the established mechanism).
- Splitting a large scope change into multiple BUILD tasks (a single follow-up child per
  request; a human can request again after the PR head is updated).
- BUILD-task rework paths and `awaiting-merge` (BUILD merge to parent branch).
- Any new `WorkerStatus`/CRD field; any change to GitHub polling, caching, or comment
  detection.
- Auto-merging/approving the PR (merge still happens on GitHub).

## Acceptance criteria

1. A PLAN task in `awaiting-feature-merge` with `worker.prNumber` set (PR open) and the
   `action-request-changes` + `action-rework-feedback` annotations:
   - creates exactly one follow-up BUILD task with `spec.type = 'BUILD'`,
     `spec.parentTaskRef = <plan>`, high priority, agent = `flow.build.defaultAgent`, and
     the human feedback in `spec.description`;
   - transitions the PLAN to `awaiting-children` and appends the child name to
     `worker.createdBuildTaskRefs`;
   - clears `action-request-changes` and `action-rework-feedback`.
2. Idempotency: if the child already exists (retry after a crash between effect and
   status patch), no duplicate child is created and the transition still happens.
3. Once the child merges into the PLAN feature branch and the PLAN re-enters
   `awaiting-feature-merge`, the PR-open run is scheduled in **update** mode
   (`buildPrOpenRun` receives `existingPrNumber`) and reports `outcome=pr-opened` with the
   same PR number.
4. `awaiting-human`, `waiting-for-input`, `reviewing`, `done`, `failed`, and non-PR
   `awaiting-feature-merge` behavior is byte-for-byte unchanged (existing tests pass).
5. CLI: `beatctl board task request-changes --task-name <plan> --feedback <text>` succeeds
   for a PR-stage task and fails with a clear message for a task in a phase that cannot
   consume the annotation (e.g. `done`, `running`, or `awaiting-feature-merge` with no
   `prNumber`).
6. Web: the detail panel shows the Request Changes action for a PR-stage open-PR task,
   submitting writes the annotations and invalidates the board query; the action is not
   shown for tasks without an open PR.
7. `inspect_task_flow` for a PR-stage task explains that a PR is open and that
   `action-request-changes` starts a scope-change follow-up child.
8. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; docs updated.

## Tasks (proposed BUILD breakdown)

Each task is independently reviewable; dependencies noted.

1. **Extract a shared PR follow-up helper in `decision.ts` (pure refactor).**
   - In `packages/manager-controller/src/reconciler/decision.ts`, factor the
     child-creation decision currently inlined at the end of `decidePrFeedbackEvalOutcome`
     (title/description construction, `CreatePrFollowUpTask` + `CleanupWorktree` effects,
     `awaiting-children` transition, `createdBuildTaskRefs` append) into
     `prFollowUpDecision(input, prNumber, fromPhase, feedbackText, roundKey, runToCleanup?)`.
   - Have `decidePrFeedbackEvalOutcome` call it (behavior unchanged) and pass the eval
     run name for cleanup. This is a pure refactor so existing `decision.test.ts` PR
     cases must still pass without edits.
   - Files: `packages/manager-controller/src/reconciler/decision.ts`, tests in
     `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`.

2. **Honor `requestChanges` in the PR-stage polling branch.**
   - In `decidePrStateOutcome` (`decision.ts`), after the `prState.state === 'closed'`
     block and the `prFeedbackRunName` block, add: if `manualActions.requestChanges` and
     `task.spec.type === 'PLAN'`, call `prFollowUpDecision` with the human feedback;
     include `ClearTaskAnnotations` (consumed keys via `getConsumedAnnotationKeys`) in the
     effects and transition to `awaiting-children`.
   - `roundKey = \`${task.status?.worker?.createdBuildTaskRefs?.length ?? 0}:${manualActions.reworkFeedback ?? ''}\``.
   - Title: `` `[PR #${prNumber} scope change] ${task.spec.title}`.slice(0, 256) ``;
     description mirrors the evaluation path (task/PR reference + feedback, capped 7500).
   - Guard: skip when `task.status?.worker?.mergeRunName` is set (not reachable from
     `decidePrStateOutcome`'s call site, asserted anyway) or when `reworkFeedback` is
     empty (fall back to a default brief, matching `decideAwaitingHuman`).
   - Unit tests in `decision.test.ts`: requestChanges on an open PR → one
     `CreatePrFollowUpTask`, `toPhase = 'awaiting-children'`, `createdBuildTaskRefs`
     append, `ClearTaskAnnotations` present; same feedback twice → same child name;
     closed PR still wins; non-PLAN guard; no-op when no annotation.
   - Depends on Task 1.

3. **Harden follow-up idempotency and stale-annotation handling.**
   - In `packages/manager-controller/src/reconciler/effects.ts` `CreatePrFollowUpTask`:
     read the existing child before patching; do **not** reset a child whose phase is
     `done` (only set `pending` when absent or when it is still schedulable). Prevents a
     repeated request from resurrecting completed work.
   - In `decision.ts`, when the feedback-evaluation path creates a follow-up
     (`decidePrFeedbackEvalOutcome`) and `manualActions.requestChanges` is also set,
     include the request-changes annotation keys in that decision's
     `ClearTaskAnnotations` so the explicit human request is consumed together with the
     evaluation round.
   - Unit tests in `effects.test.ts` and `decision.test.ts`.
   - Depends on Task 1.

4. **CLI: allow request-changes on a PR-stage task.**
   - `packages/cli/src/board.ts`: extend `requireAwaitingHuman` with an
     `allowPrStage` option (or add `requireRequestChangesEligible`), and have
     `runBoardTaskRequestChanges` accept a task when
     `phase === 'awaiting-human'` **or**
     (`phase === 'awaiting-feature-merge'` && `task.status?.worker?.prNumber` set).
   - Update the error text to explain the PR-stage case and keep `approve` unchanged.
   - Update the command description in `packages/cli/src/index.ts`.
   - Tests: extend `packages/cli/test/board-annotations.test.ts` (pure
     `requestChangesTaskMetadataPatch` already exists) with gating coverage via the
     `board-task-signature.test.ts` mock-state pattern.
   - Independent.

5. **Web: surface the Request Changes action in the PR stage.**
   - `packages/web/src/client/components/board/TaskDetailPanel.tsx`: compute
     `isPrStage = task.status?.phase === 'awaiting-feature-merge' &&
     getPrPresentation(task)?.state === 'open'` and render the existing Request Changes
     button + inline form for it (in addition to `col === 'review'`). Add a one-line hint
     that this creates a follow-up BUILD task which updates the open PR.
   - Reuse `requestChangesMutation` / `requestChangesTask` unchanged; no API change.
   - `packages/web/src/server/routes/board.ts` request-changes route already writes the
     annotations for any phase; add a focused route test asserting the annotation is
     written for a PR-stage task.
   - Tests: extend `packages/web/tests/task-detail-pr.test.tsx` (renders
     `awaiting-feature-merge` + `prNumber` today) and `packages/web/tests/board-view.test.tsx`.
   - Independent.

6. **`inspect_task_flow`: PR-mode awareness for `awaiting-feature-merge`.**
   - `packages/manager-controller/src/reconciler/flow-introspection.ts`
     `explainAwaitingFeatureMerge`: when `prNumber` is set and `mergeRunName` is unset,
     report "PR #N open; waiting for merge", name the `action-request-changes` +
     `action-rework-feedback` scope-change path and the PR-comment path, and include the
     pending `requestChanges` flag from `extractManualActions`.
   - Tests: extend `packages/manager-controller/src/reconciler/__tests__/flow-introspection.test.ts`.
   - Independent.

7. **Documentation.**
   - `docs/task-lifetime.md`: rewrite the `awaiting-feature-merge` section for PR mode
     (pr-open run, polling, feedback loop, and the new human request-changes →
     follow-up BUILD → PR-head update loop); fix the `awaiting-human` action table note if
     needed.
   - `docs/reference/task-lifecycle.md`: add `awaiting-children` to the
     `awaiting-feature-merge` row and document the request-changes-in-PR-stage action.
   - `AGENTS.md`: update the "Feature Branch Merge" PR-mode bullet to mention the
     board/CLI scope-change path in addition to PR comments.
   - Independent.

8. **(Optional parity) Manager MCP `request_changes` tool.**
   - `packages/manager-controller/src/agent/tools.ts`: add a tool that writes
     `action-request-changes` + `action-rework-feedback` on a task, mirroring
     `manager_approve`'s annotation semantics and phase checks (awaiting-human **or**
     PR-stage `awaiting-feature-merge`). Reuse the same eligibility helper as the CLI if
     practical (or duplicate the small predicate).
   - Register it in the MCP tool list and cover with a new
     `packages/manager-controller/src/agent/__tests__/request-changes-tool.test.ts`.
   - Depends on Task 4 for the gate semantics; can be dropped without affecting the rest.

9. **(Optional, extended E2E) Deterministic PR-stage scope-change wiring.**
   - New `tests/e2e/e2e-pr-stage-scope-change.test.ts` using shared harness: create a
     feature-branching project, force a PLAN task into `awaiting-feature-merge` with
     `worker.prNumber` patched (no real GitHub reachable → `prState` stays undefined),
     write the request-changes annotations, and assert a follow-up BUILD child appears
     with `parentTaskRef` and the PLAN is in `awaiting-children`. Add to
     `e2e:extended` (requires live cluster; no GitHub token).
   - Optional because the core is fully covered by Task 2 unit tests.

## Risks / open questions

- **Stale annotation after a failed deferred clear.** `ClearTaskAnnotations` runs only
  after a successful status patch, but if *that* annotation patch fails, the intent
  lingers. In `awaiting-children` it is inert, but it would fire again when the PLAN
  returns to `awaiting-feature-merge`, and the count-based round key would then produce a
  *second* child. Mitigations: Task 3's "don't resurrect a done child" guard; consider
  having `decideAwaitingChildren` clear leftover action annotations (cheap, no-op
  transition) as an extra guard. Flag for reviewer input.
- **Race with an in-flight feedback-evaluation run.** The PR-comment evaluator and a
  human request could both produce children in the same window. The chosen precedence
  (evaluation first, human request consumed next cycle) plus Task 3 clearing the human
  annotation when the evaluator acts is intended to keep this at most one extra child.
  Confirm this is acceptable vs. cancelling the evaluator outright.
- **One child per scope change.** A large scope change may warrant multiple BUILD tasks;
  the follow-up route produces one. The human can request again after the PR head
  updates. If multi-task decomposition is required, a buildgen-style scope-change run
  would be the follow-up (explicitly out of scope here).
- **`createdBuildTaskRefs` accuracy.** If children were created outside buildgen (e.g.
  `create_task` MCP with `parentTaskRef`), the array may not reflect them, so the first
  manual round key can repeat. The feedback-text component of the round key plus Task 3's
  AlreadyExists handling keep this idempotent for identical requests.
- **PR state is cached 15 min** (`PR_POLL_TTL_MS`). The new action does not depend on a
  fresh `prState` (the manual branch runs before/independent of comment detection), but
  the "PR closed" guard may lag by up to one cache window. Accepted (unchanged behavior).
- **UI phase source.** The web action relies on `status.phase` + `worker.prNumber` in the
  board payload (already returned verbatim). If `prNumber` is cleared (closed PR), the
  action correctly disappears.
- **Open question — auto-merge mode.** A scope change while `auto-merge` is enabled has
  no PR to update; the task is out of scope. Confirm no user expectation to support it.
