# Plan: Verify and fix session summarization pipeline for buildgen context injection

## Context

- The buildgen prompt is assembled in `packages/manager-controller/src/facilitator.ts` via `buildBuildTaskGeneratorRun(...)`.
  - It injects `PLAN SESSION CONTEXT` from `actualSummary`.
  - `actualSummary` is chosen as `sessionSummary arg -> readStoredSessionSummary(...) -> ""`.
  - `readStoredSessionSummary` reads `summary-*` keys from `${runName}-session` ConfigMap.
- Summarization is produced in `packages/manager-controller/src/session-summarizer.ts`:
  - Reads snapshot using `readSessionConfigMap(runName, sessionID, namespace)`.
  - Summarizes with manager-side LLM session (`createSession/sendPrompt/waitForCompletion`), not Ollama.
  - Stores `summary-{sessionID}` in `${runName}-session` ConfigMap.
  - Best-effort stores same content to memory service via `storeMemory(..., { type: "session-summary", runName, sessionID })`.
- Summarization is scheduled by reconciler decision logic in `packages/manager-controller/src/reconciler/decision.ts` (`summarizeEffect`) and launched fire-and-forget in `packages/manager-controller/src/reconciler/effects.ts`.
- Dispatcher snapshot writer (`packages/dispatcher/src/polling.ts`) writes `messages-{sessionID}.json` entries to `${runName}-session`; summarizer depends on these entries existing.
- Critical finding from repo config: `k8s/self-dev/projects/percussionist-dev.yaml` does **not** enable `spec.embedding.enabled`, while current `summarizeEffect` exits early when embedding is disabled. This is the primary reason summaries are often never attempted in self-dev runs.

## Scope boundaries

### In scope
- Reconciler trigger conditions for `SummarizeSession`.
- Summarizer reliability (snapshot timing), persistence behavior, and observability.
- Buildgen summary-source selection/logging in `buildBuildTaskGeneratorRun`.
- Memory-service failure handling as non-fatal behavior.
- Unit/integration-style tests in manager-controller and memory-service where applicable.

### Out of scope
- Redesigning facilitator/buildgen prompt structure beyond summary-source correctness.
- Reducing token usage from plan artifact/body duplication globally.
- Cluster-level remediation (bringing Ollama/memory pods up) beyond graceful degradation in code.

## Approach

1. **Decouple summary generation from embedding.**
   Generate ConfigMap session summaries for completed worker runs regardless of memory-service enablement.

2. **Treat vector memory as optional sink.**
   Keep memory write best-effort; if memory service or Ollama is unavailable, do not block or fail summarization pipeline.

3. **Make the pipeline observable end-to-end.**
   Add explicit, contextual logs for dispatch, retries, success, and each failure class (snapshot unavailable, LLM summarize failure, ConfigMap write failure, memory write failure).

4. **Harden race-prone snapshot read path.**
   Add bounded retry/backoff when snapshot ConfigMap is not ready yet.

5. **Verify buildgen consumes summary-only context path.**
   Keep current design (summary string, not raw session fetch), but add source-selection logs/tests so behavior is explicit and regression-proof.

## Implementation tasks

1. **Fix summary trigger gating in decision engine** (`packages/manager-controller/src/reconciler/decision.ts`)
   1.1 Remove `project.spec.embedding?.enabled` guard from `summarizeEffect`.
   1.2 Keep guard on missing `run.status.sessionID`.
   1.3 Add inline comment documenting that ConfigMap summary generation is independent of vector-memory storage.
   1.4 Extend `reconciler/__tests__/decision.test.ts` with cases proving `SummarizeSession` appears for succeeded/failed worker runs even when embedding is not configured.

2. **Improve fire-and-forget effect observability** (`packages/manager-controller/src/reconciler/effects.ts`)
   2.1 Log `SummarizeSession` dispatch with `project/runName/sessionID`.
   2.2 Replace silent import/execute catch with warning/error logs that include the same identifiers.
   2.3 Preserve non-blocking behavior (reconcile must never fail due to summarization sidecar work).

3. **Add retry/backoff for missing snapshot ConfigMap data** (`packages/manager-controller/src/session-summarizer.ts`)
   3.1 Wrap `readSessionConfigMap` in bounded retry loop (e.g., short exponential backoff + max attempts/time budget).
   3.2 Log each retry attempt and terminal skip cause when snapshot never appears.
   3.3 Keep idempotency check (`summary-{sessionID}` exists -> exit) before expensive operations.

4. **Correct persistence and logging semantics in summarizer** (`packages/manager-controller/src/session-summarizer.ts`)
   4.1 Only emit “stored summary” log after successful ConfigMap patch.
   4.2 Log ConfigMap patch failures explicitly (do not silently swallow).
   4.3 Include summary size/truncation metadata in success logs.
   4.4 Keep outer try/catch, but ensure caught errors are contextualized (project/run/session).

5. **Graceful degradation when memory/Ollama path is unavailable** (`packages/manager-controller/src/session-summarizer.ts`, `packages/manager-controller/src/agent/memory-client.ts`)
   5.1 Keep summary generation path unchanged (manager LLM via opencode).
   5.2 Leave memory persistence non-fatal.
   5.3 Replace `storeMemory(...).catch(() => {})` with logged warning containing run/session/project and error message.
   5.4 Do **not** add alternate summarization provider in this iteration; explicit skip+log is preferred over hidden fallback complexity.

6. **Verify buildgen summary injection behavior and make source explicit** (`packages/manager-controller/src/facilitator.ts`)
   6.1 Preserve precedence: explicit arg, then stored ConfigMap summary, else none.
   6.2 Add informational log for selected source (`arg|configmap|none`) and summary length.
   6.3 Confirm no raw session fetch fallback is introduced in `buildBuildTaskGeneratorRun`.
   6.4 Add unit tests for source selection and prompt block content (`PLAN SESSION CONTEXT`).

7. **Test coverage for failure modes and regressions**
   7.1 Add summarizer tests for: snapshot initially missing then available; summarize succeeds; summary key persisted.
   7.2 Add summarizer tests for ConfigMap patch failure: warning emitted, no false success log.
   7.3 Add summarizer tests for memory write failure: warning emitted, main summarization still considered successful.
   7.4 Ensure existing memory-service route tests still validate metadata storage behavior, and extend only if needed for `session-summary` metadata assertions.

8. **Manual verification runbook (for BUILD validation/PR notes)**
   8.1 Complete a PLAN run and confirm manager logs show summarize dispatch + result.
   8.2 Verify `${runName}-session` contains `summary-{sessionID}`.
   8.3 Approve PLAN and inspect generated buildgen run input to confirm summary is used (and source logged).
   8.4 Simulate memory-service outage and verify: ConfigMap summary still written; warnings present; no reconcile failure.

## Acceptance criteria

- `SummarizeSession` effects are emitted for completed worker runs even when `spec.embedding.enabled` is false/absent.
- Manager logs clearly expose summarization lifecycle: dispatch, snapshot retries, summarize result, ConfigMap write result, memory-store result.
- Successful runs persist `summary-{sessionID}` in `${runName}-session` ConfigMap.
- `buildBuildTaskGeneratorRun` uses summary source precedence (`arg -> configmap -> none`) and does not read/inject raw session dumps.
- Memory-service/Ollama failures do not break reconcile flow or buildgen scheduling; they produce visible warnings.
- New tests cover trigger conditions, race retries, persistence behavior, and failure observability.

## Risks / open questions

- **Race tuning risk:** retry window too short may still miss late snapshots; too long may create noisy background churn.
- **Token-cost ambiguity:** even with fixed summary injection, token spikes may persist due to large `PLAN DESCRIPTION` and `PLAN ARTIFACT CONTENT` blocks.
- **Logging volume:** additional logs must be concise and structured enough for grepability without flooding.
- **Open question:** should buildgen optionally wait briefly for summary availability before falling back to `(none available)`?
- **Open question:** should a hard max-length cap be enforced for `PLAN SESSION CONTEXT` as defense-in-depth even after summarization?

## Proposed BUILD task breakdown

1. **BUILD 1 (high):** Remove embedding-gated trigger; add reconciler decision tests for summary effect emission.
2. **BUILD 2 (high, depends on 1):** Add summarizer snapshot retry/backoff + contextual logging + correct ConfigMap write semantics.
3. **BUILD 3 (medium, parallel to 2):** Improve `SummarizeSession` fire-and-forget dispatch/import error logging in `effects.ts`.
4. **BUILD 4 (high, depends on 2):** Add buildgen summary-source logging and facilitator unit tests for source precedence/prompt content.
5. **BUILD 5 (medium, depends on 2):** Add memory-write failure observability and tests ensuring non-fatal degradation.
6. **BUILD 6 (medium, depends on 2/4/5):** Execute manual verification runbook and document measured outcomes.

## Assumptions

- Intended behavior is summary-first buildgen context injection independent of vector-memory feature flags.
- Existing manager-side summarization model (`manager-decision` via opencode) remains the only summarization provider for now.
- This plan addresses reliability and observability, not broader prompt/token-budget redesign.
