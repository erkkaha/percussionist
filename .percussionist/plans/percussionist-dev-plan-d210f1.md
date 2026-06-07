# Plan: Fix hidden task-context inject icon on mobile

## Context

- The inject action for board tasks is rendered in `packages/web/src/client/components/board/TaskRow.tsx`.
- The action button is the `MessageSquarePlus` icon at lines ~164–171, wired to:
  - `onClick={(e) => { e.stopPropagation(); injectTask(task, projectName); }}`
  - `injectTask` from `useChat()` (`packages/web/src/client/lib/chat-context.tsx`), which eventually calls `AgentChatPanel` injection logic (`packages/web/src/client/components/AgentChatPanel.tsx`, `injectTask(...)` at lines ~279–283).
- The visibility is currently controlled only by hover classes:
  - `className="opacity-0 group-hover:opacity-60 hover:opacity-100 ..."`
- On touch/mobile devices there is no reliable hover state, so the button remains visually hidden and users cannot discover or use task context injection.

## Scope boundaries

### In scope
- Fix visual discoverability/usability of task injection control in the board task row on touch/mobile.
- Preserve existing injection behavior (open chat and send formatted task context).
- Ensure desktop interaction quality remains acceptable.
- Add/adjust lightweight UI validation (manual or automated, depending on existing test patterns).

### Out of scope
- Redesigning board layout, task row information architecture, or chat workflow.
- Changing message formatting/content for injected task context.
- Broad mobile UX overhaul outside task-row action visibility.

## Approach

Use a **responsive visibility strategy** in `TaskRow` so the inject icon is always visible (or at least non-hidden) on small/touch layouts, while keeping reduced visual prominence on desktop until hover.

Recommended implementation direction:

1. Update the inject button classes in `TaskRow.tsx` to default visible on mobile and hover-revealed on desktop. Example strategy:
   - Base (mobile-first): visible (`opacity-70` or similar).
   - `md:` override: hidden until hover (`md:opacity-0 md:group-hover:opacity-60 md:hover:opacity-100`).
2. Keep `e.stopPropagation()` so tapping the icon does not trigger task row selection.
3. Improve accessibility/clarity while touching this code:
   - Add `aria-label="Inject task into chat"` (title already exists; aria-label helps screen readers).
   - Ensure hit target remains practical on mobile (consider slightly larger padding/size if needed).
4. Validate behavior in both mobile and desktop breakpoints.

Why this approach:
- Minimal, low-risk change localized to one component.
- Mobile-first semantics avoid reliance on hover-only affordances.
- Preserves current desktop “clean row” behavior.

## Acceptance criteria

1. On mobile viewport (below `md`), each task row shows a visible inject icon without requiring hover.
2. Tapping the inject icon on mobile opens chat (if closed) and injects task context exactly as before.
3. Tapping inject icon does not also select/open the task row detail unintentionally.
4. On desktop (`md`+), inject icon behavior remains subdued and appears on hover (or equivalent intentional affordance).
5. Inject button has accessible labeling (`aria-label`) and no regression in keyboard/click behavior.

## Proposed BUILD task breakdown

1. **Adjust TaskRow action visibility classes**
   - File: `packages/web/src/client/components/board/TaskRow.tsx`
   - Replace hover-only opacity classes with responsive/mobile-visible classes.

2. **Accessibility polish for inject control**
   - File: `packages/web/src/client/components/board/TaskRow.tsx`
   - Add `aria-label` and verify touch target sizing remains usable.

3. **Behavior verification for interaction correctness**
   - Validate manually in browser devtools responsive mode (mobile + desktop):
     - icon visibility,
     - inject action triggers chat context,
     - row click not triggered by icon tap.
   - If an existing client test pattern is straightforward to extend, add a focused test; otherwise document manual verification steps in PR.

4. **Regression check on board/chat flow**
   - Smoke-check that `injectTask` path (`TaskRow` → `ChatContext` → `AgentChatPanel`) remains unchanged functionally.

## Risks / open questions

1. **Visual noise tradeoff on small screens**
   - Always-visible icons may slightly increase row clutter.
   - Mitigation: use medium opacity and subtle hover/active color states.

2. **Breakpoint assumptions (`md`)**
   - Device class does not always map cleanly to hover capability (e.g., tablets with pointer devices).
   - Follow-up option: use CSS media query for hover capability (`hover: hover`) if current Tailwind setup supports it; otherwise keep breakpoint-based fix for simplicity.

3. **Hit target size**
   - Current `p-0.5` may be small for touch ergonomics.
   - May need slight padding increase if usability testing indicates missed taps.

## Notes for implementer

- Keep the fix localized unless testing reveals additional hidden action patterns.
- This issue appears isolated to `TaskRow.tsx`; no server/API changes expected.
- Verify in both board states (with and without selected task) to ensure no layout shifts break action alignment.
