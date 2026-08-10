# Plan: Board review-stage list — AI review state badges (in-flight + approved) with robot icon

**Task ID:** `percussionist-dev-plan-00305e`
**Type:** PLAN
**Project:** percussionist-dev
**Revision:** 2 (retry 1/3)

## Context

The board's review column (`review`) is where tasks land after a BUILD worker
succeeds. It contains tasks in phases `waiting-for-input`, `succeeded`,
`reviewing`, `awaiting-human`, and `failed` (see `computeBoardColumn` in
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
    `task.status.reviews`, and the task moves to `awaiting-human` (still in the
    review column).
  - `request_changes` under the rework ceiling → `rework-requested` with
    `worker.aiReworkCount++` and a review record.
  - `request_changes` over the ceiling / run `Failed` / stale / no verdict →
    `awaiting-human` (with an `escalate` record in the ceiling case).

### What the list view shows today (the gap)

`packages/web/src/client/components/board/TaskRow.tsx` renders each task in the
`TaskListPanel`. Current state indicators:

- **AI review in flight is invisible.** The phase badge is only rendered in the
  `in-progress` column (line 110: `col === 'in-progress' && task.status?.phase`).
  A task in `reviewing` phase therefore shows no state indicator in the review
  column — the in-flight AI review cannot be seen without opening the task.
- **AI approval is not shown at all.** `worker.reviewApproved` is only rendered
  in the task detail panel (`TaskDetailPanel.tsx` lines 669–683, "Agent review"
  section). The list only shows *human* approval via the `approvals` prop
  (from the `percussionist.dev/action-approved` annotation), rendered as a plain
  `<Check/> approved` badge (TaskRow.tsx lines 133–139).
- **AI vs human provenance is indistinguishable in the list.** There is no
  marker that a state came from the AI reviewer rather than a human.

### Retry feedback incorporated

Reviewer feedback on revision 1: *"Layer 1 is sufficient. Indicate with robot
icon that the review check icon is from Ai."*

- **Layer 2 is dropped entirely** — no server changes (no `listRuns()` fetch in
  the board route, no board-SSE signature changes, no `aiReview.state`
  pending/running split). The single "ai review…" badge covers both the
  pending and running cases from the task's perspective: the task remains in
  `reviewing` phase for the entire in-flight review (run being created, pod
  starting, or agent working).
- **Every AI-originated badge carries the lucide `Bot` (robot) icon.** The AI
  approval check mark is shown alongside a robot icon so it is unmistakably the
  AI reviewer's verdict, visually distinct from the human `approved` badge
  (which keeps the plain `Check` icon, unchanged).

### Data availability

- Board endpoint `GET /api/projects/:project/board`
  (`packages/web/src/server/routes/board.ts`) returns `{ settings, columns,
  approvals, status }` where `columns` are Task CRs. Task CRs carry
  `status.phase` and `status.worker.reviewApproved` — both already present in
  the response, so **no API or schema changes are needed**.
- `Task.status.worker.reviewApproved` is `true` only after an AI review run
  approves (schema: `packages/api/src/index.ts` line 976). During `reviewing`
  it is `undefined`.
- `computeBoardColumn` maps `reviewing` and `awaiting-human` to the `review`
  column, so gating the new badges on `col === 'review'` (mirroring the human
  approval badges) is exact.

## Approach — single deterministic client-side layer (Layer 1)

All changes live in `packages/web/src/client/components/board/TaskRow.tsx`
(plus tests). No server, API, or schema changes. All UI decisions derive from
Task CR status fields only (`status.phase`, `status.worker.reviewApproved`),
matching the deterministic-testing principle.

Icons (verified present in `lucide-react@1.17.0`): `Bot` (`bot.mjs`), `Loader2`
(`loader-2.mjs`), `Check` (already imported).

### Badge 1 — AI review in-flight ("ai review…")

- **Trigger:** `task.status.phase === 'reviewing'` (task is in the review
  column; phase covers pending + initializing + running).
- **Render:** `<Bot /> <Loader2 className="animate-spin" /> ai review…`
  (accent/pending color, e.g. `text-accent`), gated on `col === 'review'`.
- The robot icon + spinner make it legible as an *AI* review in progress,
  distinct from the phase/worker badges.

### Badge 2 — AI approval ("ai approved")

- **Trigger:** `task.status.worker.reviewApproved === true` (task is in
  `awaiting-human` in the review column).
- **Render:** `<Bot /> <Check /> ai approved` in `text-phase-succeeded`
  (green), gated on `col === 'review'`. The `Bot` icon is the explicit robot
  marker that the check mark is the AI reviewer's verdict.
- The human `approved` badge (plain `<Check /> approved`, approval-annotation
  driven) stays exactly as-is — the robot icon is the differentiator.

### Badge 3 (secondary) — phase badge in the review column

- Relax the `col === 'in-progress'` guard (line 110) to also render the raw
  phase text for review-column tasks, **excluding `reviewing`** (superseded by
  Badge 1 — avoid showing "reviewing" twice).
- Makes `succeeded` / `awaiting-human` / `failed` phases directly legible.
- Marked optional: the existing worker-status badges ("succeeded"/"failed",
  lines 121–131) already convey part of this; drop Badge 3 if reviewers deem it
  redundant.

## Tasks (BUILD breakdown)

Proposed BUILD tasks, each independently shippable (order: 1 → 2 → 3):

1. **BUILD 1 — TaskRow: "ai review…" in-flight badge + review-column phase
   badge**
   - `packages/web/src/client/components/board/TaskRow.tsx`: import `Bot` and
     `Loader2` from `lucide-react`; render Badge 1 (`phase === 'reviewing'` &&
     `col === 'review'`); relax the phase-badge guard to include `col ===
     'review'` while excluding `reviewing` (Badge 3).
   - No prop/type changes; uses only existing Task CR fields.
2. **BUILD 2 — TaskRow: "ai approved" badge with robot icon**
   - `TaskRow.tsx`: render Badge 2 (`worker.reviewApproved === true` &&
     `col === 'review'`) with `Bot` + `Check` icons, green styling. Keep the
     human `approved` / `changes requested` badges untouched.
   - Optional consistency touch (same BUILD): add a `Bot` icon next to the
     "Agent review" label in `TaskDetailPanel.tsx` (lines 669–683) so the
     detail view and list view share the same AI provenance marker.
3. **BUILD 3 — Unit tests for BUILD 1 + 2**
   - Extend `packages/web/tests/task-row.test.tsx` (existing helper
     `renderTaskRowWithTask(task, col)`, least-mocking convention, no
     `mock.module`). Cases:
     - `phase: 'reviewing'` in `col: 'review'` → `ai review…` text visible
       (and the `animate-spin` class present on the spinner).
     - `worker.reviewApproved: true` with `phase: 'awaiting-human'` in
       `col: 'review'` → `ai approved` text visible.
     - Human `approved` badge (approvals prop) still renders and does **not**
       carry the `Bot` icon (assert the robot marker only appears on AI
       badges).
     - `worker.reviewApproved: true` in a non-review column (e.g.
       `col: 'in-progress'`) → no `ai approved` badge (scope guard).
     - `reviewing` task → phase text "reviewing" is not duplicated alongside
       the `ai review…` badge (Badge 3 exclusion).
   - Follow `afterEach(cleanup)` and the file's existing patterns.

No BUILD 4 / BUILD 5: Layer 2 (server Run-phase augmentation + SSE signature)
and the deterministic E2E are intentionally out of scope per the review
feedback. This is a pure client-side change; unit coverage in `task-row.test.tsx`
is sufficient.

## Acceptance criteria

- A BUILD task in `reviewing` phase shows an animated **"ai review…"** badge
  (robot icon + spinner) in the review-column list — visible without opening
  the task; covers both the pending and running review states.
- A BUILD task with `worker.reviewApproved === true` shows an **"ai approved"**
  badge whose check mark is accompanied by a **robot icon** (`Bot`) in the
  review-column list — unmistakably AI-originated, visually distinct from the
  human `approved` badge (plain `Check`).
- Human `approved` / `changes requested` badges (annotation-driven) are
  unchanged and visually distinct from the AI badges.
- All UI decisions derive from Task CR status fields only (`status.phase`,
  `status.worker.reviewApproved`) — deterministic principle; no API or schema
  changes.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` pass.

## Risks / open questions

- **Pending vs running not distinguished.** The single "ai review…" badge
  collapses `Pending`/`Initializing`/`Running` into one state (the task stays
  in `reviewing` the whole time). Explicitly accepted per review feedback
  ("Layer 1 is sufficient"). If a future iteration wants the split, it requires
  the Layer 2 Run-phase data that was dropped here.
- **Badge 3 redundancy.** The generic review-column phase badge may partially
  overlap the existing worker-status badges ("succeeded"/"failed"). It is
  optional; BUILD 1 can be trimmed to Badge 1 alone if reviewers object.
- **Icon availability.** `Bot` and `Loader2` are confirmed present in
  `lucide-react@1.17.0` (the pinned version in `packages/web/package.json`).
- **No E2E coverage.** If live-cluster verification of the `aiReviewerEnabled`
  flow is later required, a deterministic E2E (ClusterAgent fixture with
  `CRITICAL OVERRIDE`, asserting only `Task.status.phase` /
  `worker.reviewApproved`) can be added per `docs/testing-strategy.md` as a
  follow-up; unit coverage suffices for this client-only change.
