# Plan: Add CTA colors to board "Add Task" button and AddTaskForm "Add" button

**Task ID:** `percussionist-dev-plan-8e0994`
**Area:** `@percussionist/web` client (board view UI)
**Status:** Ready for BUILD

## Context

Two add-task entry points on the project board currently render in the muted
`secondary` button style, so they don't read as call-to-action elements:

1. **Board header "Add Task" button** — `packages/web/src/client/components/board/BoardHeader.tsx`:
   - Desktop (line 201): `<Button onClick={onAddTask} variant="secondary" size="sm">`
   - Mobile (line 104): `<Button onClick={onAddTask} variant="secondary" size="sm" className="gap-1">`
   - Both toggle their label to `Cancel` when `showAddTask` is true.
2. **AddTaskForm "Add" submit button** — `packages/web/src/client/components/board/AddTaskForm.tsx`
   (line 125): `<Button onClick={...} disabled={addMutation.isPending}>` — no `variant`
   prop, so it resolves to the `secondary` default via `defaultVariants` in
   `packages/web/src/client/components/ui/button.tsx` (line 27–30).

The `Button` component already ships a primary CTA look — the `default` variant
(`ui/button.tsx` line 11): `bg-accent text-surface hover:bg-accent/80`, using the
amber/gold `--accent: #e8a852` token from `index.css` (`:root`, line 249). That is
the established "primary action" style across the app (e.g. SettingsPage "Upgrade"
button at `SettingsPage.tsx` line 910, the floating chat panel button in
`AgentChatPanel.tsx` line 432). Contrast is strong (`#e8a852` on `#111317` surface),
and the app is dark-theme-only (single `:root` palette in `index.css`).

Relevant tests assert only on visible text, never on button variant/color:
- `packages/web/tests/board-header.test.tsx` (lines 114–117, 212–214, 232–235,
  275–282) queries `screen.getByText('+ Add Task')` / `Cancel` and the Plus icon.
- `packages/web/tests/board-view.test.tsx` mocks `AddTaskForm` entirely (line 138).

So switching variants is behavior-neutral for the test suite.

## Approach

Make both add-task CTAs use the `default` (accent) variant, following the exact
toggle pattern already established for the Findings button in the same file
(`BoardHeader.tsx` line 95 / 194: `variant={showFindings ? 'default' : 'secondary'}`):

1. **BoardHeader.tsx** — change both `variant="secondary"` Add Task buttons to
   `variant={showAddTask ? 'secondary' : 'default'}`. Rationale: when the form is
   open the same button becomes a `Cancel` (exit) action, so it reverts to the
   muted secondary style; when it is the actual "add" affordance it glows accent.
   This mirrors the Findings toggle precedent and avoids two competing amber
   buttons in the header when the form is open.
2. **AddTaskForm.tsx** — add `variant="default"` to the submit `<Button>` (line
   125). The adjacent `Cancel` text button stays untouched.

No other files change. No new tokens, no CSS edits, no server/API changes — this
is a pure presentation change. No test updates expected (verify with `pnpm test`
for the web package and `pnpm typecheck`).

## Scope boundaries

- In scope: the two board add-task entry points above (desktop + mobile header
  buttons; the form's submit button in both its inline and mobile-Sheet usage —
  `AddTaskForm` is shared, so one edit covers all render sites).
- Out of scope: the small "+" ideas-column icon button in
  `TaskListPanel.tsx` (lines 170–186) — an inline affordance, not a CTA label.
- Out of scope: findings button styling, other forms (CreateRunForm,
  CreateProjectForm), light-theme tokens, button component changes.

## Tasks (BUILD breakdown)

1. **BUILD: apply CTA variants to board add-task buttons**
   - `packages/web/src/client/components/board/BoardHeader.tsx` line 104 (mobile):
     `variant="secondary"` → `variant={showAddTask ? 'secondary' : 'default'}`.
   - Same file line 201 (desktop): `variant="secondary"` →
     `variant={showAddTask ? 'secondary' : 'default'}`.
   - `packages/web/src/client/components/board/AddTaskForm.tsx` line 125: add
     `variant="default"` to the submit `<Button>` (keep `disabled` logic as-is).
2. **Verify**
   - `pnpm typecheck` (root) passes.
   - `pnpm test` (web package, `--isolate`) passes — confirm
     `board-header.test.tsx` and `board-view.test.tsx` unaffected.
   - Manual smoke (optional, requires cluster): board shows amber "+ Add Task"
     in the header; opening it shows amber "Add" in the form and the header
     button reverts to secondary "Cancel".

## Risks / open questions

- **Design judgment:** reverting the header button to `secondary` in the open
  (Cancel) state is a deliberate choice consistent with the Findings button
  precedent. If reviewers prefer a persistent accent even when labeled Cancel,
  the change is a one-line simplification (`variant="default"` unconditionally).
- **Low risk of test breakage:** existing tests assert on text/icon only; no
  class-based assertions found. `board-header.test.tsx` does not assert variants.
- **No contrast concern:** `--accent` (#e8a852) on `--surface` (#111317) already
  used elsewhere as primary CTA; contrast ratio is high.
- **No accessibility impact:** button semantics, focus-visible ring, and disabled
  opacity (`disabled:opacity-40`) come from `buttonVariants` base classes and are
  unchanged.

## Acceptance criteria

- The board header "Add Task" button (desktop and mobile) renders with the
  accent CTA color when the form is closed, and reverts to secondary when it
  shows "Cancel" with the form open.
- The AddTaskForm "Add" button renders with the accent CTA color in both the
  desktop inline form and the mobile bottom sheet.
- `pnpm typecheck` and the web test suite pass with no test modifications.
- No other buttons or components change appearance.
