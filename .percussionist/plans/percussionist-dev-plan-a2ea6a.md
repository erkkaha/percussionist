# Plan: Board shows "failed" when a run is waiting for user input

Task: `percussionist-dev-plan-a2ea6a` — "board list task shows failed when run is waiting for user input"

Revision: RETRY 4 — this is the first successful write of the plan artifact
(previous attempts failed before producing a plan; the task description was
empty, so the title is the only spec).

## Context

### The lifecycle being misread

When an agent run needs a human, the dispatcher publishes
`RunPhase.WaitingForInput` on the Run CR (`packages/dispatcher/src/polling.ts`
~lines 907-915). Since commit `5660bc5` this phase is only published when a
human is *actually* needed (`needsHumanInput` — set exclusively by the
`permission.updated` SSE event, line 987), never on the routine `session.idle`
after a completed turn. The pod stays alive; opencode is parked on a permission
prompt (or an aborted message).

The manager's decision engine reacts to that run phase in
`decideRunning` (`packages/manager-controller/src/reconciler/decision.ts`
lines 438-464):

- **PLAN task** → task phase `waiting-for-input` (no worker patch; worker stays
  `Running`). Event reason `WaitingForInput`.
- **any non-PLAN task (BUILD)** → task phase `failed`, `worker.status: 'Failed'`
  (no `completedAt`), event reason `BuildCannotWait` ("BUILD tasks cannot wait
  for input"). **The Run CR remains `WaitingForInput` — the pod is still alive
  and waiting.**

### Why the board shows "failed"

The board task list renders a red **`failed`** badge purely off the worker
status: `packages/web/src/client/components/board/TaskRow.tsx` lines 128-131 —

```tsx
{/* Failed */}
{col !== 'in-progress' && worker?.status === 'Failed' && (
  <span className="text-label-md font-mono uppercase text-phase-failed">failed</span>
)}
```

So for a BUILD task whose run is waiting for user input, the task list shows a
red "failed" badge at the same time the runs panel shows the run as
`WaitingForInput` — contradictory. If the human later resolves the prompt and
the run succeeds, the task is still `failed` (and needs a manual retry that
re-runs the whole task).

Related gaps in the same surface:

- **PLAN tasks** in `waiting-for-input` phase show **no** badge at all in
  `TaskRow` (only `Escalated`/`Succeeded`/`Failed` worker badges exist), so a
  task that is genuinely parked for a human is indistinguishable from a plain
  review-lane task.
- `StatusBadge` (`packages/web/src/client/components/StatusBadge.tsx`) has no
  `WaitingForInput` mapping, so every run badge for a waiting run renders as the
  generic gray `outline` variant (TaskRunsPanel, RunList, RunDetail).
- **No way to answer from the board.** `POST /api/runs/:name/reply`
  (`packages/web/src/server/routes/runs.ts` lines 169-205) forwards a message
  into the opencode session and `POST /board/tasks/:taskName/answer`
  (`packages/web/src/server/routes/board.ts` lines 595-627) writes the
  `percussionist.dev/action-answer` annotation, but **nothing in the web client
  calls either endpoint**. `decideWaitingForInput` (decision.ts lines 495-515)
  only resumes a parked task when the run is back to `Running` **and** the
  answer annotation is present — so without a UI, a `waiting-for-input` task is
  a dead end from the board's perspective.
- `TaskPhase` doc comment (`packages/api/src/index.ts` line 868) says
  `waiting-for-input` is "PLAN-only", which is currently true of the decision
  engine but not of the transition table (`running → waiting-for-input` is
  already legal for every task type, line 922).

### Why the board data needs the run phase

`TaskRow` only receives the `Task`; the board route
(`packages/web/src/server/routes/board.ts` GET `/:project/board`, lines
110-221) groups tasks into columns and attaches `childProgress`/`displayRefs`
but never the worker run's phase. To distinguish "failed because the run
genuinely failed" from "failed because the run is parked on a human", the board
payload must carry the worker run phase. `listRuns(ns, client, labelSelector)`
is already exported by `@percussionist/kube` and re-exported by
`packages/web/src/server/kube.ts` (used by `push-triggers.ts`); runs carry the
`percussionist.dev/project` label, so it can be filtered per project.

## Approach

Two-layer fix: make the board list **tell the truth** (display layer), and stop
the state machine from manufacturing a `failed` task while its run is still
alive and waiting (state layer). The state change makes the display fix
self-consistent; on its own the display fix would leave the underlying
"task failed but run may still succeed" contradiction in place.

### 1. Display truth (core, always landed)

- **Server**: the board route attaches the worker run's phase to each task as
  `workerRunPhase` (from `task.status.worker.runName`), so the client never has
  to guess from the worker status alone.
- **TaskRow**:
  - When `workerRunPhase === 'WaitingForInput'`, suppress the red "failed"
    badge and render an amber **"waiting for input"** badge instead (with a
    `title` tooltip explaining the run is paused for a human).
  - When `task.status.phase === 'waiting-for-input'`, render the same amber
    badge (PLAN tasks currently render nothing).
- **StatusBadge / ui/badge**: add a `WaitingForInput → waiting` variant (amber,
  using the existing `phase-pending` token family — `--phase-pending: #fbbf24`
  is already amber) so run badges in TaskRunsPanel / RunList / RunDetail stop
  rendering as generic gray outline.
- **TaskDetailPanel**: header worker badge shows "waiting for input" (amber)
  instead of raw `worker.status` when the run is `WaitingForInput`; the "Retry"
  button (shown when `worker.status` is `Failed`/`Escalated`, lines 1133-1142)
  is hidden while the run is still alive and waiting — clicking it would reset
  the task to `pending` and spawn a duplicate run while the old one is parked.

### 2. State truth (recommended; fixes the root cause)

Stop hard-failing BUILD tasks on `WaitingForInput`. The "BUILD tasks cannot
wait for input" rule was a safety net from before commit `5660bc5`, when a
healthy run could spuriously report `WaitingForInput` (the `session.idle`
false positive). With `needsHumanInput` now meaning "a human is genuinely
required", parking is safe and matches the async human-in-the-loop design the
PLAN path already uses:

- `decideRunning`: drop the `task.spec.type !== 'PLAN' → failed` branch; every
  task type transitions to `waiting-for-input` (worker status untouched).
- `decideWaitingForInput`: add exits for a dead run so a parked task can never
  be stranded forever:
  - worker run **missing** or phase `Failed`/`Cancelled` → task `failed` with
    `worker.status: 'Failed'` (board's failed badge is then truthful again);
  - worker run phase `Succeeded` (run finished while parked, e.g. the human
    answered through the session) → task `succeeded` — requires adding
    `succeeded` to the `waiting-for-input` row of `TRANSITION_TABLE`
    (`packages/api/src/index.ts` line 923).
  - existing behavior kept: answer annotation + run `Running` → `running`.
- Update the `TaskPhase.waiting-for-input` doc comment (drop "PLAN-only").
- `waiting-for-input` stays in the `review` board column (`computeBoardColumn`,
  api line 895) — same lane PLAN tasks already use; only the badge changes.

### 3. Answer flow (optional but recommended follow-up)

Without it, a parked task cannot be resumed from the board (dead-end, same as
PLAN today): add a compact "Answer" box in `TaskDetailPanel` (and/or a
`TaskRow` affordance) for tasks whose run is `WaitingForInput`, which
1. calls `POST /api/runs/:name/reply` to forward the human's message into the
   opencode session, and
2. calls `POST /board/tasks/:taskName/answer` to write the answer annotation
   the reconciler consumes.

Needs live verification that a posted session message resumes a permission
prompt (opencode permission semantics); if it doesn't, the answer box only
works for aborted-message waits and the docs should say so.

**Scope boundaries**

- No changes to the dispatcher (`polling.ts`) — `WaitingForInput` detection is
  already correct.
- No changes to `computeBoardColumn` (waiting-for-input stays in review lane)
  unless reviewers prefer a dedicated lane.
- No new CRD schema fields: `workerRunPhase` is a server-computed view field on
  the board response (like `childProgress`/`displayRefs`), not a Task status
  field.
- Push notifications already fire for `waiting-for-input` task transitions
  ("Task is asking a question", `push-triggers.ts`) — no change needed.

## Tasks

1. **Server — attach worker run phase to board tasks** —
   `packages/web/src/server/routes/board.ts`:
   - Import `listRuns` from `../kube.js`.
   - In GET `/:project/board`, after `listTasks(name)`, fetch the project's runs
     (`listRuns(ns, undefined, 'percussionist.dev/project=<name>')`, `ns` from
     `project.metadata.namespace ?? NAMESPACE`) and build a `name → phase` map.
   - In the per-task loop, attach `workerRunPhase` (and optionally
     `workerRunMessage`) from `task.status.worker.runName` to `taskWithProgress`.
2. **Client type** — `packages/web/src/client/lib/types.ts`: add
   `workerRunPhase?: string` (and `workerRunMessage?: string`) to the client
   `Task` interface (lines ~54-67).
3. **Badge variant** — `packages/web/src/client/components/ui/badge.tsx`: add a
   `waiting` variant to `badgeVariants` + `dotVariants` styled with the
   `phase-pending` tokens (or plain amber classes matching TaskRow's existing
   "changes requested" `text-amber-400`); map it in
   `packages/web/src/client/components/StatusBadge.tsx` as
   `WaitingForInput: 'waiting'`.
4. **TaskRow badge logic** — `packages/web/src/client/components/board/TaskRow.tsx`:
   - Compute `const isWaiting = workerRunPhase === 'WaitingForInput' || task.status?.phase === 'waiting-for-input'`.
   - Suppress the "failed" badge (lines 128-131) when `isWaiting`.
   - Render an amber "waiting for input" badge when `isWaiting`, with a
     `title` tooltip (e.g. "Run is waiting for user input"). Place it with the
     other worker badges so it also shows for PLAN tasks in the review lane.
5. **TaskDetailPanel** —
   `packages/web/src/client/components/board/TaskDetailPanel.tsx`:
   - Header worker badge (lines ~1056-1060): when `workerRunPhase ===
     'WaitingForInput'`, show an amber "waiting for input" badge instead of the
     raw `worker.status`.
   - Retry button (lines ~1133-1142): hide while `workerRunPhase ===
     'WaitingForInput'` (run alive); add a small hint line when waiting.
   - (With task 9) render the answer box here.
6. **Manager — park BUILD tasks on WaitingForInput** —
   `packages/manager-controller/src/reconciler/decision.ts` lines 438-464:
   - Remove the `task.spec.type !== 'PLAN' → failed` (`BuildCannotWait`) branch;
     all task types transition to `waiting-for-input`.
   - Remove/adjust the now-dead `BuildCannotWait` event; the `WaitingForInput`
     event covers it.
7. **Manager — exits from waiting-for-input** —
   `decision.ts` `decideWaitingForInput` (lines 495-515) and
   `packages/api/src/index.ts` line 923:
   - Add `'succeeded'` to the `waiting-for-input` row of `TRANSITION_TABLE`.
   - In `decideWaitingForInput`: if the worker run is missing or terminal
     (`Failed`/`Cancelled` via `getEffectiveRunPhase`) → `failed` with
     `worker: { status: 'Failed' }` + event (e.g. `InputRunTerminated`); if run
     phase `Succeeded` → `succeeded` with `worker: { status: 'Succeeded',
     completedAt: now }`; keep the answer+Running → `running` path unchanged.
   - Update the `waiting-for-input` phase doc comment in `packages/api/src/index.ts`
     (drop "PLAN-only").
8. **Tests**:
   - Manager: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
     — change `'running + WaitingForInput BUILD → failed'` (lines 289-296) to
     expect `waiting-for-input`; add cases: parked + run missing → `failed`;
     parked + run `Failed` → `failed`; parked + run `Succeeded` → `succeeded`;
     parked + answer + run `WaitingForInput` → no-op (existing edge case, line
     1754, stays green).
   - Web server: a board-route test (pattern of `packages/web/tests/board-move.test.ts`)
     asserting the response carries `workerRunPhase` from the mocked run.
   - Web client: extend `packages/web/tests/task-row.test.tsx` (or a new
     `task-row-waiting.test.tsx`) for: waiting run → amber "waiting for input"
     badge and **no** "failed" text; `waiting-for-input` phase → badge shows;
     plain failed task → "failed" still shows. A StatusBadge variant mapping
     test (mirror `push-triggers.test.ts` style).
9. **Answer flow (optional, recommended)** —
   - `packages/web/src/client/lib/api.ts`: add `replyToRun(runName, message)`
     (POST `/api/runs/:name/reply`) and `answerTask(project, taskName, answer)`
     (POST `/board/tasks/:taskName/answer`).
   - `TaskDetailPanel`: for tasks whose run is `WaitingForInput`, render an
     "Answer" textarea + submit that calls both endpoints (reply first, then
     answer), invalidating the board query on success.
   - Test: a component test asserting both API calls fire with the typed text.
10. **Verify** — `pnpm typecheck && pnpm lint && pnpm test`; targeted:
    `pnpm --filter @percussionist/manager-controller test`,
    `pnpm --filter @percussionist/web test`.

## Risks / open questions

- **BUILD 3 without BUILD 9 = dead end.** Parking BUILD tasks means they can
  no longer be retried via the "failed → retry" path; if the answer flow isn't
  shipped, a parked BUILD task is unresumable from the board. **Mitigation:**
  land tasks 6-7 only together with task 9, or ship tasks 1-5 alone (display
  truth) and leave the fail-on-wait behavior as the fallback — the display fix
  alone already removes the reported symptom.
- **Permission-prompt resume semantics.** The answer flow posts a session
  message via `/api/runs/:name/reply`; it is unverified that this resolves an
  opencode *permission* prompt (vs. an aborted-message wait). Verify on a live
  cluster before committing to the answer box; if it fails, restrict the UI to
  the cases that work and document the limitation.
- **`waiting-for-input` while run still `Running`.** `decideWaitingForInput`'s
  resume condition requires the run to be back in `Running` *and* the answer
  annotation present. There is a window where the run resumed but the task is
  still parked; the next reconcile clears it. Acceptable, but worth a comment.
- **Board SSE refresh.** The board SSE signature keys on task
  `resourceVersion`; a run-only phase flip would not refresh the board. In
  practice every `WaitingForInput` publish is followed by a task phase change
  (`→ waiting-for-input`, or `→ failed` today), which bumps the task version —
  no SSE change needed. If the display-only package ships, the BUILD task still
  flips to `failed`, so the refresh still fires.
- **Stale-run timeout.** `decideRunning`'s `WorkerRunStale` check only runs for
  `Running`-phase runs; `WaitingForInput` runs are excluded, so a parked run
  doesn't get failed by the stale check. Unchanged by this plan.
- **Review-lane actions.** A parked (`waiting-for-input`) task sits in the
  review lane where the "Approve / Request Changes" buttons show. Consider
  hiding or relabeling those for `waiting-for-input` tasks in task 5/9 (small
  polish; reviewer's call).

## Acceptance criteria

1. While a task's worker run is in `WaitingForInput`, the board list shows an
   amber **"waiting for input"** badge and never the red **"failed"** badge for
   that task — even when `worker.status` is currently `'Failed'` (BUILD,
   pre-park behavior) or `'Running'` (PLAN).
2. A task in `waiting-for-input` phase shows the amber badge in the review lane
   (currently renders nothing).
3. Run badges everywhere (TaskRunsPanel, RunList, RunDetail) render
   `WaitingForInput` with the amber `waiting` variant, not generic outline.
4. TaskDetailPanel shows "waiting for input" for a waiting run and does not
   offer "Retry" while the run is alive; the badge and buttons become truthful
   once the run terminates.
5. With the state change: a BUILD task whose run hits `WaitingForInput` parks in
   `waiting-for-input` (event `WaitingForInput`) instead of `failed`; if the run
   dies or terminates while parked, the task becomes `failed` and is retryable;
   if the run succeeds while parked, the task becomes `succeeded`.
6. Board endpoint response includes `workerRunPhase` per task.
7. (With the answer flow) a human can answer a waiting task from the board; the
   reply is forwarded to the run session, the answer annotation is written, and
   the task resumes to `running` once the run is back in `Running`.
8. `pnpm typecheck && pnpm lint && pnpm test` pass; manager + web suites green.

## Proposed BUILD task breakdown

1. **BUILD — server: attach `workerRunPhase` to board tasks** (`board.ts`,
   board-route test). No dependencies.
2. **BUILD — client: "waiting for input" presentation** (`types.ts`,
   `ui/badge.tsx`, `StatusBadge.tsx`, `TaskRow.tsx`, `TaskDetailPanel.tsx` +
   component tests). Depends on BUILD 1 (consumes `workerRunPhase`).
3. **BUILD — manager: park instead of fail + dead-run exits**
   (`decision.ts`, `index.ts` transition table + phase comment,
   `decision.test.ts`). Independent of BUILD 1-2.
4. **BUILD — (optional) board answer flow** (`api.ts` reply/answer functions,
   TaskDetailPanel answer box, component test). Depends on BUILD 3 for a
   resumable target state; can also be developed against the current PLAN-only
   parking.

Ordering: 1 → 2 lands the reported symptom fix; 3 + 4 land the root-cause fix.
If scope must be trimmed, 1 + 2 alone satisfy the acceptance criteria 1-4 and 6.
