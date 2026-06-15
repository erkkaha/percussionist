# Plan: Agent capability descriptions in Agent Settings

## Context

- Agent capability values are defined centrally in `packages/api/src/index.ts` as `AgentCapabilitySchema` (9 enum values).
- The Agent Settings UI currently renders capabilities as raw enum strings without user-facing explanations:
  - `packages/web/src/client/components/AgentForm.tsx` has a local `CAPABILITIES` string array and checkbox list.
  - `packages/web/src/client/components/AgentsPage.tsx` displays selected capabilities as plain chips.
- The server already passes capabilities through unchanged (`packages/web/src/server/routes/agents.ts`), so this request is primarily a web-client UX/content enhancement.
- Capability semantics are already documented for maintainers in `docs/reference/mcp-tools.md` (capability matrix and completion-tool mapping), which can be used as canonical meaning during implementation.

## Scope boundaries

- **In scope**
  - Add clear, human-readable descriptions for each `AgentCapability` in Agent Settings UI.
  - Ensure the descriptions explain what each capability enables (task assignment and/or completion tools).
  - Keep existing API payload shape unchanged (`capabilities?: AgentCapability[]`).
- **Out of scope**
  - Changing capability names, adding/removing capability enum values, or altering runtime authorization behavior.
  - Broad redesign of settings pages beyond capability description UX.
  - Manager/dispatcher enforcement logic changes.

## Approach

1. Introduce a single capability metadata source in the web client (value + label + description), typed against `AgentCapability`, instead of hardcoded raw strings in `AgentForm.tsx`.
2. Use this metadata in Agent Settings forms so each capability row includes explanatory text ("what this enables").
3. Optionally reuse metadata in `AgentsPage.tsx` to improve readability (friendly label with tooltip/secondary text), while keeping stored value unchanged.
4. Add/adjust UI tests (or nearest existing component test coverage) to ensure each enum capability has a description and rendered helper text remains complete when new capabilities are introduced.

## Tasks

1. **Create capability metadata map in web client**
   - Add a new shared constant/module (e.g. `packages/web/src/client/lib/agent-capabilities.ts`).
   - Define typed entries for all `AgentCapability` values with:
     - canonical `value`
     - concise display label
     - description stating what it enables (e.g., can be assigned PLAN tasks, can call `complete_plan`, etc.).
   - Add a compile-time guard pattern (e.g. `Record<AgentCapability, ...>` and derived array) so future enum additions fail fast if metadata is missing.

2. **Update AgentForm capability selector rendering**
   - Replace local `CAPABILITIES` array in `packages/web/src/client/components/AgentForm.tsx` with shared metadata import.
   - Render each checkbox row with:
     - capability identifier or label
     - short description beneath/next to it explaining enablement.
   - Keep submit/update behavior unchanged (`capabilities` still sends only enum values).

3. **Improve selected-capabilities display in agent list (optional but recommended)**
   - In `packages/web/src/client/components/AgentsPage.tsx`, map raw values to friendly labels and optionally expose description via title/tooltip.
   - Preserve fallback to raw value if metadata is missing to avoid UI breakage.

4. **Add/adjust tests for capability description completeness**
   - Add a focused test in web client test suite location (or nearest existing test harness) that asserts:
     - all `AgentCapability` values have metadata entries
     - descriptions are non-empty
     - AgentForm renders helper text for capabilities.
   - If no client component tests currently exist, add a lightweight unit test around metadata completeness at minimum.

5. **Documentation sync (if needed)**
   - Ensure wording in UI descriptions aligns with capability matrix in `docs/reference/mcp-tools.md`.
   - Update docs only if UI text introduces meaning not already documented.

6. **Validation pass**
   - Run targeted checks for changed package(s) (at minimum web tests/typecheck for affected files).
   - Verify Agent Settings create/edit flow still persists selected capabilities correctly.

## Acceptance criteria

- Agent Settings capability selector shows a clear description for **every** capability.
- Each description states what the capability enables (task type and/or completion action).
- No API schema changes and no authorization behavior changes.
- Type-safe mapping exists so new capability enum values cannot be silently missing descriptions.
- Relevant tests pass and cover metadata completeness/rendering expectations.

## Proposed BUILD task breakdown

1. **BUILD-1: Add typed capability metadata for web client**
   - Create shared `AgentCapability` metadata module with labels + descriptions + exhaustiveness guard.

2. **BUILD-2: Render descriptions in AgentForm capability UI**
   - Consume shared metadata and update capability rows in create/edit form.

3. **BUILD-3: Add regression coverage for capability metadata/rendering**
   - Add tests validating complete mapping and visible helper descriptions.

4. **BUILD-4 (optional): Improve Agents list capability readability**
   - Friendly labels/tooltips in `AgentsPage` using same metadata map.

## Risks / open questions

- **UI wording ambiguity:** "what each capability enables" could require very terse or very explicit phrasing. Assumption: one-line practical descriptions are sufficient.
- **Test harness location:** Web client component test conventions may be limited; implementation may need to start with metadata unit tests first.
- **Source of truth drift:** Capability meanings exist in docs + runtime code. Mitigation: keep UI descriptions aligned with `docs/reference/mcp-tools.md` matrix and dispatcher mapping logic.

## Assumptions

- "Agent settings" refers to the web Agent create/edit experience (`AgentForm.tsx`) under Settings → Agents.
- The request targets UX/descriptive copy, not capability model redesign or backend behavior changes.
