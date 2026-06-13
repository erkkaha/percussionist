# Plan: Task View Review UI Polish

**Task:** percussionist-dev-plan-a11d1d  
**Project:** percussionist-dev  
**Goal:** Polish review-related UI in the task detail view so approved reviews do not look like failures, and show review metadata (next to branch info) as styled labels/badges instead of plain text.

---

## Context

The reported issues map to `packages/web/src/client/components/board/TaskDetailPanel.tsx`:

1. **Agent review feedback is always styled as failure-red**
   - In `OverviewContent`, the “Agent Review Feedback” block renders with:
     - `text-phase-failed/80` (line ~418)
   - This makes feedback look negative even when `worker.reviewApproved === true`.

2. **Agent review status and branch metadata use plain text meta rows**
   - Metadata grid currently renders:
     - `MetaRow label="Branch" value={worker.gitBranch}`
     - `MetaRow label="Agent review" value={'approved'|'rejected'}`
   - `MetaRow` outputs a simple truncated `<p>` text value.
   - User request asks for cleaner labels similar to the **Review History** chips.

3. **A better visual pattern already exists in the same file**
   - Review History items (`task.status.reviews`) already use semantic chips with icon + border/background color classes:
     - approved → `text-phase-succeeded ...`
     - request changes / escalate → non-green variants
   - This should be reused/aligned for consistency.

Related schemas confirm available fields:
- `packages/api/src/index.ts` (`WorkerStatusSchema`): `reviewApproved`, `reviewFeedback`, `gitBranch`, `reviewRunName`.

---

## Scope Boundaries

### In Scope
- UI polish for task detail view review metadata and feedback styling in:
  - `packages/web/src/client/components/board/TaskDetailPanel.tsx`
- Minor helper component extraction/refactor within this file (or nearby UI helper) if needed for maintainability.

### Out of Scope
- Changes to manager/controller review semantics or API payloads.
- Changing review history data model (`Task.status.reviews`).
- Broad board-wide redesign outside the task detail panel.

---

## Approach

1. **Make review feedback semantic instead of always-failed**
   - Derive visual tone from `worker.reviewApproved` when available:
     - `true` → success-ish text treatment
     - `false` → failure-ish treatment
     - `undefined` → neutral muted treatment (fallback for partial data)

2. **Replace plain text review/branch values with chip-style labels**
   - Keep metadata labels (“Branch”, “Agent review”), but render values as compact badges/chips.
   - Match existing “Review History” visual language (rounded pill, icon + text, semantic color).

3. **Use existing style conventions**
   - Prefer existing phase token classes (`phase-succeeded`, `phase-failed`, muted variants).
   - Avoid introducing new theme tokens unless absolutely necessary.

4. **Maintain readability and no-regression behavior**
   - Preserve current data visibility and ordering in the metadata grid.
   - Ensure long branch names remain readable (mono text + truncation or wrapping strategy aligned with current panel constraints).

---

## Tasks

1. **Audit current rendering points in `TaskDetailPanel.tsx`**
   - Identify exact JSX blocks for:
     - metadata “Branch” row
     - metadata “Agent review” row
     - “Agent Review Feedback” text color
   - Confirm where to inject a reusable badge-like value renderer.

2. **Introduce a small metadata-value badge helper**
   - Add a local helper/component for semantic meta values (e.g., chip with optional icon/className).
   - Keep API minimal so it can be used for both branch and review state.

3. **Polish “Agent review” metadata presentation**
   - Replace plain `MetaRow` value with chip-style status:
     - Approved: green/succeeded tone + check icon/text.
     - Rejected: failed/pending tone + X icon/text.
   - Ensure text casing and terminology align with Review History labels.

4. **Polish “Branch” metadata presentation**
   - Render branch as a styled label/chip (mono-friendly), not plain paragraph text.
   - Keep overflow handling stable in narrow panel widths.

5. **Make review feedback color state-aware**
   - Update feedback paragraph classes so approved reviews are not red.
   - Use fallback neutral styling when approval verdict is absent.

6. **Align with existing Review History visuals**
   - Compare the new chips against the existing `actionColor` styles in Review History section.
   - Normalize spacing/icon sizing to avoid visual mismatch.

7. **Run targeted verification**
   - Validate in browser (or story-like local run) for at least three states:
     - approved + feedback
     - rejected + feedback
     - feedback present but `reviewApproved` missing
   - Run `pnpm lint` (or package-local lint/typecheck flow used by repo) to catch style/type issues.

8. **Add/adjust lightweight UI test coverage if present nearby**
   - If existing tests cover TaskDetailPanel, add assertions for class/label behavior.
   - If no nearby tests exist, document manual verification in PR/task notes.

---

## Risks / Open Questions

1. **Exact color semantics for rejected status**
   - Should “rejected” use `phase-failed` (strong red) or `phase-pending` (warning amber) to match historical UI intent?

2. **Badge component reuse vs local helper**
   - There is a generic `ui/badge.tsx`, but its current variants are phase-oriented and uppercase/mono by default.
   - Decide whether to extend shared badge variants or keep task-detail-local classes for minimal blast radius.

3. **Feedback text color accessibility**
   - Ensure muted/success text on current background remains readable in all themes.

4. **Branch display behavior on long names**
   - Truncation may hide useful suffixes; consider tooltip if current UX is insufficient.

---

## Acceptance Criteria

- In task detail overview, approved review feedback is **not** shown in failure-red styling.
- “Agent review” next to branch metadata is displayed as a styled label/chip (not plain text).
- Branch value is displayed as a clean label/badge treatment (not plain text-only row value).
- New/updated styling is visually consistent with existing “Review History” status labels.
- No API/schema changes are required; UI compiles and passes lint/type checks.

---

## Proposed BUILD Task Breakdown

1. **BUILD A — Metadata label UI polish in TaskDetailPanel**
   - Implement chip-style rendering for Branch and Agent review metadata.
   - Keep layout and responsive behavior stable.

2. **BUILD B — Semantic review feedback styling update**
   - Make feedback color driven by `worker.reviewApproved` (approved/rejected/unknown).
   - Validate visual consistency with Review History chips.

3. **BUILD C — Verification and optional test adjustment**
   - Add/update UI assertions where feasible.
   - Run lint/typecheck and confirm no regressions in task detail rendering.
