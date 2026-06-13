# Plan: Diff impact ranking and line-level review comments

## Context

Current diff/review flow already has strong primitives, but no structured per-line review metadata:

- Diff retrieval is implemented in `packages/web/src/server/routes/task-diff.ts` and exposed as `GET /api/projects/:project/tasks/:taskName/diff`.
  - Response currently contains `baseRef`, `headRef`, `files[]`, optional `commits[]`, and `reason`.
  - UI renders this in `packages/web/src/client/components/board/TaskDetailPanel.tsx` via `DiffContent` + `FileDiff`.
- Review feedback exists only as plain text at task level:
  - Human request-changes writes annotations (`percussionist.dev/action-request-changes`, `percussionist.dev/action-rework-feedback`) in `packages/web/src/server/routes/board.ts`.
  - AI reviewer verdict is written to review Run annotation (`percussionist.dev/review-verdict`) by `complete_review` in `packages/dispatcher/src/mcp-server.ts`, then consumed by manager reconciler (`packages/manager-controller/src/reconciler/observations.ts` + `decision.ts`) into `Task.status.worker.reviewFeedback` and append-only `Task.status.reviews`.
- Canonical task state is in Task CRD schema (`packages/api/src/index.ts`), and board UI reads Task objects from `/api/projects/:project/board`.

Implication: we already have an end-to-end pattern for “structured data emitted by review run → reconciler → Task.status → UI”. We should reuse this instead of introducing a web-only DB as source-of-truth.

---

## Scope boundaries

### In scope

1. Introduce structured diff-impact metadata model (ranked findings + line/file anchors) in Task status.
2. Capture ranked findings from review/builder agents in a deterministic structured channel.
3. Expose findings alongside task diff API so board diff view can sort/filter by impact.
4. Render ranked findings and inline comment badges in diff UI (read-only comments for now).
5. Ensure findings can drive rework feedback generation (manual + agent workflows).

### Out of scope (for this iteration)

1. Full threaded discussion system (replies, mentions, edit history).
2. Real-time collaborative commenting.
3. Cross-task/global code review inbox.
4. Automatic ML-based ranking independent of agent-provided rationale.

---

## Approach

### 1) Store canonical rankings/comments in `Task.status` (not web SQLite)

Add a typed field under Task status in `packages/api/src/index.ts` (e.g. `Task.status.diffFindings`).

Rationale:

- Task CR is already the authoritative review/workflow state.
- Data must be available both to UI and agents via manager/dispatcher tooling.
- Fits existing reconciler pattern (`reviews[]` is already append-only structured history).
- Avoids dual-write drift between K8s CR state and web SQLite cache tables.

Design constraints:

- Keep payload bounded (cap number of findings, message lengths).
- Keep schema line-anchor based with explicit diff context to detect stale anchors.

### 2) Reuse review verdict transport path, extend with structured findings

Extend reviewer submission path rather than creating ad-hoc API-only writes:

- Extend `complete_review` input schema in `packages/dispatcher/src/mcp-server.ts` to optionally accept structured findings payload.
- Persist this payload inside the review run annotation together with `approved/diagnosis/feedback`.
- Extend manager reconciler parsing (`getReviewVerdict()` in `observations.ts`) and decision handling (`decision.ts`) to copy normalized findings into Task status.

This keeps write authority in orchestrated review flow and preserves auditability by tying findings to the review run.

### 3) Add optional builder-originated findings path (same data contract)

Builders may also provide impact hints. To keep one storage model:

- Add a dispatcher MCP tool for worker runs (e.g. `publish_diff_findings`) that patches current task status with provisional findings (or writes run annotation to be promoted by reconciler).
- Mark source on each finding (`source: "builder" | "reviewer" | "human"`) and retain latest reviewer override semantics.

First release can prioritize reviewer findings; builder findings can be additive if present.

### 4) Anchor comments to diff lines with staleness detection

Use explicit anchor object per finding:

- `path`
- `side` (`old`/`new`)
- `line` (+ optional `endLine`)
- optional `hunkHeader`
- optional `commitSha`
- `diffBaseRef` + `diffHeadRef` (or fingerprint)

UI should only render inline anchors as “active” when current diff refs/fingerprint match; otherwise show as stale/unmapped rather than silently misplacing comments.

### 5) Rank model: explicit severity enum + optional numeric score

Use deterministic buckets for UX sorting/filtering:

- `critical`, `high`, `medium`, `low`, `info`

Optional `score` (0–100) can refine ordering within bucket. UI default sort: severity desc, score desc, file path, line.

### 6) API/UI integration

Augment `task-diff` response (`TaskDiffResponse`) to include findings relevant to the requested task and current diff context.

- Server: `packages/web/src/server/routes/task-diff.ts`
- Client types/api: `packages/web/src/client/lib/types.ts`, `packages/web/src/client/lib/api.ts`
- UI: `TaskDetailPanel.tsx` + `FileDiff.tsx` (add finding sidebar/inline badges + severity chips + filter)

---

## Proposed data model (initial)

Add to API package (`packages/api/src/index.ts`):

- `DiffFindingSeveritySchema`: enum `critical|high|medium|low|info`
- `DiffLineAnchorSchema`: `{ path, side, line, endLine?, hunkHeader?, commitSha? }`
- `DiffFindingSchema`:
  - `id` (stable UUID-ish string)
  - `source` (`builder|reviewer|human`)
  - `severity`
  - `score?`
  - `title`
  - `comment` (main explanatory text)
  - `category?` (e.g. correctness/perf/security/maintainability/tests)
  - `anchors: DiffLineAnchor[]` (at least one)
  - `diffBaseRef?`, `diffHeadRef?`, `diffFingerprint?`
  - `createdAt`, `authorRunName?`
- `TaskDiffFindingsSchema` wrapper in `TaskStatusSchema`:
  - `version`
  - `items: DiffFinding[]`
  - `updatedAt`

Add corresponding frontend TS types in `packages/web/src/client/lib/types.ts` and include in `TaskDiffResponse`.

---

## Tasks (implementation steps)

1. **Define CRD schema for structured diff findings**
   - Update `packages/api/src/index.ts` with new Zod schemas and `TaskStatusSchema` field.
   - Keep strict caps (`max()` on text lengths, findings count) to avoid oversized status payloads.
   - Regenerate CRD YAML via `pnpm codegen`.

2. **Extend dispatcher review tool contract**
   - Update `TOOL_COMPLETE_REVIEW` schema in `packages/dispatcher/src/mcp-server.ts` to accept optional structured findings array.
   - Ensure annotation payload includes findings in JSON.
   - Keep backward compatibility when findings are omitted.

3. **Parse and persist findings in reconciler**
   - Extend verdict parsing in `packages/manager-controller/src/reconciler/observations.ts`.
   - In `decision.ts` review-success branches, append/update `Task.status.diffFindings` while preserving existing `reviews[]` behavior.
   - Define merge semantics (e.g. latest reviewer run replaces prior reviewer findings; keep human entries).

4. **(Optional but planned) Add builder publication path**
   - Add dispatcher MCP tool for current-run task findings publication (or equivalent manager MCP write path).
   - Wire tool handler to patch task status safely.
   - Tag source as `builder` and isolate from reviewer override rules.

5. **Expose findings in diff API**
   - Update `packages/web/src/server/routes/task-diff.ts` to include task findings in response.
   - Compute/find current diff fingerprint context and flag stale/mismatched anchors.
   - Return both raw findings and a pre-sorted order for UI convenience (or document client-side sort only).

6. **Update client contracts and fetch layer**
   - Extend `TaskDiffResponse` and related types in `packages/web/src/client/lib/types.ts`.
   - Keep `fetchTaskDiff()` in `packages/web/src/client/lib/api.ts` unchanged except typing.

7. **Render ranked findings in diff view**
   - `TaskDetailPanel.tsx` (`DiffContent`): add findings panel with severity filters and “top-impact first” default.
   - `FileDiff.tsx`: show per-file badges/counts and line-level markers where anchors match.
   - Add UX affordances for stale anchors (e.g. muted badge + tooltip “anchor from older diff”).

8. **Hook findings into rework UX**
   - In review/request-changes UI (`TaskDetailPanel.tsx` + board actions), provide “insert top findings into feedback” helper to seed rework comments.
   - Ensure plain-text feedback path remains intact for compatibility.

9. **Agent prompt updates**
   - Update reviewer prompt generation in `packages/manager-controller/src/facilitator.ts` to request structured findings in `complete_review` when changes are requested (and optionally when approving with caveats).
   - If builder publication is implemented, update worker instructions in `packages/manager-controller/src/worker-builder.ts` for BUILD tasks.

10. **Tests and validation**
    - API unit tests for verdict parsing with/without findings.
    - Reconciler decision tests verifying `diffFindings` patch behavior and merge semantics.
    - Web route tests for `task-diff` response including findings/staleness flags.
    - UI component tests for severity sorting/filtering and stale-anchor rendering.
    - E2E deterministic scenario: reviewer emits structured findings; task status and board diff tab show ranked comments.

11. **Migration/backward compatibility**
    - Ensure old review annotations (without findings) continue to work.
    - Guard UI for absent findings (no regressions to existing diff view).

---

## Acceptance criteria

1. Task CRD has a typed status field for diff findings with file/line anchors and severity ranking.
2. Reviewer runs can submit structured findings via `complete_review`, and manager persists them to task status.
3. Diff API returns findings together with diff data.
4. Diff UI can sort/filter findings by impact and show line/file associations.
5. Rework flow can reuse findings as feedback seed text.
6. Existing review/diff flows continue working when no structured findings are provided.

---

## Proposed BUILD task breakdown

1. **BUILD A — Data model + orchestrator plumbing**
   - API schema changes, dispatcher `complete_review` extension, reconciler persistence, tests.

2. **BUILD B — Diff API + client contracts**
   - `task-diff` response enrichment, type updates, staleness/fingerprint handling.

3. **BUILD C — Diff UI ranking and inline comment rendering**
   - Findings panel, severity sorting/filtering, per-file/line markers.

4. **BUILD D — Rework integration + prompting + E2E hardening**
   - Rework comment seeding, reviewer prompt updates, deterministic E2E coverage.

---

## Risks / open questions

1. **Anchor stability across rebases/merges**
   - Line numbers drift; stale detection is mandatory. Need decision on whether to attempt fuzzy remapping or only mark stale.

2. **Task status payload size limits**
   - Many findings with long comments can bloat status patches. Must cap finding count/length and possibly keep only latest reviewer set.

3. **Source precedence rules**
   - If both builder and reviewer publish findings, clarify precedence in UI and rework helper (likely reviewer-first).

4. **Human-authored comments model**
   - This plan supports future human comments but does not yet define edit/delete/thread semantics.

5. **Prompt compliance variability**
   - Review agents may omit anchors or malformed JSON; parser should validate and degrade gracefully to plain-text review feedback.

6. **Permission/tooling surface**
   - If builder publication is added, confirm least-privilege write path and auditability (status patch vs run annotation promotion).
