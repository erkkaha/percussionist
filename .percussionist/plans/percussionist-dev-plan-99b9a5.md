# Plan: Ensure embedding model is pulled before memory service serves requests

## Context

Current behavior allows the per-project memory service to start serving immediately, but it does not verify or provision the Ollama embedding model first.

- `packages/memory-service/src/embed.ts` calls Ollama `/api/embeddings` and `/api/embed` directly with `EMBEDDING_MODEL` (default `nomic-embed-text`). If the model is missing, Ollama returns an error (currently observed as 404) and `store_memory` / `query_memory` fail.
- `packages/memory-service/src/index.ts` only initializes SQLite and starts `Bun.serve(...)`; there is no startup warm-up for model availability.
- `packages/memory-service/src/routes.ts` health check (`handleHealth`) currently validates DB initialization only, not embedding readiness.
- Operator deployment rendering in `packages/operator/src/memory-service.ts` sets env and a readiness probe to `/health`, but `/health` currently returns `{ ok: true }` even when model is missing.
- `k8s/deploy/ollama.yaml`, `README.md`, and `AGENTS.md` currently document a manual prerequisite: run `ollama pull nomic-embed-text`.

This explains the reported first-use failure: the memory service can be Ready while embeddings are not actually usable.

## Scope boundaries

### In scope

- Memory service startup/readiness behavior (`packages/memory-service/src/**`).
- Memory service deployment probe/env behavior if needed (`packages/operator/src/memory-service.ts`).
- Docs that currently require manual pull (`k8s/deploy/ollama.yaml`, `README.md`, `AGENTS.md`).
- Tests for new startup/readiness logic in memory-service package.

### Out of scope

- Re-architecting Ollama deployment into per-project instances.
- Changing MCP tool contracts in manager-controller.
- Adding cluster-wide job orchestration unrelated to memory service lifecycle.

## Approach

Use **memory-service-managed model warmup** as the primary fix, with readiness gated on successful warmup:

1. On memory service startup, ensure `EMBEDDING_MODEL` is present in Ollama.
   - First check via Ollama tags endpoint.
   - If missing, call Ollama pull API (`POST /api/pull`) and wait for completion.
   - Retry with bounded backoff for transient startup races (Ollama not ready yet).
2. Keep the service unready until model warmup succeeds.
   - Update health/readiness path to report not-ready when model state is not ready.
   - Kubernetes readiness probe already points at `/health`, so no traffic is sent before model availability.
3. Add clear observability and fail-fast behavior.
   - Structured logs for check/pull/retry success/failure.
   - Explicit error details when warmup fails after retries.
4. Make behavior configurable but safe by default.
   - Default to auto-pull enabled.
   - Optional env escape hatch to disable auto-pull in controlled environments.

Why this over init-container-only:
- Init containers in the memory pod cannot reliably run `ollama pull` without extra tooling assumptions (CLI + remote host semantics).
- In-process warmup uses the same HTTP API path the service already depends on, reducing image/runtime coupling and working regardless of how Ollama is deployed.

## Acceptance criteria

1. Creating/enabling a project with `spec.embedding.enabled: true` does **not** require manual `kubectl exec ... ollama pull ...` before memory APIs work.
2. Before model availability, memory service readiness remains false (pod not ready / service endpoint withheld).
3. After warmup succeeds, `POST /memory`, `POST /search`, and `POST /context` succeed for valid requests.
4. Transient Ollama startup races are retried automatically; failures surface clear logs/errors.
5. Tests cover model-availability checks and pull flow (success + failure paths).
6. Docs no longer imply manual pull is always required for normal operation.

## Tasks

1. **Add model warmup module in memory service**
   - Create a dedicated utility (e.g. `packages/memory-service/src/model-warmup.ts`) responsible for:
     - Checking model presence (Ollama tags API).
     - Triggering pull when absent (`/api/pull`, streamed completion handling).
     - Retrying with timeout/backoff.
   - Keep it independent from route handlers for testability.

2. **Introduce startup initialization flow before serving HTTP**
   - Update `packages/memory-service/src/index.ts` to run DB init + model warmup before `Bun.serve(...)` (or serve immediately but report not-ready until warmup complete).
   - Ensure initialization failures are explicit (non-zero exit or persistent unready state per chosen behavior).

3. **Gate health/readiness on embedding readiness**
   - Update `packages/memory-service/src/routes.ts` (`handleHealth`) to include model readiness checks/state.
   - Preserve existing DB health semantics while extending response contract (e.g. include readiness details).

4. **Add optional env controls and defaults**
   - Define env vars in memory-service for behavior control (examples: auto-pull toggle, warmup timeout/retries).
   - Ensure default path is “auto-pull enabled.”
   - Reflect env wiring expectations in `packages/operator/src/memory-service.ts` if any new vars need explicit injection.

5. **Review and tune readiness probe behavior in operator renderer**
   - Validate current probe settings in `packages/operator/src/memory-service.ts` against potential model download times.
   - If needed, tune `initialDelaySeconds` / `failureThreshold` / `periodSeconds` so long pulls do not flap readiness.

6. **Add automated tests for warmup logic**
   - Add tests in `packages/memory-service/src/__tests__/` for:
     - model already present (no pull),
     - model missing then pull succeeds,
     - pull failure / timeout,
     - transient Ollama unavailable then retry success.
   - Use fetch mocking patterns consistent with Bun tests.

7. **Update docs and operational guidance**
   - Update:
     - `k8s/deploy/ollama.yaml` comments,
     - memory-related sections in `README.md`,
     - memory-related sections in `AGENTS.md`.
   - Reframe manual `ollama pull` as optional pre-warm optimization rather than hard prerequisite.

8. **Verification plan for implementation PR**
   - Run package-level tests (`bun test` in memory-service or monorepo equivalent).
   - Validate type/build checks (`pnpm typecheck`, relevant build).
   - Manual cluster smoke path:
     1. Deploy Ollama + operator/manager/web.
     2. Enable embedding on a test project with default model.
     3. Observe memory pod starts unready, performs pull, becomes ready.
     4. Confirm `store_memory` and `query_memory` succeed without manual pull.

## Proposed BUILD task breakdown

1. **BUILD A — Warmup + readiness core**
   - Implement model warmup module, startup integration, and readiness gating in memory-service.
   - Deliver logs/errors and default auto-pull behavior.

2. **BUILD B — Operator probe tuning + test coverage**
   - Adjust memory-service readiness probe settings if needed.
   - Add/expand Bun tests for warmup and health behavior.

3. **BUILD C — Docs + smoke verification**
   - Update docs to match new automated behavior.
   - Execute verification checklist and capture evidence in task notes.

## Risks / open questions

1. **Ollama pull API semantics**
   - Need to confirm exact streamed response contract from `/api/pull` in this environment and robust completion detection criteria.

2. **Large model download time vs readiness expectations**
   - First pull can be slow; probe tuning and retry windows must avoid premature failure loops.

3. **Concurrent project startups**
   - Multiple memory services may try to pull the same model simultaneously. Confirm Ollama handles this safely/deduplicates downloads; if not, add client-side mitigation (e.g. serialized retries/backoff).

4. **Custom models via `spec.embedding.model`**
   - Ensure warmup logic is model-agnostic and handles non-default model names equally.

5. **Failure policy choice**
   - Decide whether unrecoverable warmup failure should crash the process (restart loop) or keep process alive but permanently unready; implementation should choose one explicit policy and document it.
