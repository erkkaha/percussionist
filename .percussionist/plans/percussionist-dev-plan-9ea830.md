# Plan: manager agent cost tracking (synthetic `manager run`)

## Context

- Manager-side agent traffic goes through `packages/manager-controller/src/agent/session.ts` (`createSession`, `sendPrompt`/`sendMessage`, `getMessages`, `waitForCompletion`) against the local opencode sidecar (`AGENT_OPENCODE_URL`, default `http://127.0.0.1:4096`).
- The manager currently polls OpenCode messages in `waitForCompletion()` but does **not** report those sessions to web stats.
- The existing stats ingestion contract already supports both incremental and final flushes:
  - `PATCH /api/stats/session` for incremental updates,
  - `POST /api/stats/session` for full upsert/final state,
  implemented in `packages/web/src/server/routes/stats.ts`.
- Dispatcher already has robust payload construction for messages/tool calls/file ops in `packages/dispatcher/src/stats-reporter.ts`; manager can mirror this pattern instead of inventing a new schema.
- Manager already has web URL/auth env wiring for server-to-server calls via `WEB_SERVICE_URL` and `WEB_AUTH_TOKEN` (`packages/manager-controller/src/events.ts`, deployment env in `k8s/deploy/manager-controller.yaml`).
- Stats UI agent grouping uses `runs.agent` (`packages/web/src/server/routes/stats.ts`, `packages/web/src/client/components/StatsView.tsx`). Setting `run.agent = "manager run"` is sufficient for visibility under **Stats → Agents**.

## Scope boundaries

### In scope

- Add manager-side stats flushing for opencode sessions used by manager agent logic.
- Send incremental (`PATCH`) and final/full (`POST`) payloads to `/api/stats/session` using existing contract.
- Tag all manager-reported sessions with synthetic agent label `manager run`.
- Ensure reporting is best-effort/non-fatal (manager behavior must not break if web stats is down).
- Cover payload/reporting behavior with focused tests in `@percussionist/manager`.

### Out of scope

- Web DB schema/API changes.
- StatsView UI changes.
- Reworking dispatcher stats reporting implementation.
- Historical backfill/migration of previously untracked manager sessions.

## Assumptions

1. “Synthetic agent: manager run” means setting `run.agent` to the literal `manager run` for manager-emitted stats rows.
2. It is acceptable for manager sessions to appear as synthetic runs in `runs` table with manager-specific names (not Task/Run CR names).
3. Manager session tracking should include at least interactive chat sessions (`agent/chat-handler.ts`) and summarizer sessions (`session-summarizer.ts`), both of which flow through `waitForCompletion()`.

## Approach

1. **Introduce a manager-local stats reporter module** in `packages/manager-controller/src/agent/` modeled after dispatcher `stats-reporter.ts`:
   - convert polled OpenCode messages into `messages/toolCalls/fileOps` payloads,
   - compute token/cost totals from message metadata,
   - call web `PATCH` and `POST` endpoints with auth header when available.
2. **Hook reporting into the polling loop** in `waitForCompletion()` so each polling iteration can flush newly seen messages incrementally.
3. **Finalize each `waitForCompletion()` execution** with a full `POST` using terminal phase (`Succeeded` on completed assistant turn; `Failed` on timeout/error/cancel), without throwing reporting errors.
4. **Stamp synthetic manager metadata** on all manager stats writes:
   - `run.agent = "manager run"`
   - manager-specific run name/namespace conventions (deterministic and session-stable).
5. **Keep runtime safe** by treating all stats I/O as fire-and-forget/best-effort: logging only, no control-flow impact on agent responses.

## Tasks

1. **Define manager stats constants and metadata mapping**
   - Files: `packages/manager-controller/src/agent/config.ts`, `packages/manager-controller/src/agent/session.ts` (or new reporter module)
   - Add/derive reporter config from:
     - `WEB_SERVICE_URL` (fallback to in-cluster percussionist-web URL),
     - `WEB_AUTH_TOKEN`,
     - namespace (`PERCUSSIONIST_NAMESPACE`).
   - Define synthetic agent constant: `manager run`.
   - Decide run naming strategy (e.g. `manager-session-${sessionId}` or title-based + session id) and keep it stable per session.

2. **Create manager stats reporter module**
   - New file candidate: `packages/manager-controller/src/agent/stats-reporter.ts`
   - Implement:
     - payload builders for messages/toolCalls/fileOps compatible with `SessionPayload` expected by web stats routes,
     - helper to extract totals (`tokensIn`, `tokensOut`, `cost`) from polled messages,
     - `incrementalFlushManagerSession(...)` → `PATCH /api/stats/session`,
     - `sendManagerSessionStats(...)` → `POST /api/stats/session`.
   - Preserve idempotency semantics similar to dispatcher implementation (cursor-based incremental flush + full flush overwrite safety).

3. **Expand session message typing for payload extraction**
   - File: `packages/manager-controller/src/agent/session.ts`
   - Broaden `SessionMessage.parts` typing from text-only to include tool-related/message-part variants used by payload builder.
   - Ensure parsing remains tolerant to unknown parts (`unknown`-safe guards).

4. **Wire incremental flush into `waitForCompletion()` polling**
   - File: `packages/manager-controller/src/agent/session.ts`
   - Track message cursor (`fromIdx`) and call manager reporter after polling `getMessages(sessionId)`.
   - Flush only when new messages exist, carrying synthetic run metadata and current totals.
   - Keep loop behavior unchanged for completion detection and timeouts.

5. **Wire final/full flush on terminal outcomes**
   - File: `packages/manager-controller/src/agent/session.ts`
   - On each terminal path of `waitForCompletion()` (success, timeout, aborted, error), issue `POST /api/stats/session` with:
     - stable `sessionID`,
     - terminal phase (`Succeeded` / `Failed`),
     - started/completed timestamps,
     - aggregate tokens/cost.
   - Ensure failures in stats flush are swallowed + logged.

6. **Ensure coverage for all manager agent flows using polling**
   - Files to verify: `packages/manager-controller/src/agent/chat-handler.ts`, `packages/manager-controller/src/session-summarizer.ts`
   - Confirm both paths rely on `waitForCompletion()` and therefore automatically emit stats.
   - If any flow bypasses `waitForCompletion()`, add explicit flush hook there.

7. **Add unit tests for manager stats reporting behavior**
   - New/updated test files under `packages/manager-controller/src/agent/__tests__/`.
   - Cover at minimum:
     - incremental flush issues `PATCH` with `run.agent = "manager run"`,
     - final flush issues `POST` with expected phase,
     - cursor/idempotency behavior for repeated polling,
     - non-fatal handling when web endpoint errors/timeouts.

8. **Add/adjust integration-adjacent tests if needed**
   - Candidate: tests around `waitForCompletion()` behavior (mock `getMessages` + mocked `fetch`) to verify flush call sequence without regressing response semantics.

9. **Validation commands for BUILD execution**
   - `pnpm --filter @percussionist/manager test`
   - `pnpm --filter @percussionist/manager typecheck`
   - Optionally repo-level verification if touched code crosses package boundaries.

## Acceptance criteria

1. Manager session polling emits incremental `PATCH /api/stats/session` updates during active manager-side sessions.
2. Manager session completion/termination emits full `POST /api/stats/session` updates.
3. Emitted rows are tagged with `agent = "manager run"` and appear under **Stats → Agents**.
4. Reporting failures (network/auth/web unavailable) do not break manager decision/chat/summarization flows.
5. Tests cover flush semantics (PATCH+POST, synthetic agent tag, idempotency/non-fatal behavior).

## Proposed BUILD task breakdown

1. **BUILD A — Manager stats reporter foundation**
   - Add reporter module + payload builders + config/constants.
   - Add base unit tests for payload shaping and synthetic metadata.

2. **BUILD B — Polling integration in `waitForCompletion()`**
   - Add incremental cursor flush + final flush wiring.
   - Preserve existing completion semantics and cancellation behavior.

3. **BUILD C — Test hardening + verification**
   - Expand tests for error handling/idempotency.
   - Run package test/typecheck and fix regressions.

## Risks / open questions

1. **Run identity granularity:** one persistent interactive session may aggregate many turns into one stats row (session-keyed). Confirm this is acceptable vs. per-turn synthetic runs.
2. **Phase semantics:** mapping timeout/cancel to `Failed` may impact success-rate charts; may need a dedicated non-failure phase convention later.
3. **Payload parity drift:** manager’s message format may diverge from dispatcher assumptions over time; payload builder should remain schema-tolerant and tested.
4. **Cost completeness:** cost may be absent on some messages/providers; totals should gracefully default and rely on available token fields.
