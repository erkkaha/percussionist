# Plan: board chat context button visible only on hover on tablets

**Task ID:** `percussionist-dev-plan-8b8e57`
**Area:** `@percussionist/web` client (board view)
**Status:** Ready for BUILD

## Context

The board's chat-context button — "Inject task into chat" (`MessageSquarePlus` icon) — lives in
`packages/web/src/client/components/board/TaskRow.tsx` (lines 197–211). It calls
`useChat().injectTask(task, projectName)` from `client/lib/chat-context.tsx`, which is wired through
`App.tsx` → `AgentChatPanel` to prefill the chat panel with the task.

Its current className (line 204):

```
opacity-70 group-hover:opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded text-text-dim hover:text-accent md:opacity-0 md:group-hover:opacity-60 md:hover:opacity-100
```

Intent of the original CSS:

- **Below `md` (< 768px, phones):** button always visible at 70% opacity (no hover affordance exists).
- **At `md`+ (≥ 768px):** button hidden (`md:opacity-0`) until the row is hovered
  (`md:group-hover:opacity-60`) or the button itself is hovered (`md:hover:opacity-100`).

**The bug:** tablets are ≥ 768px wide (iPad portrait = 768px, iPad landscape = 1024px, common Android
tablets 800px+), so the `md:opacity-0` branch applies to them. Tablets have no hover — the primary
input is touch and `:hover` never fires — so the button is invisible and effectively unusable. Users
can't even discover it to tap it.

**Relevant stack facts:**

- Tailwind v4.3.3 (`@tailwindcss/vite`), CSS entry `packages/web/src/client/index.css` already uses
  `@custom-variant dark (&:is(.dark *));` (line 4), so the custom-variant mechanism is established.
- Tailwind v4 has built-in `pointer-coarse` / `pointer-fine` variants, but no built-in variant for
  `@media (hover: hover)` (hover *capability*, as opposed to pointer *type*).
- No existing tests cover `TaskRow` (board-view.test.tsx renders empty column mocks).

## Approach

Gate the hide-until-hover behavior on **hover capability** rather than viewport width, using the CSS
feature query `@media (hover: hover)` — the precise, MDN-recommended test for "the primary input
mechanism can hover." Implement it as a custom Tailwind variant `hover-capable` in `index.css` and
prefix the three `md:` visibility classes in `TaskRow.tsx` with it.

### Why `hover: hover` and not `pointer-coarse`

- `pointer-coarse` tests the accuracy of the primary pointing device, not hover capability. It is the
  wrong axis: a device can report `pointer: fine` while having no hover (pen-only kiosks, some
  remote/embedded setups), and the hide-until-hover pattern would still break there.
- `(hover: hover)` asks exactly the right question: "can this user actually hover?" If yes, the
  reveal-on-hover affordance works; if no, keep the button always visible.
- Hybrid touch-laptops (e.g., Surface with trackpad) report `(hover: hover)` because the primary
  input is a mouse/trackpad — correct behavior: they *can* hover, so the button hides until hover.

### Desired behavior matrix after the fix

| Device / input | Width | Today | After fix |
|---|---|---|---|
| Phone (touch) | < 768px | visible @ 70% | visible @ 70% (unchanged) |
| **Tablet (touch)** | **≥ 768px** | **invisible (bug)** | **visible @ 70%, tappable** |
| Desktop (mouse) | ≥ 768px | hidden until hover | hidden until hover (unchanged) |
| Narrow desktop window (mouse) | < 768px | visible @ 70% | visible @ 70% (unchanged) |
| Touch-laptop (trackpad primary) | ≥ 768px | hidden until hover | hidden until hover (unchanged; mouse hover works) |

The change surface is intentionally minimal: only touch-capable devices at ≥ 768px change behavior.

## Tasks

1. **Add the `hover-capable` custom variant to `packages/web/src/client/index.css`.**
   Place it next to the existing `@custom-variant dark` (line 4):

   ```css
   @custom-variant hover-capable (@media (hover: hover));
   ```

   If the one-line shorthand form does not compile in 4.3.3, use the block form instead:

   ```css
   @custom-variant hover-capable {
     @media (hover: hover) {
       @slot;
     }
   }
   ```

   Verify early (before touching TaskRow) that `hover-capable:opacity-0` on a scratch element
   compiles to `@media (hover: hover) { ... opacity: 0 }` (run `pnpm build:client` in `packages/web`).

2. **Gate the hide-until-hover classes in `packages/web/src/client/components/board/TaskRow.tsx` (line 204).**
   Prefix the three `md:` visibility utilities with `hover-capable:`; leave all base classes unchanged:

   ```
   before: opacity-70 group-hover:opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded text-text-dim hover:text-accent md:opacity-0 md:group-hover:opacity-60 md:hover:opacity-100
   after:  opacity-70 group-hover:opacity-60 hover:opacity-100 transition-opacity p-0.5 rounded text-text-dim hover:text-accent hover-capable:md:opacity-0 hover-capable:md:group-hover:opacity-60 hover-capable:md:hover:opacity-100
   ```

   No JSX/logic changes — the button, its `title`/`aria-label`, and the `injectTask` call stay as-is.

3. **(Recommended, small) Add keyboard-focus visibility for the same button.**
   Today the button is `opacity-0` but still tab-focusable on desktop; a keyboard user tabbing to it
   cannot see it because there is no focus style. Add `focus-visible:opacity-100` (ungated) to the
   className so it becomes visible on keyboard focus on every device. If reviewers want to keep the
   change strictly scoped to the tablet bug, this step can be dropped — note it is a 3-token a11y fix
   on the same element.

4. **Add a regression test: `packages/web/tests/task-row.test.tsx` (new file).**
   Following the web suite discipline (`--isolate`, fresh file, minimal mocks — do NOT mock
   `react-router-dom` or `@tanstack/react-query`):
   - Render `TaskRow` with a stub `Task` (see `client/lib/types.ts` for the shape) wrapped in a
     `ChatContext.Provider` whose `injectTask` is a `mock()` spy.
   - Assert the button is present: `screen.getByRole('button', { name: 'Inject task into chat' })`.
   - Assert clicking it calls `injectTask` with the task and project name (behavioral regression).
   - Assert its className contains `hover-capable:md:opacity-0` and does NOT contain a bare
     `md:opacity-0` occurrence (wiring regression guard — happy-dom cannot evaluate media queries,
     so this asserts the class wiring that produces the tablet fix).
   - Note in a comment why the class-level assertion exists (CSS media queries are not evaluated in
     happy-dom; visual verification is manual / devtools).

5. **Verify.**
   - `pnpm typecheck` and `pnpm test` from repo root (web suite runs with `--isolate`).
   - `pnpm lint` (Biome) and `pnpm format` if needed.
   - `pnpm build:client` in `packages/web` (confirms the new variant compiles through Tailwind/Vite).
   - Manual (human or agent with devtools): device emulation with an iPad/tablet viewport + touch
     emulation → button visible at 70% opacity per row, tappable, and chat panel prefills; desktop
     viewport → button still hidden until row/button hover.

## Scope boundaries

- **In scope:** the "Inject task into chat" button in `TaskRow.tsx` only. This is the only
  board chat-context button (verified: `injectTask` is consumed solely there; the `MessageSquare`
  icon in `TaskEventsPanel.tsx` is a non-interactive event badge).
- **Out of scope:** other hover-only affordances in the board (e.g., `TaskListPanel.tsx` line 161
  `group-hover:text-text` color shifts — cosmetic, not a usability blocker); general touch-target
  sizing; the sidebar's `md:opacity-0` pattern (`ui/sidebar.tsx` line 619) — if that proves to be a
  similar tablet issue it should be a separate task.
- No server/API/type changes; CSS-only + one test file.

## Acceptance criteria

1. On a ≥ 768px touch device (tablet), the "Inject task into chat" button is visible in every task
   row without any hover, is tappable, and injects the task into the chat panel.
2. On a desktop with a mouse, behavior is unchanged: the button is hidden until the row or button is
   hovered.
3. On phones (< 768px), behavior is unchanged (always visible at 70%).
4. `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build:client` all pass.
5. New regression test (Task 4) passes and guards the class wiring.

## Risks / open questions

- **`@custom-variant` shorthand syntax with media queries:** the one-line form
  `@custom-variant hover-capable (@media (hover: hover));` is the documented v4 syntax, but if it
  errors in 4.3.3, fall back to the `@slot` block form (Task 1 covers both). Verify before Task 2.
- **Cascade order:** `hover-capable:md:opacity-0` and `opacity-70` are both single-class opacity
  utilities; variant-gated utilities are emitted after base utilities, and
  `hover-capable:md:group-hover:opacity-60` has higher specificity than `.opacity-70` — the same
  mechanism the current `md:opacity-0` relies on, so no cascade regression is expected. Confirm in
  the built CSS during verification.
- **Sticky `:hover` on touch:** after tapping a row, some mobile browsers emulate `:hover` and keep
  it sticky, which can dim the button to 60% (`group-hover:opacity-60`) after tap. This is
  pre-existing phone behavior and does not hide the button; acceptable.
- **Keyboard visibility (Task 3):** optional scope; if dropped, the pre-existing "invisible on
  keyboard focus at desktop widths" a11y gap remains — worth a follow-up task at most, not a blocker.

## Proposed BUILD task breakdown

One BUILD task is appropriate — the change is a single CSS variant + one className edit + one test:

- **BUILD 1 — Fix hover-only visibility of board chat context button on tablets**
  - Implement Tasks 1, 2, 4, 5 (and Task 3 if reviewers accept the optional focus-visible class).
  - Acceptance: criteria 1–5 above; deterministic verification is `pnpm test` + `pnpm build:client`
    (visual tablet behavior requires manual/devtools check).
  - If reviewers prefer the focus-visible a11y fix reviewed separately, split Task 3 into its own
    tiny BUILD with `predecessorRef` pointing at BUILD 1.
