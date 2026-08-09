# Remove dead code: unreachable facilitation flow, legacy prefs, dead mutations, stale Dockerfile, dead board column field

**Task:** `percussionist-dev-plan-rev22`
**Type:** PLAN
**Date:** 2026-08-06

## Context

Repo-wide caller searches (verified during planning) confirm the following dead code. Every item below was checked by grepping for production callers; test-only references are called out where relevant.

### 1. Unreachable failure-facilitation flow — `packages/manager-controller/src/facilitator.ts`

- `buildFacilitationRun` (lines 110–184) — builds a facilitator Run for a **failed** worker run (recommends `retry_same | retry_alternative | skip`). **Zero callers.** The reconciler's `effects.ts` dynamically imports only `buildReviewRun` (line 141) and `buildBuildTaskGeneratorRun` (line 164). Failed worker runs are now handled inline by `reconciler/decision.ts` (`decideFailed` → awaiting-human/failed, see decision.ts:1810 "Other failure — escalate to human"); no facilitator run is spawned. e2e `e2e-basic-failure.test.ts` confirms: worker Run → Failed → Task phase `failed`, no facilitator run in between.
- `parseFacilitationResult` (lines 597–678) + `extractFacilitationJson` (lines 681–714) — parse the JSON recommendation from a facilitation run. **Zero callers.**
- **Prompt bug to fix at the same time:** `buildReviewRun`'s PLAN-task branch (facilitator.ts:442) tells reviewers `Use escalate only for cases that require human judgment beyond improving the plan artifact.` But the review pipeline has no escalate path:
  - dispatcher `complete_review` (`packages/dispatcher/src/mcp-server.ts:1369-1375`) builds `rawVerdict.action` as only `approve`/`request_changes`;
  - `normalizeReviewVerdict` (`packages/api/src/index.ts:1653-1658`) accepts only `approve`/`request_changes`/`request-changes` and returns `undefined` for anything else → an "escalate" intent is **silently dropped** (verdict annotation never written, task strands in awaiting-human).
  - Fix: remove the escalate instruction and point PLAN reviewers at `request_changes` + feedback as the only rework signal.

**Adjacent dead api surface (only consumers are the dead code above):**
- `FacilitationAction` const + type (api/src/index.ts:599–607) and `FacilitationResultSchema`/`FacilitationResult` (620–634) — referenced only by `parseFacilitationResult`/`extractFacilitationJson` and by `BoardStatusSchema.facilitations` (line 1086).
- `BoardStatusSchema.facilitations` (api/src/index.ts:1086) — never written or read anywhere (grep for `facilitations` finds only the schema). Removing it also makes `patch_board` (tools.ts:1306, validates via `BoardStatusSchema.partial()`) stop accepting it automatically.
- `AgentDecision` + `FacilitationParseResult` interfaces (`packages/manager-controller/src/agent/config.ts:28–48`) — zero usage anywhere.
- **Keep:** `FacilitationSpecSchema`/`FacilitationSpec` (still used by `buildReviewRun`, `buildBuildTaskGeneratorRun`, `buildFacilitatorRun`, Run CRD schema, operator `pod-builder.ts:1079`), `RunSpecSchema.facilitation`, `RUN_CONTEXT_VALUES` `'facilitator'` (still produced by buildgen runs which set `successReview: false`).

### 2. `canSchedule` — `packages/manager-controller/src/reconciler/scheduler.ts:23–56`

Zero production callers (only `scheduler.test.ts`). Its logic (WIP limit + predecessor gate + retryAfter) is duplicated by `decidePending` (`reconciler/decision.ts:224–260`), which is the live path — drift hazard confirmed: `decidePending` uses `input.now` for the retryAfter comparison while `canSchedule` uses `new Date()`. Keep `isActivePhase` and `byPriority` (both used by `reconciler/index.ts`).

### 3. Tautological ternary — `packages/manager-controller/src/agent/session.ts:307`

`const phase = signal?.aborted ? 'Failed' : 'Failed';` — both branches identical. The log on lines 308–312 already distinguishes aborted vs timeout; the phase is always `'Failed'`.

### 4. memory-service drizzle layer — `packages/memory-service/src/`

- `schema.ts` — drizzle schema whose only consumers are the drizzle instance; every route uses `getRawDb()` (routes.ts:129, 154, 216, 261, 292, 371…). The drizzle schema also carries a **broken string-literal default** `default("datetime('now')")` (schema.ts:8) — it would store the literal text `datetime('now')`, not a timestamp. The real DDL in `initDb()` (routes.ts:83) is already correct: `created_at TEXT NOT NULL DEFAULT (datetime('now'))`.
- `db.ts` — the `_db` drizzle instance (`drizzle({ client: _raw, schema })`, line 88). `getDb()` is called only by `handleHealth` (routes.ts:396, "ensure DB is initialised") and internally by `getRawDb()` (db.ts:94). Tests import only `getRawDb`/`vecUnavailableReason` (routes.test.ts:31).
- `getEmbeddings` (`embed.ts:25–41`) — batch embedding; **no production caller**, only `embed.test.ts` and the `shared-mocks.ts` mock. `getEmbedding` (single) is used by every route — keep it.
- `drizzle-orm` is a direct dependency in `packages/memory-service/package.json` — removable after the layer is gone (other packages keep using drizzle, so pnpm-lock is untouched elsewhere).

### 5. Web client — `packages/web/src/client/`

- `components/BoardView.tsx:99–122` — four underscore-prefixed mutations never invoked: `_deleteMutation`, `_retryMutation`, `_approveMutation`, `_requestChangesMutation`. The real mutations live in `board/TaskDetailPanel.tsx` (lines 989–1018) using the same API helpers. Removing the dead blocks also orphans `invalidateBoard` (line 97), the `useMutation` import (line 1), and four API imports (`approveTask`, `deleteBoardTask`, `requestChangesTask`, `retryEscalatedTask` — lines 8–12; TaskDetailPanel imports its own).
- `lib/notifications.ts:17–44` — legacy `getNotificationPreferences`/`setNotificationPreferences`/`NotificationPreferences` + a local `NOTIFICATION_PREFS_KEY = 'percussionist:notifications'`. **Zero callers.** The real source of truth is the zustand store `settingsStore.ts` (`useNotificationStore`, `persist` with `name: NOTIFICATION_PREFS_KEY`, version 1), which `notify()` already reads at notifications.ts:273. Zustand persists `{state:{...},version:1}`; the legacy functions read/write bare `{soundEnabled: bool}` under the **same key** — a future `setNotificationPreferences` call would corrupt the store's persisted JSON. Delete the legacy pair, keep `notify()`/`playDrum`/history.

### 6. `images/manager/Dockerfile`

Zero references repo-wide (`grep -rn "images/manager"` over workflows/scripts/docs → nothing). Both CI (`images.yml` matrix lines 43–46) and `scripts/minikube-load.sh` (lines 96–97) build manager via `images/node/Dockerfile` with `--build-arg PKG=manager-controller`. The file's own header instructions (`docker build -t percussionist/manager:dev images/manager`) cannot work: the Dockerfile does `COPY pnpm-workspace.yaml package.json ...` from a context (`images/manager`) that contains neither. Delete the file (and the empty `images/manager/` dir).

### 7. Task CRD `status.column` — dead field

- Schema: `TaskStatusSchema.column` (`packages/api/src/index.ts:1807–1810`, enum `backlog|ready|in-progress|review|rework|done|blocked`).
- Controllers stopped writing/reading it: no manager/operator code writes `status.column`; `inspect_cr` (manager MCP `tools.ts:1212`) still **reads** `column: t.status?.column` — the only remaining read.
- CLI already fixed by a previous task: `packages/cli/src/board.ts` computes columns from phase (`computeBoardColumn`, lines 82–87) and `board-move.test.ts` asserts the CLI never touches `status.column`.
- Web: only UI-local `filters.column` (FilterBar/TaskListPanel) — unrelated. `TaskEventsPanel` renders an event-payload `column` badge from stored event payloads — defensive rendering, not a `status.column` read; leave alone.
- CRD artifacts: `codegen/gen-crds.mjs:288–292` hardcodes the `Column` additionalPrinterColumn (`jsonPath: .status.column`); `k8s/crds/task.yaml:22–24` and the schema at task.yaml:133 contain the field (regenerated by `pnpm codegen`).
- `TaskColumn` legacy enum (`api/src/index.ts:900–910`) exists only to type the removed field; re-exported by `packages/web/src/client/lib/types.ts` (lines 20, 38) but unused by any component. Remove.

### 8. Scripts

- `scripts/ghcr-delete-tag.sh:10` — `IMAGES=("runner" "operator" "dispatcher" "manager" "web" "memory")`; missing `runner-claude` and `code-server`, both published by CI (`images.yml` matrix includes runner-claude line 32 and code-server line 53).
- `scripts/ghcr-delete-package.sh:14` — `DEFAULT_PACKAGES` has the same gap.
- `scripts/minikube-load.sh:266` — `echo ">> Building $tag${FORCE:+ (no-cache)}"`: `FORCE` is the string `true`/`false` (set at line 46), and `${FORCE:+...}` tests **non-empty**, not truth → prints "(no-cache)" on every build even without `--force`. (`build_one` at line 64 already gates `--no-cache` correctly with `if $FORCE`.)

## Scope boundaries

**In scope:** removal/dead-code fixes listed above; the PLAN-review prompt correction (facilitator.ts:442); regeneration of CRD YAML; test updates that mirror removals (`scheduler.test.ts`, `embed.test.ts`, `shared-mocks.ts`, `routes.test.ts` if needed).

**Out of scope (explicitly kept):**
- `FacilitationSpecSchema`, `RunSpecSchema.facilitation`, `RUN_CONTEXT_VALUES['facilitator']`, operator `pod-builder.ts` facilitation handling — still live for review/buildgen runs; e2e tests read `{.spec.facilitation.targetRunName}` / `{.spec.facilitation.successReview}`.
- `computeBoardColumn`/`BoardColumn` — live (api, CLI, web board.ts:153).
- Operator `manager-decision` subagent prompt prose (operator/reconciler.ts:280–343) mentions "parses facilitation output" — it is a prompt string for the live chat decision agent; no code behind it is being removed. Optionally reword in the facilitator BUILD, not required.
- `TaskEventsPanel` event-payload `column` badge (renders legacy event payloads defensively).
- Web `FilterBar`/`TaskListPanel` `filters.column` (UI board-column filter state, unrelated to CRD field).
- The `escalate` action in `decision.ts` review-ceiling records (decision.ts:754) — a review-verdict *record* mapping, not the facilitation flow; leave.

## Approach

Small, mechanical deletions with two cross-cutting cares:

1. **Keep exported APIs that are still live** — `FacilitationSpecSchema` etc. stay; only remove what caller searches proved dead.
2. **Regenerate, don't hand-edit CRDs** — api schema changes flow through `pnpm codegen` (root script → `packages/api` build → `codegen/gen-crds.mjs`). Only `gen-crds.mjs`'s hardcoded printer column is edited by hand, then the YAML is regenerated. Diff the generated YAML to confirm only `task.yaml` (Column printer column + `column` schema) and `project.yaml` (BoardStatus `facilitations`) change.
3. **Fix the prompt bug the removal exposes** — the PLAN reviewer "Use escalate" instruction must be corrected in the same BUILD that removes the dead flow, since the flow was the only thing that ever consumed `escalate`.
4. **No behavior change** — every removal is a pure deletion; the only functional edits are the prompt line, `session.ts:307`, `handleHealth`'s `getDb()`→`getRawDb()`, `tools.ts:1212` `column` field, and the script fixes.

## Tasks (BUILD breakdown)

Suggested ordering: **A → B → C … F** with only A→B sequenced (both touch `packages/api`/manager-controller-adjacent files and A regenerates CRDs; sequencing avoids parallel schema churn). C–F are fully independent and may run in parallel after A/B, or as a chain.

### BUILD A — Remove `Task.status.column` + `TaskColumn` + dead facilitation api types; regenerate CRDs

Files: `packages/api/src/index.ts`, `codegen/gen-crds.mjs`, `k8s/crds/task.yaml`, `k8s/crds/project.yaml` (regenerated), `packages/manager-controller/src/agent/tools.ts`, `packages/web/src/client/lib/types.ts`, `packages/api/src/__tests__/review-verdict.test.ts` (verify only).

1. `packages/api/src/index.ts`:
   - Remove `column` field from `TaskStatusSchema` (lines 1807–1810).
   - Remove `TaskColumn` legacy enum + type (lines 900–910) — keep `BoardColumn` and `computeBoardColumn`.
   - Remove `FacilitationAction` const + type (599–607) and `FacilitationResultSchema`/`FacilitationResult` (620–634) — keep `FacilitationSpecSchema`/`FacilitationSpec`.
   - Remove `facilitations` from `BoardStatusSchema` (line 1086).
2. `codegen/gen-crds.mjs`: remove the `Column` additionalPrinterColumn entry (lines 288–292) for the Task CRD.
3. Run `pnpm codegen`; verify diff shows `k8s/crds/task.yaml` loses the Column printer column and `column` schema property, and `k8s/crds/project.yaml` loses `facilitations`; no other CRD files changed unexpectedly.
4. `packages/manager-controller/src/agent/tools.ts:1212`: in `inspect_cr` Task output, replace `column: t.status?.column` with `column: computeBoardColumn(t.status?.phase ?? 'pending')` (import `computeBoardColumn` from `@percussionist/api` — check existing imports) or drop the field entirely; prefer computing so agents keep the column view.
5. `packages/web/src/client/lib/types.ts`: remove `TaskColumn` from the import and re-export lists (lines 20, 38).
6. Verify nothing else references the removed symbols (grep `TaskColumn`, `FacilitationAction`, `FacilitationResultSchema`, `FacilitationResult`, `.facilitations`, `status?.column`).

**Acceptance:** `pnpm typecheck` + `pnpm test` + `pnpm lint` pass; CRD diff as described; `pnpm build` passes.

### BUILD B — Remove the failure-facilitation flow + fix the PLAN-review prompt

Files: `packages/manager-controller/src/facilitator.ts`, `packages/manager-controller/src/agent/config.ts`.

1. `facilitator.ts`:
   - Delete `buildFacilitationRun` (110–184).
   - Delete `parseFacilitationResult` (597–678) and `extractFacilitationJson` (681–714).
   - Remove now-unused imports: `fetchSessionMessages` and `readPodLog` from the `@percussionist/kube` import block (lines 21–28). Verify `core` is still used by `readStoredSessionSummary` (keep), and `RunStatus`/`Task`/`Project`/`Run`/`resolveRunConfig`/`FacilitationSpec`/`LABELS`/`MANAGED_BY`/`KIND_RUN`/`API_GROUP_VERSION` are all still used by the retained functions.
   - Fix the PLAN-review prompt (line 442): replace `Use escalate only for cases that require human judgment beyond improving the plan artifact.` with guidance that `request_changes` + explicit feedback is the only rework signal (escalate is not a supported verdict). Suggested wording: "If the plan artifact is missing, vague, or lacks enough context for builders, use request_changes and explain exactly what the plan must add; there is no 'escalate' verdict — substantive human judgment is requested through the task's awaiting-human flow after rework attempts."
2. `packages/manager-controller/src/agent/config.ts`: delete `AgentDecision` (28–32) and `FacilitationParseResult` (34–48) interfaces.
3. (Optional, same BUILD) reword the `manager-decision` subagent prose in `packages/operator/src/reconciler.ts:293–307` to drop "parses facilitation output"/`retry_alternative | skip | escalate` action list if desired — prompt string only, no code change.
4. Grep-verify: `buildFacilitationRun`, `parseFacilitationResult`, `extractFacilitationJson`, `AgentDecision`, `FacilitationParseResult` have no remaining references (test files included).

**Acceptance:** `pnpm typecheck` + `pnpm test` + `pnpm lint` pass; `facilitator.test.ts` (tests only `resolveSummarySource`/`reviewOutputPromptLines`) still green.

### BUILD C — `canSchedule` removal + `session.ts` tautology

Files: `packages/manager-controller/src/reconciler/scheduler.ts`, `packages/manager-controller/src/reconciler/__tests__/scheduler.test.ts`, `packages/manager-controller/src/agent/session.ts`.

1. `scheduler.ts`: delete `canSchedule` (lines 22–56). Keep `isActivePhase` and `byPriority`. Remove the now-unused `Project` type import if it becomes unused (check: `byPriority` doesn't use `Project`; `isActivePhase` doesn't; only `canSchedule` did — drop `Project` from the import at line 3 if so).
2. `scheduler.test.ts`: delete the entire `describe('canSchedule', …)` block (lines 36–169) and the `canSchedule` import (line 3); keep `isActivePhase` and `byPriority` tests. If `resolveFlow`/`makeProject` imports become unused, trim them.
3. `session.ts:307`: `const phase = signal?.aborted ? 'Failed' : 'Failed';` → `const phase = 'Failed';` (keep the log at 308–312 distinguishing aborted vs timeout).

**Acceptance:** `pnpm typecheck` + `pnpm test` pass; grep `canSchedule` → only documentation/none.

### BUILD D — memory-service: delete drizzle layer + `getEmbeddings`

Files: `packages/memory-service/src/schema.ts` (delete), `packages/memory-service/src/db.ts`, `packages/memory-service/src/routes.ts`, `packages/memory-service/src/embed.ts`, `packages/memory-service/src/__tests__/embed.test.ts`, `packages/memory-service/src/__tests__/shared-mocks.ts`, `packages/memory-service/package.json`, `pnpm-lock.yaml`.

1. Delete `src/schema.ts`.
2. `db.ts`: drop the drizzle instance — remove `drizzle` import, `* as schema` import, `_db` singleton, and the `drizzle({…})` call in `getDb()`; keep `Database`/`loadVecExtension`/`vecUnavailableReason`. Rename/rework so `getRawDb()` initializes `_raw` directly (it currently delegates to `getDb()`); remove the `getDb` export. Keep the rich sqlite-vec load-failure diagnostics (loadVecExtension + comment).
3. `routes.ts:396` (`handleHealth`): `getDb()` → `getRawDb()`; drop `getDb` from the import at line 2.
4. `embed.ts`: delete `getEmbeddings` (25–41); keep `getEmbedding`.
5. `embed.test.ts`: remove the `describe('getEmbeddings', …)` block; keep `getEmbedding` tests.
6. `shared-mocks.ts`: remove `getEmbeddings` from the `mock.module('../embed.js', …)` stub.
7. `package.json`: remove `"drizzle-orm": "0.45.2"` from dependencies; run `pnpm install` to update `pnpm-lock.yaml` (lockfile diff limited to the removed dep; web/manager still use drizzle so no transitive removals beyond it).
8. Grep-verify: `getDb` (memory-service), `getEmbeddings`, `schema.js` imports gone.

**Acceptance:** `pnpm typecheck` + `pnpm test` pass inside `@percussionist/memory-service`; `initDb()` raw DDL (`DEFAULT (datetime('now'))`) unchanged.

### BUILD E — Web client: dead mutations + legacy notification prefs

Files: `packages/web/src/client/components/BoardView.tsx`, `packages/web/src/client/lib/notifications.ts`.

1. `BoardView.tsx`:
   - Delete `_deleteMutation`, `_retryMutation`, `_approveMutation`, `_requestChangesMutation` (99–122).
   - Delete `invalidateBoard` (97) — verify no other references in the file (currently only the four mutations use it).
   - Remove `useMutation` from the `@tanstack/react-query` import (line 1) and `approveTask`, `deleteBoardTask`, `requestChangesTask`, `retryEscalatedTask` from the `../lib/api` import (lines 7–13). Keep `useQuery`/`useQueryClient` and `fetchBoard` (used elsewhere in the file).
2. `notifications.ts`: delete `NotificationPreferences` interface, `getNotificationPreferences`, `setNotificationPreferences`, and the local `NOTIFICATION_PREFS_KEY` const (lines 14–44). Keep the `useNotificationStore` import (used by `notify()` at line 273).
3. Grep-verify: `getNotificationPreferences|setNotificationPreferences` → zero references; `BoardView.tsx` has no `_deleteMutation` etc.

**Acceptance:** `pnpm typecheck` + `pnpm test` + `pnpm lint` pass for `@percussionist/web`; web client builds (`pnpm build:client` / root `pnpm build`).

### BUILD F — Delete stale Dockerfile + fix scripts

Files: `images/manager/Dockerfile` (delete), `images/manager/` (dir), `scripts/ghcr-delete-tag.sh`, `scripts/ghcr-delete-package.sh`, `scripts/minikube-load.sh`.

1. Delete `images/manager/Dockerfile` and the now-empty `images/manager/` directory.
2. `scripts/ghcr-delete-tag.sh:10`: `IMAGES=(...)` → add `"runner-claude" "code-server"` (order: `runner runner-claude operator dispatcher manager web memory code-server`).
3. `scripts/ghcr-delete-package.sh:14`: `DEFAULT_PACKAGES=(...)` → add `"runner-claude" "code-server"` similarly.
4. `scripts/minikube-load.sh:266`: replace `echo ">> Building $tag${FORCE:+ (no-cache)}"` with an `if $FORCE; then echo ">> Building $tag (no-cache)"; else echo ">> Building $tag"; fi` (or equivalent truth-based test). Leave `build_one`'s `if $FORCE` gating (line 64) unchanged.
5. Grep-verify: `images/manager` → zero references; run `bash -n` on all three scripts.

**Acceptance:** `bash -n scripts/ghcr-delete-tag.sh scripts/ghcr-delete-package.sh scripts/minikube-load.sh` passes; `grep -rn "images/manager"` empty.

## Risks / open questions

1. **CRD schema removal vs live cluster.** Removing `status.column` from the CRD schema does not delete existing data — the field just stops being part of the schema and nothing reads it, so no functional impact. The new CRD YAML must be applied (`kubectl apply -f k8s/crds/`) at deploy time; that is deployment, not part of these BUILD tasks.
2. **`pnpm codegen` regenerates all 5 CRDs.** It rebuilds `@percussionist/api` first — if the build fails, codegen fails. Review the full diff: only `task.yaml` (BUILD A) and `project.yaml` (BUILD A's `facilitations` removal) should change. Any other CRD diff indicates an unexpected schema drift — stop and inspect.
3. **`FacilitationSpecSchema` must survive BUILD B.** It is imported by facilitator.ts, used by the Run CRD, and read by the operator. Only `FacilitationAction`/`FacilitationResultSchema`/`BoardStatus.facilitations` are dead. Keep `RUN_CONTEXT_VALUES['facilitator']` (buildgen runs set `successReview: false` and get runContext `facilitator` from pod-builder.ts:1083).
4. **`tools.ts` inspect_cr consumers.** The `column` field in `inspect_cr` output is cosmetic; switching it to `computeBoardColumn(...)` preserves agent-visible column info. If `computeBoardColumn` is not already imported in tools.ts, add it — verify no import cycle (it is a pure function in `@percussionist/api`).
5. **memory-service `getRawDb()` init refactor.** `getRawDb()` currently triggers init via `getDb()`; after the refactor it must self-initialize `_raw` (single code path). The `routes.test.ts` comment at line 34 references `getDb()` asserting DB init — the test only imports `getRawDb`/`vecUnavailableReason`, so behavior is preserved; update the comment if it becomes misleading.
6. **Zustand persist format (BUILD E).** The `percussionist:notifications` localStorage key is currently written by zustand persist only (the legacy functions have zero callers), so no corruption exists in the wild today. Deleting the legacy functions removes the future footgun; no migration needed. If a user's stored value is zustand-format, `getNotificationPreferences` (being deleted) was already misreading it — deleting is strictly an improvement.
7. **Script edits are untestable without GHCR/minikube.** `bash -n` syntax check plus the grep for the fixed arrays is the practical gate; run `./scripts/minikube-load.sh --help`-adjacent dry checks only if a cluster is available (not required for this task).
8. **Retry 2/3 context.** The previous attempt produced no plan artifact on this branch (verified: no rev22 file in `.percussionist/plans/`, no rev22 commit). This plan re-derives the full scope from the task description with fresh caller searches; all claims were re-verified during planning.

## Acceptance criteria

1. Grep-verifiable zero references (production + tests) for: `buildFacilitationRun`, `parseFacilitationResult`, `extractFacilitationJson`, `canSchedule` (manager-controller), `getEmbeddings` (memory-service), `getNotificationPreferences`, `setNotificationPreferences`, `FacilitationAction`, `FacilitationResultSchema`, `TaskColumn`, `images/manager`.
2. `k8s/crds/task.yaml` has no `Column` printer column and no `column` schema property; `k8s/crds/project.yaml` has no `facilitations`; other CRD YAML unchanged.
3. PLAN reviewer prompt no longer instructs reviewers to "Use escalate".
4. `scripts/ghcr-delete-*.sh` IMAGES/DEFAULT_PACKAGES include `runner-claude` and `code-server`; `minikube-load.sh` prints "(no-cache)" only with `--force`.
5. `images/manager/` directory removed.
6. `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` all pass on the merged result.
7. No change to live behavior: review/buildgen/merge flows, `FacilitationSpecSchema`, e2e `{.spec.facilitation.*}` assertions unaffected.

## Verification commands (per BUILD / final)

```bash
pnpm typecheck          # whole monorepo, topological
pnpm test               # unit + smoke suites (includes updated scheduler/embed tests)
pnpm lint               # Biome gate
pnpm build              # full build
pnpm codegen            # BUILD A — then git diff k8s/crds/
bash -n scripts/ghcr-delete-tag.sh scripts/ghcr-delete-package.sh scripts/minikube-load.sh
grep -rn "images/manager" . --include="*.sh" --include="*.yml" --include="*.md"   # expect empty
```
