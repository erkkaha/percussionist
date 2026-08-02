# Plan: Operator crash-loops on a single bad Project CR; permanent Run validation errors retry silently forever

Task: `percussionist-dev-plan-rev03`

## Context

Two error-handling gaps in `packages/operator/src`, one critical and one high-severity.

### Gap 1 — crash loop on a single bad Project CR (critical)

- `packages/operator/src/index.ts:33-36` installs `process.on('unhandledRejection', ...)` which calls `process.exit(1)`.
- The Project informer callbacks (`index.ts:103-112`) and ClusterSettings informer callbacks (`index.ts:78-83`) invoke async reconcilers as fire-and-forget promises with **no `.catch`**:
  - `void reconcileProject(obj)` (add/update)
  - `void cleanupCodeServer(obj)` / `void cleanupMemoryService(obj)` (delete)
  - `void reconcileClusterSettings(obj)` (add/update)
- `reconcileProject` (`packages/operator/src/reconciler.ts:790-983`) **rethrows** non-404 errors from the code-server Deployment/Service upserts (`reconciler.ts:840-842`, `869-871`) and the memory-service upserts (`reconciler.ts:944-946`, `973-975`).
- `spec.codeServer.resources` is `x-kubernetes-preserve-unknown-fields: true` in the Project CRD (`k8s/crds/project.yaml`) and is passed **verbatim** into the Deployment container spec (`packages/operator/src/code-server.ts:86-89` → used at `code-server.ts:413`). `spec.embedding.resources` has the same passthrough (`memory-service.ts:58`, `133`).

Failure chain: a dashboard-editable value like `limits.memory: "banana"` → apiserver rejects the Deployment with 422 → `reconcileProject` throws → unhandled rejection → `process.exit(1)` → pod restarts → informer re-lists the same Project → exit again. **One bad Project CR stalls all Run reconciliation cluster-wide.** A transient apiserver 5xx during any project reconcile also restarts the operator.

The Run informer callbacks are safe (`enqueue`/`dequeue` are synchronous), and the informer `error` handlers already self-restart with a `.catch`.

### Gap 2 — permanent Run validation errors retry silently forever (high)

- `assertCredentialsUnambiguous` (`packages/operator/src/adapters/opencode-config.ts:42-56`) throws **by design** when a `claude`-engine Run sets both `spec.secrets.llmKeysSecret` and `spec.secrets.authSecret` (a permanent misconfiguration).
- It is called from `reconcile()` at `reconciler.ts:412-417`, outside any try/catch.
- The worker loop (`runWorker`, `reconciler.ts:757-767`) catches the throw, logs it, and re-enqueues the key after 5 s. `patchStatus` is never called, so `run.status.phase` stays unset.
- Result: the user sees a run stuck with no phase forever while the operator retries a permanent condition every 5 seconds (plus the 10 s periodic resync re-enqueueing it).

Relevant plumbing already in place:
- `patchStatus(run, {...})` (`reconciler.ts:80-96`) merge-patches the Run status subresource and never throws.
- `RunPhase.Failed` is in `TERMINAL_PHASES` (`packages/api/src/index.ts:745-749`), so once phase=Failed is patched, the terminal-phase guard at `reconciler.ts:382-398` short-circuits all future reconciles (and revokes the run key / cleans up any pod). For board-managed runs, the manager's existing retry/escalation logic picks up from the Failed status — which is the desired surfacing.

### Project status shape (for surfacing per-project errors)

- `ProjectStatusSchema` (`packages/api/src/index.ts:1234-1236`) currently only has `board` (owned by the manager).
- The Project CRD (`k8s/crds/project.yaml`) has a `status` subresource with a structural schema listing only `board` — unknown status fields would be **pruned**, so a new field must be added to the CRD schema.
- The web server reads only `project.status?.board` (`packages/web/src/server/routes/board.ts`, `findings.ts`), so adding a sibling status key is non-breaking.

## Approach

**Fix 1 (crash loop):**

1. **Backstop:** wrap every fire-and-forget informer callback in `index.ts` with `.catch(...)` that logs — `reconcileProject`, `reconcileClusterSettings`, `cleanupCodeServer`, `cleanupMemoryService`. No routine reconcile error may ever reach `unhandledRejection`. Keep the `unhandledRejection → exit(1)` handler itself: with catches in place, anything reaching it is a genuine bug and fail-fast remains correct.
2. **Surface errors into Project status:** add an operator-owned `status.reconcile` field to Project:
   - API: extend `ProjectStatusSchema` with `reconcile: z.object({ state: z.enum(['Ready', 'Error']), message: z.string().optional(), observedGeneration: z.number().int().optional() }).optional()`.
   - CRD: add the matching structural schema under `status.properties.reconcile` in `k8s/crds/project.yaml` (`message` with a `maxLength`, e.g. 2048).
   - Operator: introduce a `safeReconcileProject(project)` wrapper (exported from `reconciler.ts`, used by the informer) that calls `reconcileProject`, catches errors, logs with the existing `[project/ns/name]` prefix, and merge-patches `status.reconcile = { state: 'Error', message, observedGeneration }` (truncating the message). On success it patches `{ state: 'Ready', observedGeneration }`. Merge patch touches only the `reconcile` key, so the manager-owned `status.board` is never clobbered.
   - **Loop guard:** patching Project status fires the informer's `update` callback again. Skip the status patch when the current `project.status?.reconcile` already has the same `state`/`message`/`observedGeneration` (and do not include timestamps in the patch), so a persistent error converges after one patch instead of hot-looping.
3. **Bounded retry for transient errors:** in the error path of `safeReconcileProject`, classify the error: HTTP 4xx (`statusCode`/`code` 400–499, mirroring the existing `isNotFound` shape at `reconciler.ts:605-610`) is permanent — do not retry (the next spec edit or operator restart re-triggers reconcile); anything else (5xx, network) schedules **one** delayed retry per project key (e.g. 30 s, tracked in a `Map<string, Timer>` so retries never stack). This restores the "eventually consistent" behavior that the crash-restart accidentally provided, without the crash.

**Fix 2 (permanent Run validation errors):**

1. Introduce a `ValidationError` class (in `packages/operator/src/adapters/opencode-config.ts` next to its only current thrower, exported) and make `assertCredentialsUnambiguous` throw it. Keep the message text unchanged.
2. In `reconcile()` (`reconciler.ts`), wrap the `assertCredentialsUnambiguous` call in try/catch: on `ValidationError`, `patchStatus(run, { phase: RunPhase.Failed, message: e.message })` and **return** without rethrowing. The worker's catch never sees it, so no 5 s re-enqueue; the terminal-phase guard short-circuits every subsequent resync. The user sees phase=Failed with the actionable message immediately.
3. Keep the catch narrowly scoped (`e instanceof ValidationError`) so genuine transient errors elsewhere in `reconcile()` still follow the existing retry path. Other permanent-validation throw sites can adopt `ValidationError` later; only credentials validation is in scope here.

## Scope boundaries

**In scope:**
- `packages/operator/src/index.ts` — informer callback `.catch` wrappers.
- `packages/operator/src/reconciler.ts` — `safeReconcileProject` wrapper + Project status patching + retry classification; `ValidationError` handling in `reconcile()`.
- `packages/operator/src/adapters/opencode-config.ts` — `ValidationError` class.
- `packages/api/src/index.ts` — `ProjectStatusSchema.reconcile`.
- `k8s/crds/project.yaml` — `status.reconcile` schema.
- Unit tests for the new/changed pure logic.

**Out of scope (explicitly):**
- Validating/sanitizing `spec.codeServer.resources` or `spec.embedding.resources` contents (a schema-level fix like `quantity` patterns is a separate hardening task; this task makes bad values non-fatal and visible).
- Surfacing `status.reconcile` in the web dashboard UI (non-breaking to add later).
- Converting other `reconcile()` throw sites (pod create, PVC) to `ValidationError` — they already patch `Failed` where permanent.
- ClusterSettings status surfacing (`reconcileClusterSettings` already swallows most errors internally; it only gets the `.catch` backstop).
- Any changes to manager/web packages beyond the shared API schema.

## Tasks

1. **`ValidationError` + throw site** — In `packages/operator/src/adapters/opencode-config.ts`, add `export class ValidationError extends Error` (set `this.name = 'ValidationError'`); change `assertCredentialsUnambiguous` to throw it. Update/extend `adapters/opencode-config.test.ts` to assert the thrown error is a `ValidationError`.
2. **Catch validation errors in `reconcile()`** — In `reconciler.ts`, wrap the `assertCredentialsUnambiguous` call (lines 412-417): on `ValidationError`, log, `patchStatus(run, { phase: RunPhase.Failed, message: e.message })`, and `return`.
3. **API schema: `ProjectStatusSchema.reconcile`** — In `packages/api/src/index.ts`, add the optional `reconcile` object (`state: 'Ready' | 'Error'`, `message?`, `observedGeneration?`) with a doc comment noting the operator owns this key and the manager owns `board`.
4. **CRD: `status.reconcile`** — In `k8s/crds/project.yaml`, add the matching structural schema under `status.properties` (enum for `state`, `maxLength: 2048` on `message`, integer `observedGeneration`).
5. **`safeReconcileProject` in `reconciler.ts`** — New exported async function: fetch-free wrapper around `reconcileProject` that (a) on success patches `status.reconcile = { state: 'Ready', observedGeneration: project.metadata.generation }` when it differs from the current value; (b) on error logs, truncates the message to the CRD max, patches `state: 'Error'` when it differs; (c) classifies the error and, for non-4xx errors only, schedules a single delayed re-reconcile (~30 s) per project key via a module-level timer map (cleared on the project-delete path). Include a `patchProjectReconcileStatus` helper using `co.patchNamespacedCustomObjectStatus` with `PatchStrategy.MergePatch` (same pattern as `patchStatus`, never throws).
6. **Informer callback hardening in `index.ts`** — Replace `void reconcileProject(obj)` (add/update) with `safeReconcileProject(...)` plus a final `.catch` logging backstop; add `.catch` to `reconcileClusterSettings` (add/update) and to `cleanupCodeServer`/`cleanupMemoryService` (delete). Cancel any pending retry timer for the project on delete.
7. **Unit tests** — Add tests for the pure pieces (test framework: `bun test`, colocated `*.test.ts`): the 4xx-vs-transient error classifier and the "skip patch when status unchanged" comparison (extract both as small exported pure functions so they are testable without a kube client, matching how `code-server.test.ts` / `pod-builder.test.ts` only exercise pure functions).
8. **Typecheck + full test pass** — `bun test src/` in `packages/operator` and workspace typecheck (`tsc -p tsconfig.json` per changed package) to confirm no regressions, including `packages/api` consumers (web/manager compile against the extended `ProjectStatusSchema`).

## Acceptance criteria

1. A Project CR with garbage in `spec.codeServer.resources` (e.g. `limits.memory: "banana"`) no longer terminates the operator process: the apiserver 422 is caught, logged with the `[project/ns/name]` prefix, and written to `status.reconcile = { state: 'Error', message: ... }`. Run reconciliation for all other CRs continues untouched.
2. The error-status patch converges: a persistently-bad Project results in a bounded number of status patches (no informer-update hot loop) and no retry storm (4xx errors are not re-queued).
3. A transient (non-4xx) failure during project reconcile is retried once after a delay per event, and a subsequently-successful reconcile clears the status to `state: 'Ready'`.
4. `status.board` on Project CRs is never overwritten by operator status patches (merge patch on the `reconcile` key only).
5. A `claude`-engine Run with both `llmKeysSecret` and `authSecret` set gets `status.phase = Failed` with the credentials message from `assertCredentialsUnambiguous` on the first reconcile, is never re-enqueued for retry (no repeating `reconcile(...) failed` log lines for it), and its run key/pod cleanup follows the existing terminal-phase path.
6. Transient errors inside `reconcile()` (e.g. apiserver 5xx on pod create) keep today's behavior: logged and re-enqueued after 5 s.
7. `bun test src/` in `packages/operator` passes; typecheck passes across `api`, `operator`, `web`, `manager`.
8. `k8s/crds/project.yaml` and `ProjectStatusSchema` agree on the `status.reconcile` shape.

## Risks / open questions

- **Status-patch feedback loop** is the main design risk: every Project status patch triggers an informer `update` and another reconcile pass. The unchanged-status skip (Task 5) is the guard; the BUILD task must not add timestamps or other always-changing fields to `status.reconcile`. Note the reconcile pass itself is idempotent (SSA upserts), so even an extra pass is cheap — the guard prevents an *unbounded* loop, not a single echo.
- **CRD rollout ordering:** clusters must apply the updated `project.yaml` CRD before deploying the new operator, otherwise the `status.reconcile` patch is silently pruned by the apiserver (harmless — errors still logged — but invisible in status). Call this out in the BUILD PR description; CRDs here are applied from `k8s/crds/` by existing deploy tooling.
- **`reconcileProject` is also called only via informer events** — there is no periodic project resync (unlike Runs, `startPeriodicResync` at `reconciler.ts:778-782` only re-enqueues Runs). The single delayed retry narrows the transient-error window but a retry that also fails transiently waits for the next informer event/relist. Accepted for this task; a periodic project resync is possible follow-up.
- **Error-code shape:** the classifier keys off `statusCode`/`code` like the existing `isNotFound`; `@kubernetes/client-node@1.4.0` errors expose these fields, but network-level errors may not — the classifier must default to "transient" (retry) when no numeric code is present.
- **Assumption:** surfacing a Run credentials misconfiguration as terminal `phase: Failed` (rather than a new phase) is correct — the manager's board flow already treats Failed as the trigger for facilitation/retry decisions, and a human editing the Run spec creates a new run rather than reviving the failed one.
- **Assumption:** `ValidationError` lives in the operator package (not `@percussionist/api`) since only the operator throws and catches it.

## Proposed BUILD task breakdown

- **BUILD 1 — Run validation surfacing (small, self-contained):** Tasks 1-2 + adapter test updates. No schema/CRD changes; deployable independently.
- **BUILD 2 — Project reconcile hardening (medium):** Tasks 3-6 + Task 7 tests. Includes API schema, CRD, `safeReconcileProject`, informer `.catch` wrappers. Task 8 verification runs in both BUILDs.

BUILD 1 and BUILD 2 are independent and can be built/reviewed in parallel; BUILD 2 is the one that removes the crash loop and should land first if sequenced.
