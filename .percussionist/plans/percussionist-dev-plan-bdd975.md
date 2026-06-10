# Plan: board taskview description should support markdown

## Context

- The board task detail UI is rendered in `packages/web/src/client/components/board/TaskDetailPanel.tsx`.
- In the Overview tab, task descriptions are currently displayed as plain text:
  - `OverviewContent` renders `task.spec.description` with `<p className="text-sm whitespace-pre-wrap ...">` (lines ~272–276).
  - This preserves line breaks but does **not** parse Markdown syntax.
- The app already has established Markdown rendering patterns and dependencies:
  - `react-markdown` + `remark-gfm` are already used in `TaskDetailPanel` (for PLAN artifact tab), `PlanView.tsx`, and `SessionView.tsx`.
  - `CodeBlock` is already used for fenced code rendering in these views.
- API/data model changes are likely unnecessary: `Task.spec.description` is already a string field flowing through board APIs and client types.

## Scope boundaries

### In scope
- Board task detail view rendering for `task.spec.description` in the Overview tab.
- Markdown support for common syntax (headings, lists, emphasis, links, inline/fenced code, tables/checkboxes via GFM as needed).
- Styling/alignment with existing board typography and surface tokens.

### Out of scope
- Server/API schema changes for task description.
- Changing task creation/editing semantics beyond optional helper text.
- Reworking other non-board description surfaces unless required for consistency.

## Approach

1. Reuse the existing Markdown stack (`ReactMarkdown`, `remarkGfm`) already present in `TaskDetailPanel.tsx`.
2. Replace the plain `<p>` description renderer in `OverviewContent` with a Markdown-rendering block component (or shared inline renderer) that is specific to task description.
3. Keep rendering safe and predictable by preserving the same plugin set already trusted in the codebase (no raw HTML support unless explicitly required).
4. Reuse or lightly adapt existing component overrides for consistent look-and-feel (paragraph spacing, list spacing, code styles, link treatment, tables).
5. Validate behavior with manual UI checks and project standard verification commands.

## Acceptance criteria

1. In board task detail Overview, Markdown syntax in `task.spec.description` renders as formatted content (not raw markdown text).
2. Existing plain-text descriptions continue to display correctly.
3. No regression in task detail panel behavior (tabs, actions, scrolling, selection).
4. Rendering remains safe (no raw HTML execution).
5. `pnpm typecheck` and relevant tests/build checks pass.

## Tasks

1. **Locate and isolate description render path**
   - Confirm the only board task-detail description renderer is in `OverviewContent` inside `TaskDetailPanel.tsx`.
   - Verify no additional board-side description rendering needs the same markdown treatment.

2. **Define markdown renderer shape for task descriptions**
   - Decide whether to:
     - reuse `planMarkdownComponents`,
     - or create a dedicated `taskDescriptionMarkdownComponents` tuned for compact board detail display.
   - Ensure styling matches board typography and spacing constraints.

3. **Implement description markdown rendering in Overview**
   - Replace the current `<p ...>{task.spec.description}</p>` with `<ReactMarkdown ...>{task.spec.description}</ReactMarkdown>`.
   - Wire `remarkGfm` for common markdown constructs.
   - Keep container classes that preserve readability in narrow/mobile detail panels.

4. **Handle links and code presentation consistently**
   - Ensure anchor links have expected visual treatment and open behavior (consistent with existing app conventions).
   - Ensure inline and fenced code blocks remain readable and theme-consistent (likely via existing `CodeBlock` + tokenized styles).

5. **Check interactions and layout in board detail panel**
   - Verify long descriptions, tables, and code blocks don’t break panel layout.
   - Validate mobile Sheet rendering (`BoardView.tsx`) and desktop split-pane rendering.

6. **Optional UX copy adjustment (if needed)**
   - In `TaskListPanel.tsx` add-task form, consider updating placeholder/help text to hint that description supports Markdown.
   - Keep this optional and low risk; avoid changing backend payload structure.

7. **Verification**
   - Run `pnpm typecheck`.
   - Run `pnpm test` (or targeted web tests if broader suite is too heavy for this change window).
   - Manual checks in board UI with sample descriptions:
     - headings/list/links,
     - inline code and fenced code blocks,
     - table/task-list markdown,
     - plain text fallback.

## Proposed BUILD task breakdown

1. **BUILD 1 — Board description markdown renderer**
   - Implement markdown rendering for `task.spec.description` in `TaskDetailPanel.tsx` Overview.
   - Keep styling and safety aligned with existing markdown surfaces.

2. **BUILD 2 — UX polish + verification**
   - Optional add-task placeholder/help update to advertise Markdown support.
   - Perform typecheck/tests and manual board QA across desktop/mobile.

## Risks / open questions

1. **Renderer duplication risk**
   - `TaskDetailPanel` and `PlanView` currently have similar but separate markdown component maps; decide whether to keep local duplication or extract a shared renderer helper.

2. **Visual density in compact panel**
   - Headings/tables/code blocks may feel dense in the board detail pane; may require slightly different typography overrides from full-page plan view.

3. **Link behavior expectation**
   - Confirm whether board markdown links should open in a new tab (recommended for dashboard continuity) or same tab.

4. **Scope creep into other surfaces**
   - Task descriptions are also used in other contexts (e.g., `AgentChatPanel` context injection as raw text). Clarify that this task targets display rendering only, not prompt formatting semantics.
