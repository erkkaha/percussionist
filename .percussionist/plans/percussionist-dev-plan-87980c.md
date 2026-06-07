# Plan: Prevent manager chat FAB from obscuring board content on mobile

## Context

The manager chat trigger is rendered in `packages/web/src/client/components/AgentChatPanel.tsx` as a floating fixed button when chat is closed:

- `className="fixed bottom-4 right-4 z-50 w-12 h-12 ..."` (around line 300)
- The button is rendered globally from `Layout.tsx`, so it appears on all authenticated routes, including `/projects/:name/board`.

On mobile, board task content is shown in a single scrollable list (`TaskListPanel`) inside `BoardView`:

- `TaskListPanel` list container: `className="flex-1 overflow-y-auto px-2 pb-4 ..."`
- Current bottom padding (`pb-4`) is much smaller than the FAB footprint + offset.

Result: the FAB overlays bottom-right board items/timestamps/action icons, reducing readability and tap accessibility.

## Scope boundaries

### In scope
- Web client layout/styling changes in `packages/web/src/client/components/**` (and minimal CSS if needed) to prevent mobile board-content obstruction.
- Preserve existing chat behavior: floating closed trigger, full-screen panel on mobile when opened.
- Route-aware behavior is allowed (board-specific adjustment) if implemented cleanly.

### Out of scope
- Server/API changes under `packages/web/src/server/**`.
- Functional changes to manager chat request/stream logic.
- Broad redesign of board information architecture.

## Approach

Use a layered fix that prioritizes content accessibility without degrading discoverability of chat:

1. **Board-safe spacing (primary fix):** reserve enough bottom-right space in the board task scroller on mobile so content can scroll above the FAB rather than beneath it.
2. **Mobile-safe FAB positioning (hardening):** adjust mobile FAB offset/size and safe-area handling (`env(safe-area-inset-bottom/right)`) so it avoids OS gesture/nav areas and reduces overlap footprint.
3. **Optional route-aware tuning:** if global FAB offset hurts other pages, pass a lightweight route context so extra spacing is only applied on board pages.

This keeps UX familiar (still a persistent floating chat entrypoint) while ensuring board rows remain readable/tappable.

## Acceptance criteria

1. On mobile widths (`<768px`), no board task row content is permanently hidden under the chat button.
2. Users can scroll to and interact with the last task row and right-edge controls/text without FAB collision.
3. Chat trigger remains visible and easy to open when chat is closed.
4. Open chat behavior remains unchanged (mobile full-screen panel from `AgentChatPanel`, desktop side panel behavior intact).
5. No regressions on non-board pages from the spacing/positioning change.

## Tasks (implementation steps)

1. **Confirm and document overlap geometry in current UI**
   - Verify current dimensions/offsets in `AgentChatPanel.tsx` (`w-12 h-12 bottom-4 right-4`) and board scroller padding in `TaskListPanel.tsx` (`pb-4`).
   - Record required reserved space target (FAB size + offsets + small buffer).

2. **Introduce a shared mobile FAB spacing token/constant**
   - Add a single source for chat FAB footprint and offsets (component-level constant or CSS custom property) so board padding and FAB positioning stay in sync.
   - Avoid magic numbers duplicated across files.

3. **Add mobile-only bottom/right clearance in board task list**
   - Update `TaskListPanel.tsx` scroll container classes to include increased mobile bottom padding (and optionally right padding) sized to the FAB token.
   - Keep desktop spacing unchanged (`md:` overrides where needed).

4. **Harden FAB position for mobile safe areas**
   - Update the closed chat button in `AgentChatPanel.tsx` to use safe-area-aware offsets (e.g., `calc(1rem + env(safe-area-inset-bottom))`, right equivalent).
   - Optionally use slightly smaller mobile size (`w-10 h-10` or `w-11 h-11`) with existing desktop size retained via responsive classes.

5. **Validate z-index layering and interaction order**
   - Ensure FAB (`z-50`) still sits above board content when needed.
   - Ensure open mobile chat overlay (`z-[60]`) and close controls remain unaffected.

6. **Optional route-aware refinement (if needed after QA)**
   - If global FAB offsets are undesirable, pass a `fabContext`/`routeKind` signal from `Layout.tsx` or route-level wrapper so only board gets extra scroll clearance.
   - Keep prop surface minimal and backward compatible.

7. **Verification pass**
   - Manual checks on iPhone/Android-sized emulation and narrow desktop browser:
     - board list bottom rows (with/without many tasks),
     - interaction with task row action buttons,
     - chat open/close transitions.
   - Run `pnpm typecheck` to ensure no typing regressions from prop/class changes.

## Proposed BUILD task breakdown

1. **BUILD A — Mobile board clearance + FAB tokenization**
   - Implement shared spacing token and board mobile scroll padding changes.
   - Acceptance: board rows are fully reachable/visible behind no persistent obstruction.

2. **BUILD B — FAB mobile positioning hardening**
   - Implement safe-area-aware offsets and any responsive sizing adjustments in `AgentChatPanel.tsx`.
   - Acceptance: FAB remains discoverable and no longer crowds board content edges on common mobile viewports.

3. **BUILD C — QA + route-specific polish (conditional)**
   - Validate across board and non-board screens; add route-aware specialization only if required.
   - Acceptance: no UX regressions on Runs/Projects/Settings while keeping board fix intact.

## Risks / open questions

1. **Safe-area CSS support nuances**
   - `env(safe-area-inset-*)` behavior can vary by browser/device. Need graceful fallback values.

2. **One-size-fits-all spacing risk**
   - A global extra bottom padding may look excessive on non-board pages; route-aware handling may be preferable.

3. **Future FAB size drift**
   - If button dimensions change later without updating list padding, overlap can reappear. Shared token/constant mitigates this.

4. **Competing fixed overlays**
   - Mobile board also uses sheet overlays (`SheetContent` in `BoardView.tsx`). Need to confirm no visual conflicts when task detail sheet and chat trigger coexist.
