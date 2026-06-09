# Plan: Verify and fix session summarization pipeline for buildgen context injection

## Context

- Buildgen prompt assembly lives in `packages/manager-controller/src/facilitator.ts` (`buildBuildTaskGeneratorRun`). It currently injects:
  - `PLAN DESCRIPTION` from `planTask.spec.description`
  - `PLAN SESSION CONTEXT` from `actualSummary`
  - `PLAN ARTIFACT CONTENT` from `readPlanFromConfigMap(...)`
- `actualSummary` is currently derived as:
  - explicit function arg `sessionSummary` (currently always passed as `""` from reconciler effects), else
  - first `summary-*` key from `${succeededRunName}-session` ConfigMap.
- Session summarization is triggered via reconciler effect `SummarizeSession`:
  - Created in `packages/manager-controller/src/reconciler/decision.ts` (`summarizeEffect`)
  - Executed fire-and-forget in `packages/manager-controller/src/reconciler/effects.ts`
- The summarizer implementation is in `packages/manager-controller/src/session-summarizer.ts`:
  - Reads snapshot via `readSessionConfigMap(runName, sessionID, ns)`
  - Generates 2–3 paragraph summary through opencode (`createSession` + `sendPrompt` + `waitForCompletion`)
  - Writes `summary-{sessionID}` into `${runName}-session` ConfigMap
  - Stores same summary to memory service via `storeMemory(...)` with metadata `{ type: "session-summary", runName, sessionID }`
- Snapshot source is dispatcher (`packages/dispatcher/src/polling.ts`), which writes `sessions.json` + `messages-{sessionID}.json` to `${runName}-session` ConfigMap during/at end of run.

## Key findings to address

1. **Summarization is incorrectly gated behind embedding enablement.**
   - `summarizeEffect` returns undefined unless `project.spec.embedding?.enabled` is true.
   - This couples buildgen summary generation to vector-memory availability, even though ConfigMap summary injection should work independently.

2. **Summarization can race with snapshot availability and then never retry.**
   - If `readSessionConfigMap(...)` returns null once, summarizer logs and returns permanently.
   - No retry/backoff path exists.

3. **Failure visibility is weak (silent/best-effort paths).**
   - `SummarizeSession` effect import/execute path swallows errors (`catch(() => {})`).
   - ConfigMap patch failures are swallowed; code still logs `stored summary...` even if patch failed.
   - `storeMemory(...).catch(() => {})` suppresses diagnostics.

4. **Buildgen has no explicit fallback strategy when summary is missing.**
   - It currently inserts `(none available — use the task description above)`.
   - If plan descriptions are verbose, buildgen token usage remains high.

5. **No focused tests cover this pipeline end-to-end at unit level.**
   - Existing reconciler tests do not validate summary effect scheduling/behavior details.

## Scope boundaries

- In scope:
  - Manager-controller summarization trigger/execution/logging paths
  - Buildgen summary retrieval/injection behavior
  - Memory storage observability for session summaries
  - Deterministic tests for summarization-trigger and prompt-injection logic
- Out of scope:
  - Reworking general prompt architecture or reducing plan artifact verbosity globally
  - Redesigning memory-service schema/vector indexing beyond what is needed for observability and summary writes
  - Cluster deployment/infra fixes (e.g., bringing up Ollama) beyond graceful degradation behavior in code

## Approach

1. **Decouple summary generation from embedding service enablement.**
   - Trigger ConfigMap summary generation for completed worker runs regardless of `embedding.enabled`.
   - Keep vector-memory write as optional best-effort side effect.

2. **Make summarization resilient to eventual consistency.**
   - Add bounded retry/backoff when session snapshot is not yet present.
   - Ensure manager logs explicitly show retry attempts and final outcome.

3. **Make all failure modes visible in manager logs.**
   - Replace silent catches with structured warn/error logs (run/task/session identifiers included).
   - Differentiate: snapshot missing, LLM summarize failure, ConfigMap patch failure, memory-store failure.

4. **Clarify buildgen context precedence and fallback.**
   - Keep summary preferred when present.
   - Add explicit logging/annotation in prompt construction path indicating whether source is: provided summary, stored summary, or none.
   - Avoid re-introducing raw full session ingestion into buildgen prompt.

5. **Add deterministic tests and verification hooks.**
   - Unit tests for summarization effect emission and buildgen summary selection behavior.
   - Targeted tests around retry and graceful degradation semantics.

## Implementation tasks

1. **Audit and update summarize trigger conditions** (`packages/manager-controller/src/reconciler/decision.ts`)
   1.1. Refactor `summarizeEffect(...)` so summary generation is not blocked by `project.spec.embedding?.enabled`.
   1.2. Keep sessionID requirement intact; add explicit comment documenting why summary generation is independent of vector memory.
   1.3. Add/adjust unit tests in `reconciler/__tests__/decision.test.ts` to assert effect presence for completed runs even when embedding is disabled.

2. **Harden SummarizeSession effect execution logging** (`packages/manager-controller/src/reconciler/effects.ts`)
   2.1. Replace silent `catch(() => {})` on dynamic import/execution with warning logs containing effect payload (`project`, `runName`, `sessionID`).
   2.2. Log when fire-and-forget summarization is dispatched (debug/info level).
   2.3. Ensure this remains non-blocking to reconcile loop.

3. **Add snapshot-availability retry/backoff in summarizer** (`packages/manager-controller/src/session-summarizer.ts`)
   3.1. Introduce bounded retry loop for `readSessionConfigMap(...)` misses (e.g., short exponential backoff, total cap).
   3.2. Log each retry and terminal skip reason.
   3.3. Preserve idempotency: if `summary-{sessionID}` already exists, exit quickly.

4. **Fix misleading success logging and expose write failures** (`packages/manager-controller/src/session-summarizer.ts`)
   4.1. Only log `stored summary` after confirmed ConfigMap write success.
   4.2. On ConfigMap patch failure, emit explicit warning with error message and return/mark as non-persisted.
   4.3. Add log fields for summary length and truncation behavior.

5. **Graceful degradation for memory service / Ollama outages** (`packages/manager-controller/src/session-summarizer.ts`, `agent/memory-client.ts`)
   5.1. Keep summary generation via manager LLM path as primary (no Ollama dependency).
   5.2. Treat `storeMemory(...)` failure as non-fatal, but log warning with project/run/session context and error text.
   5.3. Do not add alternate summary provider in this pass unless existing provider is unavailable; if provider unavailable, skip with explicit logs rather than silent fail.

6. **Strengthen buildgen context-source handling** (`packages/manager-controller/src/facilitator.ts`)
   6.1. Keep `readStoredSessionSummary(...)` as preferred fallback when explicit summary arg is empty.
   6.2. Add manager logs indicating selected summary source (`arg`, `configmap`, or `none`) and size.
   6.3. Confirm prompt text continues to use summary-only context (no raw session fetch fallback).
   6.4. Add focused unit tests (new facilitator test file) for source selection and prompt inclusion behavior.

7. **Verification of summary persistence paths**
   7.1. Add a small debug/inspection helper path (or test fixture) to validate that summary keys are present in `${runName}-session` ConfigMap data under `summary-{sessionID}`.
   7.2. Add verification step for memory payload metadata `{ type: "session-summary", runName, sessionID }` being passed to `storeMemory`.
   7.3. Document operational verification commands (manager logs + ConfigMap inspect + memory `/search`/DB check) in PR notes or inline comments.

8. **Regression tests for non-silent failures and retries**
   8.1. Add tests around summarizer behavior when snapshot initially missing then appears.
   8.2. Add tests for ConfigMap patch failure path (warns, does not falsely report success).
   8.3. Add tests for memory service failure path (warns, still succeeds overall if ConfigMap summary write succeeded).

9. **End-to-end acceptance verification (manual/dev cluster runbook)**
   9.1. Run a PLAN task to completion and confirm manager logs show `SummarizeSession` dispatch and result.
   9.2. Verify `${run}-session` contains `summary-{sessionID}`.
   9.3. Trigger PLAN approval/buildgen and confirm buildgen prompt uses summary source with reduced context size.
   9.4. Simulate memory service failure and confirm: summary still written to ConfigMap; buildgen still receives summary; warnings visible.

## Acceptance criteria

- For completed worker runs, summarization attempts occur even when `spec.embedding.enabled` is false.
- Manager logs contain explicit, searchable events for:
  - summarization dispatch
  - snapshot retry/timeout
  - summarization LLM success/failure
  - ConfigMap summary write success/failure
  - memory-store success/failure
- `summary-{sessionID}` appears in `${runName}-session` ConfigMap for successful summarizations.
- Buildgen (`buildBuildTaskGeneratorRun`) clearly prefers stored summary and does not inject raw full session text.
- When memory service/Ollama is unavailable, pipeline degrades gracefully (no crash, no silent fail): ConfigMap summary path remains functional and failures are logged.
- New/updated tests cover trigger conditions, fallback selection, and failure paths.

## Risks / open questions

- **Timing risk:** snapshot creation timing vs reconciler transition can still be tight; retry windows must be tuned to avoid long reconcile-side background churn.
- **Prompt-size ambiguity:** large token usage may also come from plan descriptions/artifact content, not only session context; improvements here may not fully solve token spikes.
- **Runtime observability tradeoff:** adding logs improves debugging but could increase log volume; need concise, structured messages.
- **Question:** should buildgen enforce a hard max length for `PLAN SESSION CONTEXT` even when summary exists (defense-in-depth cap)?
- **Question:** should missing summary block buildgen start briefly (wait-for-summary) or continue immediately with current fallback behavior?

## Proposed BUILD task breakdown

1. **BUILD A (high):** Decouple summary trigger from embedding flag and add reconciler tests.
2. **BUILD B (high, depends on A):** Implement summarizer retry/backoff + accurate logging for ConfigMap/LLM paths.
3. **BUILD C (medium, parallel with B):** Improve fire-and-forget effect logging and non-silent error propagation in `effects.ts`.
4. **BUILD D (high, depends on B):** Add buildgen summary-source logging + facilitator tests for summary selection.
5. **BUILD E (medium, depends on B):** Add graceful memory-store failure logging and tests.
6. **BUILD F (medium, depends on D/E):** Manual verification runbook + acceptance validation in dev cluster.

## Assumptions

- The intended product behavior is: buildgen context should use compact summary when available, independent of vector-memory enablement.
- Existing summarization via `manager-decision` agent remains the canonical summary-generation provider for this fix.
- This task focuses on reliability/observability and context-selection correctness, not a broader redesign of facilitator prompts.
