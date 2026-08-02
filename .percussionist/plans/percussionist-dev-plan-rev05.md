# Plan: Fix Run TTL & cleanup lifecycle (RBAC, per-run TTL, cleanup Jobs, worktree GC, resync noise)

Task: `percussionist-dev-plan-rev05`

## Context

Run garbage collection has six compounding failures. All were verified against the
current code:

1. **RBAC forbids run deletion.** The operator ClusterRole
   (`k8s/deploy/operator.yaml:37-39`) grants `runs` only
   `[get, list, watch, update, patch]` — no `delete`. `startTTLCleanup`
   (`packages/operator/src/ttl.ts:188-194`, wired in
   `packages/operator/src/index.ts:121`) calls
   `co.deleteNamespacedCustomObject` hourly (`ttl.ts:80-86`) and gets
   403 Forbidden every time; the error is only logged (`ttl.ts:90-94`).
   Terminal Runs never go away. Because each run's session snapshot ConfigMap
   (`<run>-session`) carries an ownerReference to the Run
   (`packages/dispatcher/src/polling.ts:318-327`), those ConfigMaps accumulate
   with them.

2. **`spec.ttlSecondsAfterFinished` is ignored.** The field is
   required-with-default (604800) in the Run CRD (`k8s/crds/run.yaml:334-338`,
   generated from the Zod schema at `packages/api/src/index.ts:697-701` via
   `codegen/gen-crds.mjs`) and set by samples
   (`k8s/samples/hello-run.yaml:19`, `k8s/samples/claude-engine.yaml:89`, both
   3600). Nothing reads it: `isExpired` (`ttl.ts:64-69`) uses only
   ClusterSettings `runTTLDays` (`ttl.ts:32-44`). A run asking for 1-hour
   retention waits 7 days.

3. **Cleanup pods leak and hardcode the PVC name.**
   `cleanupExpiredRunWorktree` (`ttl.ts:105-184`) creates a bare Pod
   (`cleanup-ttl-<run>`) with no ownerReferences and no TTL; one Succeeded pod
   leaks per expired run forever. It also hardcodes
   `claimName: ${projectName}-data` (`ttl.ts:170`), ignoring the
   `spec.data.pvcName` override that the run pod honors
   (`packages/operator/src/pod-builder.ts:290`) — with an overridden PVC the
   cleanup pod sits Pending forever (and `spec.data.mountPath` is likewise
   ignored).

4. **Worktrees leak on any non-TTL deletion.** `cleanupExpiredRunWorktree` is
   only called from `runTTLCleanup` (`ttl.ts:89`). The Run informer's delete
   handler (`packages/operator/src/index.ts:56-59`) just calls `dequeue()`. So
   `kubectl delete run`, dashboard delete, and the manager's `delete_run` tool
   (`packages/manager-controller/src/agent/tools.ts:1319` →
   `deleteRun` in `packages/kube/src/index.ts:302`, also the `DeleteRun`
   effect in `packages/manager-controller/src/reconciler/effects.ts:233-240`)
   leave `/data/worktrees/<run>/` (full checkout + node_modules) on the shared
   PVC permanently.

5. **Manager-side worktree cleanup misses review/buildgen runs.** The
   `CleanupWorktree` effect (emitted at ~20 sites in
   `packages/manager-controller/src/reconciler/decision.ts`, applied at
   `effects.ts:277-298`) cleans single named runs — worker, plan, merge.
   Review and buildgen facilitator runs get their own run names
   (`auxiliaryRunName`, `packages/manager-controller/src/worker-builder.ts:774-791`)
   and thus their own worktrees, and nothing cleans them.
   `spawnTaskWorktreeCleanupPod`
   (`packages/manager-controller/src/worktree-cleanup.ts:207-310`), written to
   remove all of a task's worktrees, has **zero callers** — and its glob
   (`${project}-${sanitizedTask}-??????????`, ten-char suffix) only matches
   worker runs (`workerRunName`, `worker-builder.ts:750-768`), not auxiliary
   runs (`${project}-<kind>-<mid>-<6hex>`).

6. **Terminal runs churn the resync loop.** `startPeriodicResync`
   (`packages/operator/src/reconciler.ts:778-782`) re-enqueues every run in the
   `seen` map every 10 s. `reconcile()`'s terminal branch
   (`reconciler.ts:382-398`) then does a `revokeRunKey` HTTP DELETE plus a Pod
   GET (plus the fresh Run GET in `runWorker`, `reconciler.ts:745-754`) — per
   terminal run, every 10 s, for the full retention period. Nothing dequeues a
   terminal run until the CR is deleted.

Useful facts for implementation:
- `revokeRunKey` never throws (`packages/operator/src/run-key-client.ts:134-155`)
  and keys carry their own expiry, so a missed revocation self-heals
  (comment at `reconciler.ts:383-385`).
- Runs carry a `percussionist.dev/task-id` label
  (`packages/api/src/index.ts:1800`; set in `worker-builder.ts:256,511,696`,
  `facilitator.ts:570`), so the manager can enumerate a task's runs exactly.
- No `batch/v1` usage exists anywhere yet (no `BatchV1Api` import, no jobs RBAC).
- Operator tests run with `bun test src/` (see `packages/operator/package.json`);
  manager effects already have a spy-based test harness
  (`packages/manager-controller/src/reconciler/__tests__/effects.test.ts`).
- `k8s/crds/*.yaml` are **generated** — edit the Zod schema in
  `packages/api/src/index.ts` and run `pnpm codegen`; do not hand-edit the CRD.
- Manager-created runs set `ttlSecondsAfterFinished` explicitly
  (`worker-builder.ts:279,534,719`, `facilitator.ts:593`).

## Scope boundaries

**In scope:** operator RBAC, `packages/operator/src/ttl.ts`,
`packages/operator/src/index.ts` (delete handler),
`packages/operator/src/reconciler.ts` (terminal dequeue), the
`ttlSecondsAfterFinished` Zod schema + regenerated CRD,
`packages/manager-controller/src/worktree-cleanup.ts` +
`reconciler/effects.ts` wiring, and tests for the above.

**Out of scope:**
- Retroactive cleanup of already-leaked worktrees / Succeeded `cleanup-ttl-*`
  pods (one-off manual op; an optional startup orphan sweep is noted as
  follow-up, not part of this task).
- Converting the manager's cleanup Pods to Jobs (they already have Task
  ownerReferences; only the operator's ownerless pods change to Jobs).
- Operator HA / leader election, memory-service or code-server cleanup paths.
- Web/dashboard changes.

## Approach & key decisions

**D1 — TTL precedence.** Make `ttlSecondsAfterFinished` truly optional: change
the Zod field from `.default(7 * 86400)` to `.optional()` and regenerate the
CRD (removes it from `required` and drops the default). Expiry rule in the
operator: `ttlSeconds = run.spec.ttlSecondsAfterFinished ?? runTTLDays * 86400`.
Per-run wins when present; ClusterSettings stays the fleet default. Rationale:
with a CRD-level default of 604800 baked into every stored object, `runTTLDays`
would otherwise be permanently dead. Existing stored runs (default already
persisted) keep 7-day behavior — no migration needed. Alternative
(`min(perRun, cluster)` as a cluster-wide cap) rejected as a semantics change
beyond the bug fix; flagged under open questions.

**D2 — Cleanup workload becomes a Job.** Replace the operator's bare cleanup
Pod with a `batch/v1` Job named `cleanup-ttl-<run>` (deterministic; 409 →
already-in-flight, skip), `ttlSecondsAfterFinished: 3600`, `backoffLimit: 2`,
`restartPolicy: Never`. Claim name and mount path come from the run spec:
`spec.data?.pvcName ?? \`${project}-data\`` and `spec.data?.mountPath ?? '/data'`
— mirroring `pod-builder.ts:290-291`. Requires new RBAC:
`batch/jobs [get, list, watch, create, delete]`. An ownerReference is not
useful here — the owning Run is being deleted — hence the Job TTL.

**D3 — Single trigger path for operator worktree cleanup.** Move the
worktree-cleanup trigger from `runTTLCleanup` to the Run informer's `delete`
event (`index.ts:56-59`). The TTL loop's own delete then flows through the same
informer event, and kubectl/dashboard/manager deletes are covered for free.
Guard: only spawn when `run.spec.source?.git` is set (local-source runs use the
shared `workspace/` subPath — `pod-builder.ts:744` — and must not be touched).
The `rm -rf` script is idempotent, so a duplicate Job after a missed-GC race is
harmless.

**D4 — Task-done cleanup, wired centrally.** Rather than adding a new effect
at every `toPhase: 'done'` site in `decision.ts` (~10 sites), hook once in
`applyDecision` (`effects.ts`): after the final status patch succeeds and
`toPhase === 'done'`, fire-and-forget `spawnTaskWorktreeCleanupPod` (same
dynamic-import pattern as the `CleanupWorktree` case, `effects.ts:288-296`).
To cover auxiliary (review/buildgen/merge) worktrees, extend
`spawnTaskWorktreeCleanupPod` with a `runNames?: string[]` option whose exact
directories are removed in addition to the existing worker-prefix glob; the
caller obtains the names by listing Runs with label selector
`percussionist.dev/task-id=<task>` (extend `listRuns` in
`packages/kube/src/index.ts` with an optional `labelSelector` if it lacks one).
Aux runs already TTL-deleted by then are handled by the operator delete-event
path (D3).

**D5 — Dequeue terminal runs.** In `reconcile()`'s terminal branch, when the
pod GET 404s (child resources confirmed gone — the same signal the code
already uses), call `dequeue(\`${ns}/${name}\`)`. `revokeRunKey` has already run
at least once by then and is self-healing, so dropping the run from the resync
set is safe. The TTL loop lists runs from the API directly
(`listTerminalRuns`, `ttl.ts:46-62`), so TTL deletion is unaffected. Informer
re-list on operator restart re-adds terminal runs; they dequeue again after one
pass.

## Tasks (proposed BUILD breakdown)

Ordered; tasks 1–2 unblock everything observable, 3–6 are independent of each
other after 1.

1. **RBAC: allow run deletion + jobs** — `k8s/deploy/operator.yaml`:
   add `delete` to the `runs` verbs (line 39); add a new rule
   `apiGroups: ["batch"], resources: ["jobs"], verbs: [get, list, watch, create, delete]`.
   Check `k8s/local.example/` and `k8s/self-dev/` for copies/patches of this
   ClusterRole and update if present.

2. **Honor per-run TTL** — `packages/api/src/index.ts:697-701`: change
   `ttlSecondsAfterFinished` to `.optional()`; run `pnpm codegen` and commit
   the regenerated `k8s/crds/run.yaml`. In `packages/operator/src/ttl.ts`:
   change `isExpired(run, ttlDays)` to prefer
   `run.spec.ttlSecondsAfterFinished` (seconds) over `ttlDays * 86400`.
   Export `isExpired` (or a pure `expiryDeadline(run, ttlDays)`) and add
   `packages/operator/src/ttl.test.ts` (bun) covering: per-run 3600 honored,
   fallback to cluster days, missing `completedAt` → not expired.

3. **Cleanup Pod → Job with correct PVC** — `packages/operator/src/ttl.ts`:
   rewrite `cleanupExpiredRunWorktree` as `spawnWorktreeCleanupJob(run)` using
   `BatchV1Api` (client via `makeNodeApiClient(kc, BatchV1Api)` alongside the
   existing `coreV1`): Job `cleanup-ttl-<run>` with
   `ttlSecondsAfterFinished: 3600`, `backoffLimit: 2`, pod template
   `restartPolicy: Never`, claim/mount derived from
   `run.spec.data` as in D2; keep the existing script (worktree rm, mirror
   prune, branch delete, gc). Extract a pure `buildCleanupJob(run)` and test
   it: pvcName override respected, default claim `${project}-data`, mountPath
   override, name sanitization/truncation.

4. **Trigger worktree cleanup on Run delete** — `packages/operator/src/index.ts:56-59`:
   in the delete handler, after `dequeue`, call `spawnWorktreeCleanupJob(run)`
   (fire-and-forget, `.catch` logged) when `run.spec.source?.git` is set and
   the run has a project label. Remove the direct
   `cleanupExpiredRunWorktree` call from `runTTLCleanup` (`ttl.ts:89`) — the
   informer event now covers it (D3).

5. **Dequeue terminal runs** — `packages/operator/src/reconciler.ts:382-398`:
   in the `catch` branch of the pod GET (pod already gone), call
   `dequeue(\`${ns}/${name}\`)` and log once. Verify `runWorker`'s `finally`
   block (`reconciler.ts:768-774`) tolerates dequeue-during-processing (it
   does — `dequeue` clears `processing`/`dirty`; note it in the change).

6. **Wire task-done worktree cleanup in the manager** —
   `packages/manager-controller/src/worktree-cleanup.ts`: add
   `runNames?: string[]` to `TaskWorktreeCleanupOptions`; the script removes
   each `${dataMountPath}/worktrees/<name>` exactly (shell-quoted) in addition
   to the worker-prefix glob, collecting branches for mirror pruning the same
   way. `packages/kube/src/index.ts`: add/extend a `listRuns(ns, labelSelector?)`
   helper. `packages/manager-controller/src/reconciler/effects.ts`: in
   `applyDecision`, when the final status patch lands with
   `toPhase === 'done'` and a project is in context, list runs by
   `percussionist.dev/task-id=<task>` and fire-and-forget
   `spawnTaskWorktreeCleanupPod({ task, projectName, namespace, image, gitUrl,
   dataPvcName: project.spec.data?.pvcName, runNames })` (image/gitUrl derived
   as in the `CleanupWorktree` case). Extend
   `reconciler/__tests__/effects.test.ts` with a spy asserting the call on a
   done transition and no call on non-done transitions.

7. **Docs touch-up** — if `docs/` describes run retention
   (grep `runTTLDays` / `ttlSecondsAfterFinished` under `docs/`), update to
   state the new precedence: per-run field wins, `runTTLDays` is the fallback.

## Acceptance criteria

- Operator ClusterRole includes `delete` on `runs` and `[get, list, watch,
  create, delete]` on `batch/jobs`; TTL loop deletes an expired Run without a
  403 (verifiable in a kind/minikube e2e or by log inspection).
- A Run with `ttlSecondsAfterFinished: 3600` is deleted on the first TTL pass
  ≥ 1 h after `completedAt`; a Run without the field uses
  `runTTLDays` (default 7 d). Unit tests cover both.
- Deleting the Run cascades its `<run>-session` ConfigMap (existing ownerRef —
  no code change, but assert in e2e/manual verification).
- Worktree cleanup runs as a `batch/v1` Job with `ttlSecondsAfterFinished`
  set; no `cleanup-ttl-*` Pod/Job outlives its TTL. The Job mounts
  `spec.data.pvcName` when overridden (unit test on `buildCleanupJob`).
- `kubectl delete run <name>` (and dashboard/manager `delete_run`) triggers
  worktree cleanup: `/data/worktrees/<run>/` is removed; local-source runs
  spawn no Job.
- Task transition to `done` spawns a task-level cleanup pod whose script
  covers worker worktrees **and** the task's review/buildgen/merge run
  worktrees (effects test + worktree-cleanup unit test on the script content).
- After a terminal run's pod is gone it is no longer re-reconciled every 10 s
  (unit test on `dequeue` behavior or log-based assertion).
- `k8s/crds/run.yaml` is regenerated (not hand-edited) and committed;
  `pnpm typecheck`, `biome check .`, and `bun test` in
  `packages/operator` / `packages/manager-controller` pass.

## Risks / open questions

- **TTL semantics choice (D1):** per-run value can now *extend* retention
  beyond `runTTLDays`. If a cluster-wide cap is desired, switch to
  `min(perRun, cluster)` — one-line change in `isExpired`; flagging for
  reviewer sign-off.
- **Zod `.optional()` ripple:** any code that `parse()`s a RunSpec and relied
  on the default being materialized would now see `undefined`. Grep confirms
  no TS consumer reads the field today except the new ttl.ts code; manager
  builders set it explicitly. Builder should re-grep after rebase.
- **Watch-gap leak (D3):** if the operator is down when a Run is deleted, the
  informer never sees the delete and that worktree leaks. Acceptable residual
  risk; a periodic orphan sweep (list `/data/worktrees` vs live Runs) is a
  natural follow-up task, out of scope here.
- **Aux-run coverage at task-done (D4):** `runNames` only includes runs whose
  CRs still exist at the done transition. Aux runs deleted earlier are covered
  by D3; aux runs from before this fix ships remain leaked (see out-of-scope
  sweep).
- **Cleanup pod GC race:** the task-owned cleanup pod can be garbage-collected
  mid-run if the Task CR is deleted immediately after reaching done. Existing
  behavior for `spawnWorktreeCleanupPod`; unchanged, noted only.
- **RWO PVC contention:** with `ReadWriteOnce` data PVCs (default in
  `operator.yaml`), a cleanup Job can only schedule on the node currently
  mounting the PVC; if another run pod holds it on a different node the Job
  stays Pending until free, then its TTL still reaps it after completion. Same
  constraint exists for the current pods — not a regression.
- **CRD apply ordering:** clusters must re-apply the regenerated CRD before
  the new operator image (otherwise nothing breaks — the operator only reads
  the field). Mention in the release notes/changelog entry.
