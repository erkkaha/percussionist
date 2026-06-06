# Plan: Next steps for memory service usage

## Context

- The per-project memory service lives in `packages/memory-service` and exposes:
  - `POST /memory` (`handleStoreMemory` in `src/routes.ts`)
  - `POST /search` (`handleSearch`)
  - `POST /context` (`handleContext`)
- It stores plain-text memories in `memories` and vectors in `vec_memories` (sqlite-vec virtual table), with Ollama embeddings from `src/embed.ts`.
- Current manager usage in `packages/manager-controller` is narrow:
  1. **Prompt-time context injection** in `worker-builder.ts` via `getContext(project, query)`.
  2. **Post-run session summary storage** in `session-summarizer.ts` via `storeMemory(...)` with metadata `{ type: "session-summary", runName, sessionID }`.
  3. **Manual MCP access** through `store_memory`, `query_memory`, `get_context` in `src/agent/tools.ts`.
- The service is reconciled by the operator only when `Project.spec.embedding.enabled` is true (`packages/operator/src/memory-service.ts`, `reconciler.ts`).
- `percussionist-dev` currently has feature branching enabled in `k8s/self-dev/projects/percussionist-dev.yaml`, but no `spec.embedding` configured.

## Scope boundaries

### In scope
- Improve practical adoption and quality of memory usage in manager + memory-service paths.
- Focus on prompt relevance, data quality, observability, and operational enablement.
- Add explicit verification paths (tests and smoke checks) for memory-enabled projects.

### Out of scope
- Replacing sqlite-vec with another vector backend.
- Building a new user-facing memory browser UI in web (can be a follow-up).
- Changing core task lifecycle semantics unrelated to memory context.

## Assumptions

1. “Suggest next steps” means proposing an implementation roadmap (not implementing in this PLAN task).
2. We should target incremental BUILD tasks that can land independently and reduce risk.
3. Feature-branch workflow remains enabled and BUILD tasks should sequence where schema/contract dependencies exist.

## Approach

Use a phased hardening-and-adoption strategy:

1. **Make memory retrieval more useful and deterministic** (better metadata and filtering support).
2. **Increase high-value memory ingestion** (beyond only session summaries).
3. **Add observability/guardrails** so teams can trust memory behavior and debug failures quickly.
4. **Enable project-level adoption** (sample config + docs + validation checks).

This approach keeps each change small, measurable, and reversible.

## Acceptance criteria (for the overall initiative)

- Memory-enabled projects can verify memory health end-to-end (service up, embeddings generated, context returned).
- Retrieved context quality improves (fewer irrelevant snippets, more task/run-specific relevance).
- Memory usage is visible in logs/metrics (successful stores/searches, failure categories, latency insight).
- `percussionist-dev` (or a dedicated sample project) has a documented, reproducible memory-enabled setup.
- Regression coverage exists for at least one memory write+search flow and one manager integration flow.

## Proposed BUILD task breakdown

> Suggested order and dependencies are included; independent tasks can run in parallel where noted.

1. **Add metadata-aware retrieval contract to memory service**
   - **Goal:** Improve relevance by enabling optional filter semantics (e.g., type/run/task) in search/context APIs.
   - **Likely files:**
     - `packages/memory-service/src/routes.ts`
     - `packages/memory-service/src/schema.ts`
     - `packages/memory-service/src/index.ts`
     - `packages/memory-service/README.md`
   - **Deliverables:** API request shape supports metadata filter fields; filtering applied before final ranking/context formatting.
   - **Depends on:** none.

2. **Propagate filter-capable client APIs in manager controller**
   - **Goal:** Extend memory client wrappers so manager code can query scoped context intentionally.
   - **Likely files:**
     - `packages/manager-controller/src/agent/memory-client.ts`
     - `packages/manager-controller/src/agent/tools.ts`
   - **Deliverables:** `queryMemory/getContext` support optional filter args; MCP schemas updated accordingly.
   - **Depends on:** Task 1.

3. **Improve worker prompt context selection strategy**
   - **Goal:** Reduce noisy context injection by querying with richer intent and filters.
   - **Likely files:**
     - `packages/manager-controller/src/worker-builder.ts`
   - **Deliverables:** Query composition includes task type/title/description signals; optional filter use for PLAN vs BUILD contexts.
   - **Depends on:** Task 2.

4. **Expand memory ingestion beyond session summaries**
   - **Goal:** Persist additional high-signal artifacts (e.g., approved plan summaries, review verdict rationales, or merge outcomes).
   - **Likely files:**
     - `packages/manager-controller/src/reconciler/effects.ts`
     - `packages/manager-controller/src/reconciler/decision.ts`
     - `packages/manager-controller/src/session-summarizer.ts`
   - **Deliverables:** Additional `storeMemory` calls with clear metadata taxonomy (e.g., `type: plan-summary|review-verdict|merge-result`).
   - **Depends on:** Task 2.

5. **Add memory observability and failure telemetry**
   - **Goal:** Make memory failures discoverable and non-silent.
   - **Likely files:**
     - `packages/manager-controller/src/agent/memory-client.ts`
     - `packages/manager-controller/src/worker-builder.ts`
     - `packages/manager-controller/src/session-summarizer.ts`
     - optionally web stats ingestion paths if surfaced in API
   - **Deliverables:** structured log events for memory operations (success/fail + reason + latency buckets), without breaking runs.
   - **Depends on:** can run in parallel with Tasks 3–4 after Task 2.

6. **Enable and document memory usage for self-dev project**
   - **Goal:** Ensure the team can dogfood memory features continuously.
   - **Likely files:**
     - `k8s/self-dev/projects/percussionist-dev.yaml`
     - `README.md`
     - `AGENTS.md`
   - **Deliverables:** explicit `spec.embedding` block, prerequisite notes for Ollama model availability, and validation steps.
   - **Depends on:** none (can happen early), but best finalized after Tasks 1–5 behavior is stable.

7. **Add targeted tests and smoke validation path**
   - **Goal:** Prevent regressions in memory routes and manager integration.
   - **Likely files:**
     - `packages/manager-controller/src/reconciler/__tests__/*` (new/updated)
     - `packages/memory-service` test location (new test harness if missing)
     - docs for smoke command sequence
   - **Deliverables:** automated checks for (a) store/search/context behavior and (b) manager prompt-injection behavior when memory is enabled/unavailable.
   - **Depends on:** Tasks 1–4.

## Risks / open questions

1. **Dimension mismatch risk:** `EmbeddingSpecSchema` allows configurable `dimensions`, but `vec_memories` is hardcoded as `float[768]` in `memory-service/src/routes.ts`. Decide whether to enforce 768 or make table dimensions dynamic/migration-safe.
2. **Row mapping correctness/perf:** `handleStoreMemory` inserts into `vec_memories` with `rowid` bound as `null`, and `handleSearch` does extra per-row lookups. Verify rowid consistency and optimize joins/mapping before scaling memory volume.
3. **Silent failure behavior:** `worker-builder.ts` and `session-summarizer.ts` swallow memory errors intentionally. Need policy on when to surface warnings in task status vs logs only.
4. **Metadata schema governance:** define a stable metadata taxonomy (`type`, `task`, `runName`, `sessionID`, `agent`, etc.) so retrieval filters remain consistent across producers.
5. **Operational dependency:** memory quality depends on Ollama availability/model pull. Need explicit readiness checks and troubleshooting guidance for self-dev and production-like clusters.

## Recommended implementation sequencing

1. Contract + client upgrades (Tasks 1–2)
2. Retrieval quality improvements (Task 3)
3. Ingestion expansion + telemetry (Tasks 4–5)
4. Project enablement + docs (Task 6)
5. Test hardening (Task 7)

This sequence minimizes rework by stabilizing API/contracts first, then building behavior on top.
