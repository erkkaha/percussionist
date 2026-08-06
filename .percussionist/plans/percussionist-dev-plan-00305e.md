# Plan: Board review-stage list — show AI review state (running/pending/approved)

**Task ID:** `percussionist-dev-plan-00305e`
**Type:** PLAN
**Project:** percussionist-dev

## Context

The board's review column (`review`) is where tasks land after a BUILD worker
succeeds. It contains tasks in phases `succeeded`, `reviewing`, `awaiting-human`,
`failed`, and `waiting-for-input` (see `computeBoardColumn` in
`packages/api/src/index.ts`).

### AI review lifecycle (manager-controller)

- In `packages/manager-controller/src/reconciler/decision.ts` (`decideSucceeded`):
  when a BUILD task reaches `succeeded` and `flow.review.aiReviewerEnabled` is
  true, the reconciler transitions the task to **`reviewing`**, sets
  `task.status.worker.reviewRunName`, and emits a `ScheduleReviewRun` effect
  that creates the review Run CR.
- While the review Run is `Pending` / `Initializing` / `Running`, the task stays
  in `reviewing` (`decideReviewing` waits).
- When the review Run `Succeeded` with a verdict:
  - `approve` → `task.status.worker.reviewApproved = true`, appends a
    `ReviewRecord { action: 'approve', reviewRunName, reviewedAt }` to
    `task.status.reviews`, and the task moves to `awaiting-human`.
  - `request_changes` under the rework ceiling → `rework-requested` with
    `worker.aiReworkCount++` and a review record.
  - `request_changes` over the ceiling / run `Failed` / stale / no verdict →
    `awaiting-human` (with an `escalate` record in the ceiling case).

### What the list view shows today (the gap)

`packages/web/src/client/components/board/TaskRow.tsx` renders each task in the
`TaskListPanel`. Current state indicators:

- **Phase badge is only rendered in the `in-progress` column** (line 110:
  `col === 'in-progress' && task.status?.phase`). A task in the `reviewing`
  phase therefore shows **no** phase/state indicator in the review column — the
  AI review being in flight is invisible without opening the task.
- **AI approval is not shown at all.** `worker.reviewApproved` is only rendered
  in the task detail panel (`TaskDetailPanel.tsx` lines 669–683, "Agent review").
  The list only shows *human* approval via the `approvals` prop
  (`percussionist.dev/action-approved` annotation).
- There is no way to distinguish a review that is queued/pending (run not yet
  created, or `Pending`/`Initializing`) from one actively running (`Running`),
  because the board API returns only Task CRs — the review Run phase is not
  part of the response.

### Data availability

- Board endpoint `GET /api/projects/:project/board`
  (`packages/web/src/server/routes/board.ts`) returns `{ settings, columns,
  approvals, status }` where `columns` are Task CRs. Task CRs carry
  `status.phase`, `status.worker.reviewRunName`, `status.worker.reviewApproved`,
  `status.worker.status`, and `status.reviews[]`.
- The review Run phase would require fetching Run CRs. Precedent:
  `packages/web/src/server/lib/push-triggers.ts` already does
  `Promise.all([listTasks(), listRuns()])`. `listRuns()` returns all Runs in the
  namespace (filtered in memory).
- Board live updates go through the polling-SSE endpoint
  `GET /api/projects/:project/board/events` whose signature tracks the project
  resourceVersion, per-task resourceVersions, and approval annotations. A pure
  review-Run phase change does not bump any Task resourceVersion, so it would
  not trigger a board refresh today.

## Approach

Two layers. Layer 1 is the deterministic core (Task-CR-status-only, no server
changes); Layer 2 augments the board response with the review Run phase so the
UI can explicitly distinguish "pending" from "running".

### Layer 1 — deterministic client-side badges (required)

In `TaskRow.tsx`, derive AI review state purely from the Task CR:

1. **AI review in flight** — when `task.status.phase === 'reviewing'`, show an
   "AI review" badge with an animated spinner/pulse (e.g. lucide `Loader2` with
   `animate-spin`). From the task's perspective this covers both pending and
   running: the task remains in `reviewing` for the entire in-flight review
   (run being created, pod starting, or agent working). Text: `ai review…`.
2. **AI approval** — when `task.status.worker.reviewApproved === true`, show an
   "AI approved" badge in the review column (green, e.g. `Check` icon),
   visually distinct from the existing human "approved" badge (which stays as
   is, driven by the `approvals` prop).
3. **Phase badge in the review column** — relax the `col === 'in-progress'`
   guard so the phase badge also renders for review-column tasks (at minimum
   for `reviewing`; showing it for all review-column phases — `succeeded`,
   `awaiting-human`, `failed` — is a natural superset and harmless). This makes
   the review stage directly legible.

No API or schema changes; all assertions derive from CR status fields,
matching the deterministic-testing principle.

### Layer 2 — server-augmented "pending" vs "running" (recommended)

1. **Board route** (`packages/web/src/server/routes/board.ts`): fetch Runs once
   via `listRuns()` (parallel with `listTasks()`), build
   `Map<runName, RunPhase>`, and for each task with
   `status.worker.reviewRunName` attach a computed field on the returned task
   object, e.g. `aiReview: { state: 'pending' | 'running' | 'none' }`:
   - `state: 'pending'` when `phase === 'reviewing'` and either no
     `reviewRunName` is set yet, or the review Run phase is
     `Pending`/`Initializing`.
   - `state: 'running'` when `phase === 'reviewing'` and the review Run phase is
     `Running`.
   - otherwise `state: 'none'` (or omit the field).
2. **SSE signature** (`board.ts` `/board/events`): add review-run
   resourceVersions (names of runs referenced by `worker.reviewRunName` across
   tasks, joined with their resourceVersion) to the signature so a Run phase
   transition (`Pending → Initializing → Running`) fires a `board.updated`
   event. Without this, the pending→running transition would not propagate
   while SSE is connected (the client disables `refetchInterval` when SSE is
   connected — `BoardView.tsx` line 36).
3. **Client types + rendering**: extend the board response type in
   `packages/web/src/client/lib/api.ts` (and `lib/types.ts` if a shared type is
   introduced) and render "AI review pending" vs "AI review running" in
   `TaskRow.tsx` using the augmented field, falling back to Layer 1 behavior
   when the field is absent.

## Tasks (BUILD breakdown)

Proposed BUILD tasks, each independently shippable:

1. **BUILD 1 — TaskRow: "AI review" in-flight badge + phase badge in review
   column**
   - `packages/web/src/client/components/board/TaskRow.tsx`: render
     `ai review…` badge (spinner) when `task.status.phase === 'reviewing'`;
     render the phase badge for review-column tasks (relax the
     `col === 'in-progress'` guard).
   - No prop/type changes; uses only existing Task fields.
2. **BUILD 2 — TaskRow: "AI approved" badge**
   - `TaskRow.tsx`: render `AI approved` badge when
     `worker.reviewApproved === true` (review column), styled distinctly from
     the human approval badge. Keep the human badges untouched.
3. **BUILD 3 — Unit tests for BUILD 1 + 2**
   - Extend `packages/web/tests/task-row.test.tsx` (existing fixtures/helpers:
     `renderTaskRowWithTask`). Cover:
     - `phase: 'reviewing'` in review column → `ai review…` visible.
     - `worker.reviewApproved: true` in review column → `AI approved` visible.
     - `reviewing` task in a non-review column (if applicable) → badge not
       rendered outside the review column (assert intended scope).
     - Human `approved` badge still renders from the `approvals` prop and is
       not confused with AI approval.
   - Follow the file's "least mocking" convention (no `mock.module`).
4. **BUILD 4 — Server: board response includes review Run phase; SSE tracks
   review-run versions**
   - `packages/web/src/server/routes/board.ts`: `listRuns()` once, map
     `reviewRunName → phase`, attach `aiReview: { state }` to each task in
     `columns`.
   - `/board/events` signature: include review-run name:resourceVersion pairs.
   - `packages/web/src/client/lib/api.ts` (`fetchBoard` return type) and
     `TaskRow.tsx` render `AI review pending` / `AI review running` from the
     augmented field (fallback to Layer 1 when absent).
   - Tests: extend `packages/web/tests/board-display-refs.test.ts` (spy on
     `kube.listRuns` alongside existing `getProject`/`listTasks` spies) to
     assert `aiReview.state` for Pending/Initializing vs Running review runs;
     add TaskRow unit assertions for the two badge texts.
5. **BUILD 5 (optional) — deterministic E2E**
   - Per `docs/testing-strategy.md`: ClusterAgent fixture in `k8s/tests/` with
     `CRITICAL OVERRIDE` so the reviewer agent stalls/succeeds predictably,
     then assert only on CR status (`Task.status.phase === 'reviewing'` →
     `worker.reviewApproved === true`) and board JSON state. Only add if a
     project with `aiReviewerEnabled` is exercised in E2E; otherwise unit
     coverage suffices and this BUILD should be skipped.

Order: BUILD 1 → 2 → 3 → 4 (→ 5). BUILD 1–3 are independent of BUILD 4;
BUILD 4 can run in parallel after BUILD 1.

## Acceptance criteria

- A BUILD task in `reviewing` phase shows an **"AI review"** indicator
  (spinner) in the review-column list — visible without opening the task.
- (Layer 2) A task whose review Run is `Pending`/`Initializing` shows
  **"AI review pending"**; one whose review Run is `Running` shows
  **"AI review running"**.
- A task with `worker.reviewApproved === true` shows an **"AI approved"**
  badge in the review-column list.
- Human `approved` / `changes requested` badges (annotation-driven) are
  unchanged and visually distinct from the AI badges.
- The phase badge renders for review-column tasks (so `reviewing` is legible
  even without Layer 2).
- All UI decisions derive from CR status fields only (deterministic
  principle); `pnpm test`, `pnpm typecheck`, `pnpm lint` pass.

## Risks / open questions

- **"Pending" vs "running" precision.** Layer 1 collapses both into the
  `reviewing` phase (single "AI review" badge). The explicit
  pending/running distinction requires Layer 2 (Run data). If reviewers judge
  the single badge sufficient, BUILD 4 can be dropped without losing the core
  feature.
- **SSE churn.** Adding review-run resourceVersions to the board signature
  means each Run phase transition triggers a board refresh. Run phase
  transitions are infrequent (a handful per review), so churn is bounded;
  still, keep the signature keyed on `name:resourceVersion` exactly like
  `taskVersions`.
- **`listRuns()` scope.** It lists all Runs in the namespace (all projects),
  same as `push-triggers.ts` already does. Acceptable; filter to the set of
  `reviewRunName`s in memory. (Alternative: filter server-side by
  `spec.boardTask` — not needed.)
- **Transient `succeeded` phase.** A task in `succeeded` sits in the review
  column for one reconcile cycle before flipping to `reviewing` (when AI review
  is enabled). No badge is planned for that microstate; the reconciler moves it
  out quickly.
- **Worker `status` field**: during `reviewing` the reconciler sets
  `worker.status = 'Running'`; TaskRow deliberately does not render a
  "running" badge for non-in-progress columns today. The new AI badge should
  key on `phase === 'reviewing'` (not `worker.status`) to avoid ambiguity.
