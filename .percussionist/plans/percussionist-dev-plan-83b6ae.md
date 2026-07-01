# Plan: Use shadcn Checkbox for Run Logs auto-scroll toggle

## Context

- Run logs UI is rendered by `packages/web/src/client/components/LogViewer.tsx` and reused in:
  - `packages/web/src/client/components/RunDetail.tsx` (Run details page)
  - `packages/web/src/client/components/board/TaskRunsPanel.tsx` (Board run subpanel)
- `LogViewer` currently manages auto-scroll with local state:
  - `const [autoScroll, setAutoScroll] = useState(true)`
  - scroll behavior is gated in two places (`term.scrollToBottom()` during mount and incremental writes)
- The auto-scroll toggle UI currently uses a native HTML checkbox (`<input type="checkbox" ... />`) at `LogViewer.tsx` lines ~244–250.
- The web client already has a shared shadcn/Radix checkbox component at `packages/web/src/client/components/ui/checkbox.tsx`, and it is already used elsewhere (e.g. `AgentForm.tsx`).

## Scope boundaries

### In scope

- Replace the native auto-scroll checkbox in `LogViewer` with the shared shadcn `Checkbox` component.
- Keep existing auto-scroll behavior unchanged (default enabled, toggling updates scrolling behavior immediately).
- Preserve accessibility/label click behavior for the auto-scroll control.
- Add or update frontend tests to guard against regression (using native checkbox instead of shared component, and toggling still works).

### Out of scope

- Any broader redesign of log controls layout, terminal behavior, or xterm rendering.
- Changes to unrelated checkbox usage in other components.
- Server/API changes.

## Approach

1. **Switch to shared checkbox primitive**
   - Import `{ Checkbox }` from `./ui/checkbox` into `LogViewer.tsx`.
   - Replace `<input type="checkbox">` with `<Checkbox>`.
2. **Handle Radix checkbox state correctly**
   - `Checkbox` uses Radix `onCheckedChange`, which can emit `true | false | 'indeterminate'`.
   - Map that value to strict boolean for `autoScroll` (e.g. `setAutoScroll(value === true)`), and keep `checked={autoScroll}`.
3. **Keep behavior parity**
   - Ensure no changes to existing write/scroll logic in `writeData` and terminal mount flow.
   - Confirm label text and click target remain usable in both Run Detail and Task Runs panel contexts.
4. **Add regression-focused test coverage**
   - Add/extend a web client test to verify:
     - auto-scroll control is rendered via expected checkbox semantics,
     - toggling control updates checked state,
     - no dependency on raw `<input type="checkbox">` implementation.
   - If xterm makes direct rendering brittle in tests, mock `@xterm/xterm` and `@xterm/addon-fit` similarly to existing module mocks in `packages/web/tests/*.test.tsx`.

## Tasks

1. **Update `LogViewer` imports and toggle control**
   - File: `packages/web/src/client/components/LogViewer.tsx`
   - Add `Checkbox` import.
   - Replace native `<input type="checkbox">` block with shadcn checkbox while preserving label text (`auto-scroll`) and layout classes.

2. **Wire checkbox event conversion for boolean state**
   - File: `packages/web/src/client/components/LogViewer.tsx`
   - Change event handler from `onChange={(e) => setAutoScroll(e.target.checked)}` to Radix-compatible `onCheckedChange={(value) => setAutoScroll(value === true)}`.
   - Keep `checked={autoScroll}` binding unchanged.

3. **Validate usage surfaces remain intact**
   - Files:
     - `packages/web/src/client/components/RunDetail.tsx`
     - `packages/web/src/client/components/board/TaskRunsPanel.tsx`
   - Confirm no prop/API changes needed for callers of `LogViewer`.

4. **Add/adjust tests for the log viewer toggle**
   - File target: `packages/web/tests/log-viewer.test.tsx` (new) or extend an existing relevant test file.
   - Mock hook dependencies (`useLogs`) and terminal dependencies as needed.
   - Assert that the auto-scroll toggle is present and interactive under current component API.

5. **Run targeted verification**
   - Execute a targeted web test command for the changed test file(s) and ensure pass.
   - Run formatting/lint fixes only if required by touched files.

## Acceptance criteria

- The auto-scroll toggle in logs UI uses `packages/web/src/client/components/ui/checkbox.tsx` (shadcn/Radix), not a raw `<input type="checkbox">`.
- Auto-scroll behavior remains unchanged:
  - defaults to enabled,
  - disabling stops forced scroll-to-bottom,
  - re-enabling resumes forced scroll-to-bottom behavior on updates.
- Logs UI remains functional where `LogViewer` is embedded (`RunDetail`, `TaskRunsPanel`).
- Test coverage exists for the checkbox control to prevent regression.

## Risks / open questions

1. **Radix event type mismatch risk**
   - `onCheckedChange` is not a native event and can emit `'indeterminate'`; forgetting explicit coercion could break TypeScript or behavior.

2. **Test fragility around xterm**
   - `LogViewer` mounts `Terminal` and `ResizeObserver`; tests may require mocking these dependencies/environment APIs to avoid flaky failures.

3. **Accessibility semantics check**
   - Since Radix checkbox renders a button-like root, ensure label association/click behavior is still intuitive with existing `<label>` wrapper.

## Proposed BUILD task breakdown

1. **BUILD A — UI migration to shadcn checkbox**
   - Replace native checkbox in `LogViewer` with shared `Checkbox` component and Radix-compatible event handling.

2. **BUILD B — Regression tests for log auto-scroll toggle**
   - Add/adjust tests for `LogViewer` control behavior, including mocking strategy for xterm dependencies.

3. **BUILD C — Validation and polish**
   - Run targeted tests, fix any typing/format issues, and verify no unintended API/caller changes.
