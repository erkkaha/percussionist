# Plan: Diff impact ranking and line-level review comments (revised)

## Context

Current code already has the right end-to-end transport for review metadata, but it is text-only today:

- Diff API/UI path:
  - `GET /api/projects/:project/tasks/:taskName/diff` in `packages/web/src/server/routes/task-diff.ts` returns `defaultRef`, `baseRef`, `headRef`, `files[]`, optional `commits[]`, `reason`.
  - UI consumes it in `packages/web/src/client/components/board/TaskDetailPanel.tsx` (`DiffContent`) and renders files with `packages/web/src/client/components/FileDiff.tsx`.
- Review verdict path:
  - `complete_review` tool in `packages/dispatcher/src/mcp-server.ts` writes JSON to run annotation `percussionist.dev/review-verdict`.
  - Manager reads it in `packages/manager-controller/src/reconciler/observations.ts:getReviewVerdict()` and applies results in `packages/manager-controller/src/reconciler/decision.ts`.
  - Task-level persistent review state is `Task.status.worker.reviewFeedback` + append-only `Task.status.reviews` (schema in `packages/api/src/index.ts`).
- Human request-changes path remains plain text via annotations in `packages/web/src/server/routes/board.ts` and textarea UI in `TaskDetailPanel.tsx`.

Key implication: v1 should extend the existing **reviewer verdict → run annotation → reconciler → Task.status → UI** pipeline rather than creating a new storage system.

---

## Scope boundaries

### In scope (v1)

1. Structured reviewer findings with severity rank + file/line anchors persisted in `Task.status`.
2. Deterministic diff identity context (`baseSha`, `headSha`, `forkSha`, `diffFingerprint`) added to diff API and used for staleness checks.
3. Diff API returns normalized findings with active/stale mapping against current diff context.
4. Diff UI supports ranking/filtering + inline line markers/widgets.
5. Rework helper can seed existing feedback textarea from top findings (client-side only).

### Explicitly out of scope (v1)

1. Builder-authored findings transport/write path.
2. Threaded comment system (replies, edits, resolve workflow).
3. Real-time collaboration/comment syncing.
4. Fuzzy anchor remapping across rebases (v1 marks stale, does not remap).

---

## Approach

### 1) Canonical storage in Task status with strict bounded schema

Add a new typed field under `TaskStatusSchema` in `packages/api/src/index.ts` (e.g. `diffFindings`) containing reviewer findings. Keep this small and deterministic.

Proposed hard caps (enforced in Zod and respected before annotation write):

- `items.max(25)`
- `anchors.max(3)` per finding
- `title.max(160)`
- `comment.max(2000)`
- `category.max(64)`
- `hunkHeader.max(256)`

Rationale: Task CR status and run annotations are finite; bounded data avoids oversized patches and annotation failures.

### 2) Make resolved SHAs + fingerprint required for reliable anchors

`baseRef/headRef` are often branch names and can move. Diff identity must be commit-based:

- Extend `task-diff` route (`packages/web/src/server/routes/task-diff.ts`) to compute and return:
  - `baseSha`
  - `headSha`
  - `forkSha`
  - `diffFingerprint` (deterministic hash of fork/head/file patch identity)
- Findings are anchored to these resolved values, not mutable refs.

### 3) Keep run annotation as transport, but cap before writing

Continue using `complete_review` in `packages/dispatcher/src/mcp-server.ts` as the ingress path, extending input with optional `findings`.

Important guardrail: enforce count/length limits **in dispatcher before writing** `percussionist.dev/review-verdict` so annotation size stays safe. If over limit, truncate/drop extra findings and preserve core verdict (`approved/diagnosis/feedback`).

### 4) Centralize validation/normalization in API package

Today `getReviewVerdict()` blindly parses JSON in `observations.ts`. Replace with shared parse/normalize helpers in `@percussionist/api` used by both dispatcher and manager:

- Parse verdict JSON with Zod.
- Normalize findings (trim, dedupe IDs, clamp scores, enforce caps).
- Drop invalid findings while preserving valid diagnosis/feedback/action.

This ensures identical behavior at producer and consumer boundaries.

### 5) Reviewer replacement semantics (explicit rule)

For v1:

- Findings from the **latest review run** replace previous reviewer findings for that task.
- Human-entered request-changes feedback remains separate/plain text and is preserved.
- Builder findings are not implemented in v1 (no merge-semantics complexity).

### 6) UI line mapping requires custom diff rendering

`FileDiff.tsx` currently renders default `<Hunk />` output from `react-diff-view` with no line-level widgets. Implement explicit mapping from finding anchors to `change.oldLineNumber/newLineNumber` and render decorations/widgets for matched lines.

Stale anchors should be shown in findings panel as stale/unmapped (not silently dropped).

---

## Proposed data model (v1)

Add schemas in `packages/api/src/index.ts`:

- `DiffFindingSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"])`
- `DiffLineAnchorSchema`:
  - `path: string`
  - `side: "old" | "new"`
  - `line: int >= 1`
  - `endLine?: int >= line`
  - `hunkHeader?: string (max 256)`
- `DiffContextSchema` (**required** on finding set and each finding anchor context):
  - `baseSha: string`
  - `headSha: string`
  - `forkSha: string`
  - `diffFingerprint: string`
- `DiffFindingSchema`:
  - `id: string`
  - `source: "reviewer"` (v1)
  - `severity`
  - `score?: number (0..100)`
  - `title: string (max 160)`
  - `comment: string (max 2000)`
  - `category?: string (max 64)`
  - `anchors: DiffLineAnchor[]` (1..3)
  - `context: DiffContextSchema`
  - `createdAt: string`
  - `authorRunName?: string`
- `TaskDiffFindingsSchema` in `TaskStatusSchema`:
  - `version: 1`
  - `context: DiffContextSchema` (the context for this stored reviewer batch)
  - `items: DiffFinding[]` (max 25)
  - `updatedAt: string`
  - `sourceRunName: string`

Also add frontend types in `packages/web/src/client/lib/types.ts` and extend `TaskDiffResponse` accordingly.

---

## Implementation tasks

1. **API schema + shared normalization helpers**
   - Update `packages/api/src/index.ts` with findings/context schemas and `TaskStatusSchema.diffFindings`.
   - Add exported parse/normalize helpers for review verdict payloads in `@percussionist/api` (new module or same package file organization).
   - Enforce the exact caps listed above.
   - Regenerate CRDs via `pnpm codegen`.

2. **Dispatcher `complete_review` contract + pre-write guardrails**
   - Extend `TOOL_COMPLETE_REVIEW` input schema in `packages/dispatcher/src/mcp-server.ts` with optional `findings`.
   - Normalize + cap verdict/findings before `patchRunAnnotations()`.
   - Ensure overflow/invalid findings do not fail the tool; core verdict still writes.
   - Keep backward compatibility for existing callers that only send approved/diagnosis/feedback.

3. **Manager verdict parsing and persistence**
   - Replace ad-hoc JSON parse in `packages/manager-controller/src/reconciler/observations.ts:getReviewVerdict()` with shared API normalizer.
   - In `packages/manager-controller/src/reconciler/decision.ts`, apply replacement semantics:
     - append to `reviews[]` as today,
     - replace reviewer `diffFindings` with latest normalized reviewer batch.
   - Preserve existing behavior when findings are absent/invalid.

4. **Diff API context upgrade**
   - In `packages/web/src/server/routes/task-diff.ts`, resolve and return `baseSha/headSha/forkSha/diffFingerprint` alongside existing refs.
   - Attach task findings to response and compute per-finding `isActive` vs `isStale` by context match.
   - Return stable sorted order (severity desc, score desc, path, line) or clearly document client-side sort contract.

5. **Client contracts and fetch layer**
   - Update `packages/web/src/client/lib/types.ts` for new diff context/findings response shape.
   - Keep `fetchTaskDiff()` (`packages/web/src/client/lib/api.ts`) and `useTaskDiff()` mostly unchanged except typing.

6. **Diff UI: rankings panel + inline markers/widgets**
   - In `packages/web/src/client/components/board/TaskDetailPanel.tsx` (`DiffContent`):
     - add findings summary panel (counts by severity, filters, sort controls, stale toggle).
   - In `packages/web/src/client/components/FileDiff.tsx`:
     - map anchors to parsed diff line numbers (`oldLineNumber/newLineNumber`),
     - render line decorations/widgets and per-file finding badges,
     - show stale/unmapped findings in a non-inline section.

7. **Rework helper (client-side only)**
   - In `TaskDetailPanel.tsx`, add an action near request-changes textarea to insert top findings into existing feedback text.
   - No new backend endpoint; continue using `POST .../request-changes` in `packages/web/src/server/routes/board.ts`.

8. **Reviewer prompt updates**
   - Update `packages/manager-controller/src/facilitator.ts` reviewer prompt to instruct `complete_review` with structured `findings` payload.
   - Include concise schema expectations and cap guidance in prompt to reduce malformed payloads.

9. **Tests**
   - Manager reconciler tests:
     - `packages/manager-controller/src/reconciler/__tests__/observations.test.ts`
     - `packages/manager-controller/src/reconciler/__tests__/decision.test.ts`
     - add cases for normalization, invalid finding drop, replacement semantics.
   - Web route tests:
     - add/extend tests under `packages/web/tests/` for diff route response including sha/fingerprint + findings active/stale mapping.
   - Auth tests:
     - keep/extend `packages/web/tests/auth.test.ts` coverage for diff endpoint as needed.
   - (Optional if already available in harness) deterministic E2E validating reviewer findings appear in task status and diff UI payload.

---

## Acceptance criteria

1. `Task.status` includes typed, bounded structured diff findings schema with required commit-based context.
2. `complete_review` accepts structured findings and safely writes bounded verdict annotations.
3. Manager uses shared validation/normalization and persists latest reviewer findings with explicit replacement semantics.
4. Diff API returns resolved refs (`baseRef/headRef`) plus required SHAs (`baseSha/headSha/forkSha`) and `diffFingerprint`.
5. Diff API returns findings with active/stale status against current diff context.
6. Diff UI can rank/filter findings and render line-level markers by anchor mapping.
7. Request-changes UI can seed feedback from selected/top findings without backend changes.
8. Existing flows remain functional when no findings are supplied.

---

## Proposed BUILD task breakdown

1. **BUILD A — Schema + review plumbing**
   - API schemas, shared normalizer, dispatcher `complete_review` findings support + hard caps, manager parsing/persistence, unit tests.

2. **BUILD B — Diff API context**
   - Resolved sha/fingerprint fields in `task-diff`, findings projection with active/stale mapping, route tests.

3. **BUILD C — Diff UI**
   - Findings panel, severity sorting/filtering, per-file counts, inline line widgets/markers with stale handling.

4. **BUILD D — Rework helper + prompts + E2E**
   - Client-side feedback seeding, reviewer prompt updates, deterministic end-to-end coverage.

---

## Risks / open questions

1. **Annotation budget risk**
   - Even bounded findings may approach annotation limits depending on diagnosis/feedback size; we need explicit truncation strategy and telemetry/logging for dropped findings.

2. **Fingerprint design stability**
   - Must choose a deterministic, cheap fingerprint formula that is stable for same diff content but changes reliably when patch context changes.

3. **Line anchor mismatch edge cases**
   - Renames/binary patches/empty hunks can limit line-level mapping; UI should degrade gracefully to file-level listing.

4. **Prompt adherence variance**
   - Reviewer agents may still emit malformed findings; parser must harden and preserve core verdict outcome.

5. **Future human comments model**
   - v1 intentionally avoids human line-comment persistence; follow-up design should decide whether human comments live in Task.status or separate CR/storage.

## Assumptions

1. v1 only supports reviewer-originated structured findings.
2. Latest reviewer run is authoritative for reviewer findings on a task.
3. No additional server API is needed for rework helper; existing request-changes endpoint remains unchanged.
