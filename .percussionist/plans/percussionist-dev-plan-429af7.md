# Plan: task review record improvements (`percussionist-dev-plan-429af7`)

## Context

- Review verdicts are currently written on the **review Run** annotation `percussionist.dev/review-verdict`, but Task-level state is lossy:
  - `getReviewVerdict()` in `packages/manager-controller/src/reconciler/observations.ts` parses only `{ action, feedback }` and drops `diagnosis`.
  - `decideReviewing()` in `packages/manager-controller/src/reconciler/decision.ts` writes only `worker.reviewApproved` and `worker.reviewFeedback`, overwriting each cycle.
  - `Task.status` in `packages/api/src/index.ts` has no structured review history field, timestamp, or per-attempt record.
- UI today (`packages/web/src/client/components/board/TaskDetailPanel.tsx`) shows only:
  - an at-a-glance `Agent review: approved/rejected` based on `worker.reviewApproved`
  - the latest `worker.reviewFeedback`
  - a link to reviewer run.
- Existing decision tests in `packages/manager-controller/src/reconciler/__tests__/decision.test.ts` already cover `approve`/`request_changes` branches, and one fixture includes `diagnosis` in the annotation payload.

## Scope boundaries

In scope:
- Add Task-scoped append-only `status.reviews[]` records.
- Preserve existing `worker.reviewApproved` / `worker.reviewFeedback` behavior unchanged for backward compatibility.
- Regenerate Task CRD from Zod schema.
- Extend board task detail UI with review history.
- Add/adjust unit tests for parser + decision behavior.

Out of scope:
- Any Run CR status schema changes.
- New board columns/badges outside Task detail review history.
- Replacing legacy `worker.reviewApproved`/`reviewFeedback` summary fields.

## Approach

1. **Model-first change in API schema**
   - Introduce `ReviewRecordSchema` and `ReviewRecord` type in `packages/api/src/index.ts` near worker status declarations.
   - Add `reviews: ReviewRecordSchema.array().optional()` to `TaskStatusSchema`.
   - Keep optional fields for forward/backward compatibility with existing Task objects.

2. **Preserve verdict fidelity from observation to decision**
   - Update `getReviewVerdict()` return shape in `observations.ts` to include optional `diagnosis` so annotation payload is not truncated.

3. **Append-only review history in `decideReviewing()`**
   - In all verdict-handling branches (`approve`, `request_changes` under ceiling, and `request_changes` above ceiling), append one `ReviewRecord` object to `task.status?.reviews` instead of replacing prior history.
   - Record fields:
     - `action`: map from verdict (`approve`/`request_changes`) and use `escalate` when auto-rework ceiling is exceeded.
     - `diagnosis`, `feedback`: passthrough from parsed verdict.
     - `reviewRunName`: from current worker state.
     - `reviewedAt`: `now` already available in input.
     - `attempt`: `(task.status?.worker?.retryCount ?? 0) + (task.status?.worker?.aiReworkCount ?? 0)` at review time.
   - Keep existing worker convenience writes untouched to avoid breaking current UI and downstream logic.

4. **CRD regeneration**
   - Run `pnpm codegen` so `k8s/crds/task.yaml` gets the `status.reviews[]` schema generated from Zod.

5. **UI enhancement with backward-compatible summary**
   - In `TaskDetailPanel.tsx`, keep current `MetaRow` summary and feedback block.
   - Add a new **Review history** section after the current feedback block, iterating `task.status?.reviews` and rendering:
     - action badge (approve=success style, request_changes/escalate=failed style)
     - reviewed timestamp
     - diagnosis text when present
     - feedback text when present
     - run link when `reviewRunName` exists (reuse existing run link style).

6. **Tests to lock behavior**
   - Extend `decision.test.ts` reviewing-suite assertions to validate `statusPatch.reviews` for approve/request_changes/ceiling branches.
   - Add a dedicated accumulation test where `task.status.reviews` already has one record and new decision appends to length 2.
   - Add an observations unit test file for `getReviewVerdict()` parsing, including diagnosis passthrough and malformed JSON fallback.

## Tasks (implementation breakdown)

1. **Add review record schema/type in API package**
   - File: `packages/api/src/index.ts`
   - Add `ReviewRecordSchema` + `ReviewRecord` type.
   - Wire `TaskStatusSchema.reviews` optional array.

2. **Pass diagnosis through verdict parsing**
   - File: `packages/manager-controller/src/reconciler/observations.ts`
   - Update `getReviewVerdict()` return type/cast to include `diagnosis?: string`.

3. **Append review records in decision logic (approve path)**
   - File: `packages/manager-controller/src/reconciler/decision.ts`
   - In `verdict.action === "approve"` branch, add `reviews` append entry while preserving worker summary fields.

4. **Append review records in decision logic (request changes under ceiling)**
   - File: `packages/manager-controller/src/reconciler/decision.ts`
   - In `request_changes` branch before ceiling exceeded, append `action: "request_changes"` record.

5. **Append review records in decision logic (ceiling reached escalation)**
   - File: `packages/manager-controller/src/reconciler/decision.ts`
   - In `aiCount > ceiling` branch, append `action: "escalate"` record and keep existing ceiling feedback behavior.

6. **Regenerate CRDs from schema**
   - Command: `pnpm codegen`
   - Expected changed file: `k8s/crds/task.yaml` (and only codegen outputs tied to schema changes).

7. **Add/expand decision tests for review history records**
   - File: `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
   - Assert appended `statusPatch.reviews` content includes action, diagnosis (if provided), and `reviewedAt`.
   - Add accumulation test for pre-existing `task.status.reviews`.

8. **Add observations test for diagnosis passthrough**
   - New/updated test file under `packages/manager-controller/src/reconciler/__tests__/` (e.g. `observations.test.ts`).
   - Validate `getReviewVerdict()` returns `diagnosis` when present.

9. **Render review history in task detail UI**
   - File: `packages/web/src/client/components/board/TaskDetailPanel.tsx`
   - Add section below existing review feedback with per-record action/time/diagnosis/feedback/run link.
   - Keep current summary `MetaRow` and current single feedback block.

10. **Validation gates**
    - Run `pnpm typecheck`.
    - Run `pnpm test`.
    - Confirm no unrelated diffs.

## Acceptance criteria

- `Task.status.reviews` exists in API schema and generated CRD (`k8s/crds/task.yaml`) as an optional array of structured records.
- A review verdict with `diagnosis` in run annotations is preserved by `getReviewVerdict()` and reaches decision logic.
- Each review cycle appends one record to `statusPatch.reviews` (no overwrite), including `reviewedAt`; existing records remain intact.
- Auto-rework ceiling path records an escalation entry while keeping current worker feedback semantics.
- Task detail overview renders a Review history list from `task.status.reviews` while preserving current at-a-glance review summary.
- Unit tests cover diagnosis passthrough + append/accumulation semantics.
- `pnpm typecheck` and `pnpm test` pass.

## Risks / open questions

- **Action mapping for ceiling case**: design introduces `escalate` while raw verdict is `request_changes`; implementation should explicitly map ceiling branch to `escalate` and document this in tests to avoid ambiguity.
- **Patch growth over long-lived tasks**: append-only history increases Task status size; expected volume is bounded by retry/rework ceilings, but worth monitoring for unusually long manual cycles.
- **UI styling consistency**: action badge colors should reuse existing semantic classes to avoid introducing inconsistent status visuals.
- **No optimistic concurrency in array append**: reconciler is effectively single-writer per task cycle, but append logic should stay deterministic based on observed `task.status.reviews` snapshot.

## Proposed BUILD task breakdown

1. **BUILD A — API + CRD contract**
   - Implement `ReviewRecordSchema`, wire `TaskStatusSchema.reviews`, regenerate CRDs.
   - Acceptance: API types compile and `k8s/crds/task.yaml` contains new reviews schema.

2. **BUILD B — Reconciler verdict plumbing + append logic + tests**
   - Update `getReviewVerdict()`, `decideReviewing()` append behavior, and manager-controller unit tests (decision + observations).
   - Acceptance: reviewing branches append correctly; diagnosis retained.

3. **BUILD C — Web task detail history rendering**
   - Add Review history section in `TaskDetailPanel.tsx` with action/time/diagnosis/feedback/run link.
   - Acceptance: existing summary remains; history renders when records exist.
