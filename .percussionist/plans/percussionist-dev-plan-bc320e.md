# Plan: Restore Full-Screen Manager Chat on Mobile

**Task:** `percussionist-dev-plan-bc320e`  
**Issue:** On mobile, opening manager chat currently pushes/shrinks main page content because chat is rendered as a sibling side panel (`w-96`) in the primary layout flow. Expected behavior is full-screen chat on mobile (overlay/modal style), matching prior UX.

---

## Context

- `packages/web/src/client/components/Layout.tsx` renders app structure as:
  - `<AppSidebar />`
  - `<SidebarInset>...main content...</SidebarInset>`
  - `<AgentChatPanel ... />`
- `packages/web/src/client/components/AgentChatPanel.tsx` currently renders the open chat container as:
  - `"w-96 flex-shrink-0 ... sticky top-0 max-h-screen"`
  - This is desktop side-panel behavior and participates in normal flex layout.
- Because `AgentChatPanel` is placed as a direct child of the same flex row in `SidebarProvider`, opening chat affects horizontal layout width.
- Mobile detection utility already exists in `packages/web/src/client/hooks/use-mobile.tsx` (`useIsMobile`, breakpoint `768px`) and is already used by sidebar primitives.
- Reusable overlay primitive exists in `packages/web/src/client/components/ui/sheet.tsx` and is used for mobile task detail in `BoardView.tsx`.

Root cause summary:
- Chat panel styling/layout is desktop-oriented only; there is no mobile-specific rendering mode that detaches it from the main layout flow.

---

## Scope Boundaries

### In scope
- Manager chat presentation/layout behavior on mobile viewports (`<768px`) in `AgentChatPanel` and layout integration points.
- Preserving existing chat functionality (history load, SSE stream, send/cancel, STT/TTS toggles, task injection API).
- Ensuring floating chat launcher and close/open flow still work on mobile.

### Out of scope
- Backend/API behavior in `packages/web/src/server/routes/agent-chat.ts`.
- Desktop chat panel UX (should remain right-side panel unless explicitly adjusted for consistency).
- Non-chat mobile UX updates for board/settings/runs pages.

---

## Approach

Use **responsive dual-mode chat rendering**:

1. Keep existing right-side panel behavior for desktop.
2. Render chat as a **full-screen overlay on mobile** so it does not consume flex width or push content.
3. Reuse existing primitives/conventions (`useIsMobile`, optionally `Sheet`) rather than inventing a new modal system.

Preferred implementation direction:
- In `AgentChatPanel.tsx`, branch on `isMobile` and `open`:
  - **Mobile mode:** render `fixed inset-0 z-*` full-screen chat container (or `SheetContent` with `w-full h-full`) with internal `flex flex-col` + scrolling messages.
  - **Desktop mode:** keep current `w-96 sticky top-0` panel.
- Keep launcher button behavior (`!open`) intact; ensure z-index is below active overlay and above page content when closed.
- Ensure mobile overlay respects viewport height with `h-[100svh]`/`max-h-[100svh]` patterns (or equivalent) to avoid browser chrome jump issues.

Key decision:
- Prefer containing changes in `AgentChatPanel.tsx` (plus minor `Layout.tsx` adjustments only if necessary), minimizing blast radius.

---

## Tasks

1. **Confirm current responsive constraints and reproduction path**
   - Verify current chat open state flow: `App.tsx` (`chatOpen`), `Layout.tsx` pass-through, `AgentChatPanel` rendering.
   - Reproduce mobile behavior: open chat at `<768px` and confirm main content is pushed.

2. **Introduce mobile detection to chat panel rendering**
   - In `packages/web/src/client/components/AgentChatPanel.tsx`, wire in `useIsMobile()`.
   - Add explicit responsive branch for mobile vs desktop container composition.

3. **Implement full-screen mobile chat container**
   - Render open chat on mobile as full-screen overlay (fixed positioning or Sheet-based full viewport content).
   - Keep header/message/input sublayout equivalent so features remain unchanged.
   - Ensure close control remains visible and accessible.

4. **Preserve desktop panel behavior**
   - Retain existing right-side width/sticky panel on desktop (`w-96` behavior).
   - Verify desktop layout still shows content + chat side-by-side as before.

5. **Adjust launcher/stacking behavior**
   - Ensure launcher button hides when open and appears correctly when closed on both mobile and desktop.
   - Verify z-index layering: overlay above layout content/sidebar; launcher above content but below open overlay.

6. **Validate injected-task flow and chat lifecycle**
   - Test `TaskRow` “Inject task into chat” path still opens chat and sends context.
   - Confirm history loading and SSE stream lifecycle remain tied to `open` state in both mobile and desktop modes.

7. **Manual QA checklist (mobile-first)**
   - Open/close chat on Activity, Board, and Runs views in mobile viewport.
   - Confirm no content shift/push when chat opens.
   - Confirm chat fills the viewport and messages/input remain usable with keyboard open.

8. **Sanity verification**
   - Run typecheck/build target appropriate for touched client files (`pnpm typecheck` at minimum).

---

## Proposed BUILD Task Breakdown

1. **BUILD A — Mobile full-screen chat rendering**
   - Primary file: `packages/web/src/client/components/AgentChatPanel.tsx`
   - Deliverable: mobile chat opens as overlay/full-screen and no longer pushes page content.

2. **BUILD B — Integration & responsive regression checks**
   - Files: `AgentChatPanel.tsx` and (if needed) `Layout.tsx`
   - Deliverable: desktop side-panel behavior unchanged, launcher/z-index behavior correct, task injection still works.

3. **BUILD C — Validation pass**
   - Deliverable: typecheck/build + concise manual QA notes for mobile/desktop scenarios.

---

## Risks / Open Questions

1. **Viewport height quirks on mobile browsers:** `100vh` can be unstable with browser UI; implementation should prefer `svh`/tested fallback.
2. **Overlay primitive choice:** A custom `fixed inset-0` container is straightforward; `Sheet` reuse may provide consistency but needs full-screen tuning.
3. **Scroll locking/interaction conflicts:** Ensure background content is non-interactive while overlay is open.
4. **Keyboard overlap behavior:** Input area may be obscured on some devices; verify practical usability.

---

## Acceptance Criteria

- On mobile (`<768px`), opening manager chat displays it full-screen (overlay/modal behavior).
- On mobile, opening chat does **not** push or shrink underlying page content.
- Chat core features (history load, live updates, send/cancel, task injection) still work.
- Desktop retains right-side panel chat behavior.
- Changes are localized to web client chat UI and pass typecheck/build validation.
