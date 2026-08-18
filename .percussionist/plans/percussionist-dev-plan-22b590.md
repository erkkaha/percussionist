# Plan: Docs review — fix false claims and fill gaps in README.md, AGENTS.md, and docs/

**Task:** `percussionist-dev-plan-22b590` — review documentation; check for gaps and false claims
**Type:** PLAN
**Date:** 2026-08-13

## Context

Every user-facing doc page was read end-to-end and cross-checked against the
implementation (Zod schemas in `packages/api/src/index.ts`, operator/manager/
dispatcher/cli sources, `k8s/deploy/`, `k8s/flux/`, `images/runner/Dockerfile`).
All findings below were **verified against code** during planning; each lists the
file:line of both the doc claim and the code that contradicts it.

Prior doc-accuracy work (`percussionist-dev-plan-hsb8g`) already fixed the `/cache`
PVC narrative, CLI board flag names, CRD-count mismatch, and SSH host-key wording.
The remaining drift is newer: per-run Ingress removal, MCP-token auth, `flow.*`
and `data` schema changes, auxiliary-run naming, and several CLI/MCP tools that
are undocumented.

## Verified findings

### A. False claims (docs state something the code contradicts)

| # | Doc (file:line) | Claim | Truth (verified) |
|---|---|---|---|
| A1 | `README.md:1071-1131` "Per-run web UI (subdomains)" | Operator creates a per-run Ingress for each run's opencode web UI; `spec.expose.web: false` opts out | Per-run Ingress was **removed** (`packages/operator/src/config.ts:16` — "Per-run Ingress was removed when `opencode web` was replaced by tmux-wrapped `opencode` TUI"; the only Ingress the operator renders is the code-server IDE ingress, `reconciler.ts:1038` `ideIngressName`). `expose.web` does not exist in any schema. `PERCUSSIONIST_INGRESS_BASE_URL`/`_CLASS`/`_ANNOTATIONS` now apply only to code-server IDE ingresses |
| A2 | `README.md:215,219,226,236-237,382,386,393,405-406` (mermaid + notes) | opencode container runs `opencode web` on `:4096`; per-run Ingress node in diagrams | Pod runs `opencode serve --hostname 0.0.0.0 --port 4096` (`packages/operator/src/pod-builder.ts:876`, `images/runner/Dockerfile:123`). The per-run Ingress nodes in both mermaid diagrams are stale |
| A3 | `README.md:242-243` | "A 1-hour hard timeout guard exits with code 3 if the run stalls" | Hard-timeout guard no longer calls `process.exit` directly; it rejects a promise observed by `Promise.race` so the run exits through the normal snapshot → stats → `Failed` path (`packages/dispatcher/src/polling.ts:1225-1243`). Deadline is per-run (`RUN_TIMEOUT_SECONDS`/`spec.timeoutSeconds`, 60 s grace), legacy fallback 65 min |
| A4 | `README.md:664-682` data override example | `spec.data.accessMode` and `spec.data.storageSize` are valid fields | `RunSpecSchema.data` / `ProjectSpecSchema.data` only have `pvcName`, `mountPath`, `storageClass` (`packages/api/src/index.ts:706-708, 1131-1133`). Access mode/size are operator **env** overrides only: `DEFAULT_STORAGE_ACCESS_MODE`, `DEFAULT_STORAGE_SIZE` (`packages/operator/src/config.ts:53-63`) |
| A5 | `docs/guide/configuration.md:129` | PVC access mode/size "override via the `data` fields in the Project CR" | Same as A4 — only pvcName/mountPath/storageClass are CR fields |
| A6 | `docs/guide/configuration.md:147-155` and `docs/reference/crds.md:118-126` ClusterSettings example | `spec.runnerImage: ghcr.io/erkkaha/percussionist/runner:latest` | No flat `runnerImage` field anywhere in the codebase; the field is `spec.runner.image` (`ClusterSettingsSpecSchema`, `packages/api/src/index.ts:1148-1153`) |
| A7 | `docs/guide/configuration.md:105` and `docs/reference/task-lifecycle.md:56` | `review` preset "Adds AI review step after completion" | The `review` preset has `review.aiReviewerEnabled: false` and `build.onSuccess: 'human-review'` — **human** review, no AI review (`packages/manager-controller/src/reconciler/flow.ts:73-93`) |
| A8 | `docs/security.md:138` "Recommended NetworkPolicies" | "Allow runner pods to reach manager MCP server" | `k8s/deploy/networkpolicy.yaml:30-45` **denies** runner pods (`percussionist.dev/component: runner`) on manager MCP :4097 — only web and manager pods are allowed. The doc contradicts both the manifest and its own §"Manager MCP Server" |
| A9 | `docs/security.md:146` Known Considerations | "MCP server has no auth layer" | Manager MCP enforces `MCP_TOKEN` bearer auth for cross-pod callers (`packages/manager-controller/src/agent/tools.ts:2911-2931`); loopback exempt |
| A10 | `AGENTS.md:170` | `kubectl port-forward svc/code-server-my-project 8080:8080` | Code-server Deployment **and** Service are named `ide-{project}` (`packages/operator/src/code-server.ts:38-44`); `docs/features/code-server.md:38` already says `svc/ide-my-project` |
| A11 | `README.md:181-185, 487` and `docs/reference/cli.md:37-40` | `beatctl attach` port-forwards the run Service, reads the auth Secret, launches `opencode attach`; `[--continue]` flag | `attach.ts` does `kubectl exec -it pod/<pod> -c opencode -- opencode attach http://127.0.0.1:4096` — no port-forward, no Secret read (`packages/cli/src/attach.ts:44-57`); no `--continue` option exists (`index.ts:177-182`) |
| A12 | `docs/task-lifetime.md:201-209` Run Relationships table | Review/merge/buildgen names are `{project}-review-{task}-{retryCount+aiReworkCount}`, `{project}-merge-{task}-{retryCount}`, `{project}-buildgen-{task}-0` | All auxiliary runs use `auxiliaryRunName()` with a random/hash suffix (`packages/manager-controller/src/worker-builder.ts:947-964`; call sites `reconciler/decision.ts:585, 977, 1223`); worker runs use a deterministic sha256 suffix (`worker-builder.ts:923-941`) |
| A13 | `docs/reference/task-lifecycle.md:29-45` transitions | `waiting-for-input` → `running`, `failed`; `failed` → `pending`, `awaiting-human`, `awaiting-merge` | `TRANSITION_TABLE` (`packages/api/src/index.ts:891-915`) also allows `waiting-for-input → succeeded` and `failed → awaiting-feature-merge` |
| A14 | `README.md:978-980` feature-branch section | "Feature merge (manual) — Manual merge to `main` when feature is complete" | `flow.integration.mode` defaults to `auto-merge` and supports `pr` / `manual` / `disabled` (`flow.ts:187-190`, `packages/api/src/index.ts:1207-1212`) |
| A15 | `README.md:1517` and `docs/features/runner-packages.md:26-34` base image list | "git, openssh, node, npm, bash, curl, unzip, and github-cli" | Runner image also installs **pnpm and bun** (`images/runner/Dockerfile:71-77`; `runner-doctor` checks `pnpm`/`bun` at Dockerfile:100-101). AGENTS.md already lists them correctly |

### B. Gaps (real functionality that docs never mention)

| # | Location | Missing |
|---|---|---|
| B1 | `docs/reference/mcp-tools.md` Memory table (lines 129-135) | `list_memories`, `get_memory`, `update_memory`, `delete_memory` — all exist in `packages/manager-controller/src/agent/tools.ts:696-753` |
| B2 | `docs/reference/mcp-tools.md` Administration table (lines 137-147) | `list_findings`, `update_finding`, `create_task_from_finding` — exist at `tools.ts:799-864` |
| B3 | `docs/reference/cli.md` | Undocumented commands: `board plan <project>`, `board findings <project>`, `board task approve`, `board task request-changes`, `board task retry`, `validate agents`, `chat --message` one-shot (`packages/cli/src/index.ts:483-612, 614-625, 184-191`); `wait` exit codes 0/1/2/3 are documented only in README |
| B4 | `docs/features/feature-branching.md` and `docs/guide/configuration.md` | `flow.integration` block (`auto-merge` / `pr` / `manual` / `disabled`) and the PR-mode workflow (GitHub token secret, 15-min polling cache) are documented in AGENTS.md and `docs/task-lifetime.md` but absent from the site docs |
| B5 | `docs/guide/configuration.md` and `docs/reference/crds.md` Run docs | `spec.timeoutSeconds` (default 3600, `packages/api/src/index.ts:699`) — the per-run deadline that now drives the dispatcher hard timeout — is never mentioned |

### C. Minor / confirmations (no change needed)

- Run phases, Task 16-phase enum, capability names (`task.plan.execute` etc.), doctor's 10 check categories + exit codes 0/1/2/3, git-workspace cleanup via `batch/v1` Job, `manager-mcp-token` Secret name, `ollamaUrl` default `http://ollama.<ns>.svc.cluster.local:11434`, memory service :4100, code-server `ide-{project}` naming in `docs/features/code-server.md`, GitOps/Flux docs (two controllers, OCIRepository `percussionist`, `prune: false` on CRDs) — all verified accurate.

## Approach

**Source-of-truth-first doc sync** (same discipline as `hsb8g`): the Zod schemas
in `packages/api/src/index.ts`, `packages/operator/src/config.ts`, the reconcile
code, and the CLI option tables are authoritative; docs are corrected to match.
No production code changes are proposed — this is a documentation-only plan.
Corrections are grouped into small, independently shippable BUILD tasks, each
covering one coherent theme with its own acceptance check (grep the doc for the
stale string; grep the code for the canonical value).

Scope boundaries:
- **In scope:** doc corrections + gap filling listed above; README/AGENTS.md/docs only.
- **Out of scope:** any code/CRD/schema/behavior change; adding new CI checks;
  restructuring the doc site; re-verifying docs that were already verified accurate.

## Tasks (proposed BUILD breakdown)

1. **BUILD — README: remove stale per-run web UI section and fix run-pod architecture prose**
   - `README.md:1071-1131`: replace the "Per-run web UI (subdomains)" section with a
     note that per-run Ingress was removed and `PERCUSSIONIST_INGRESS_BASE_URL` now
     serves code-server IDE ingresses only (point at `docs/features/code-server.md`);
     delete `spec.expose.web` opt-out example and the ingress-controller setup table.
   - `README.md:215-243, 382-417`: mermaid diagrams + bullet notes — `opencode serve`
     on `:4096`, drop the per-run Ingress node, describe the hard-timeout path as a
     graceful fail (per-run `RUN_TIMEOUT_SECONDS` deadline, snapshot → stats → Failed),
     not "exits with code 3".
   - Acceptance: no occurrence of "opencode web" or "per-run Ingress" remains in
     README except historical context; diagrams match `pod-builder.ts`.

2. **BUILD — data PVC override facts (README + configuration.md)**
   - `README.md:664-682`: remove `accessMode`/`storageSize` from the `spec.data`
     example; document that access mode/size are operator env overrides
     (`DEFAULT_STORAGE_ACCESS_MODE`, `DEFAULT_STORAGE_SIZE`, `DEFAULT_STORAGE_CLASS`).
   - `docs/guide/configuration.md:129`: same correction; list the three real
     `spec.data` fields.
   - Acceptance: `grep -rn "storageSize\|accessMode" README.md docs/` shows only the
     corrected env-var wording.

3. **BUILD — ClusterSettings example: `runnerImage` → `runner.image`**
   - `docs/guide/configuration.md:147-155` and `docs/reference/crds.md:118-126`.
   - Acceptance: `grep -rn "runnerImage" docs/ README.md` → no matches.

4. **BUILD — flow preset descriptions + feature-branching integration docs**
   - Fix the `review` preset description in `docs/guide/configuration.md:105` and
     `docs/reference/task-lifecycle.md:56` (human review, not AI review).
   - Add `flow.integration` (`auto-merge`/`pr`/`manual`/`disabled`, default
     `auto-merge`) to `docs/guide/configuration.md` flow block and to
     `docs/features/feature-branching.md` (PR mode + `source.git.githubTokenSecret`,
     15-min poll cache, `awaiting-human` on closed-without-merge).
   - Fix `README.md:978-980` "Feature merge (manual)" → document the four modes.
   - Acceptance: feature-branching.md and configuration.md agree with
     `reconciler/flow.ts:187-190` and AGENTS.md's integration section.

5. **BUILD — security.md corrections (NetworkPolicy + MCP auth)**
   - `docs/security.md:135-140`: "Recommended NetworkPolicies" must say runner pods
     are **denied** manager MCP :4097 (web + manager only) per
     `k8s/deploy/networkpolicy.yaml:30-45`; keep the memory-service rule and the
     CNI-enforcement caveat.
   - `docs/security.md:146`: "MCP server has no auth layer" → bearer-token
     (`MCP_TOKEN`/`manager-mcp-token` Secret) for cross-pod callers, loopback exempt.
   - Acceptance: security.md's policy guidance matches networkpolicy.yaml and
     `tools.ts:2911-2931`.

6. **BUILD — AGENTS.md code-server access (service name)**
   - `AGENTS.md:170`: `svc/code-server-my-project` → `svc/ide-my-project`.
   - Acceptance: `grep -rn "code-server-my-project" AGENTS.md docs/ README.md` → no
     matches; port-forward target matches `code-server.ts:42-44`.

7. **BUILD — `beatctl attach` documentation (README + cli.md)**
   - `README.md:181-185, 487` and `docs/reference/cli.md:37-40`: describe exec-based
     attach (`kubectl exec` into the opencode container, `opencode attach` against
     `http://127.0.0.1:4096`); drop the `[--continue]` flag.
   - Acceptance: attach text matches `packages/cli/src/attach.ts`.

8. **BUILD — MCP tools reference gaps**
   - `docs/reference/mcp-tools.md`: add `list_memories`, `get_memory`,
     `update_memory`, `delete_memory` to Memory; add `list_findings`,
     `update_finding`, `create_task_from_finding` to Administration (mirror
     AGENTS.md's tables).
   - Acceptance: every tool name in `tools.ts:115-864` appears in
     `docs/reference/mcp-tools.md`.

9. **BUILD — CLI reference gaps**
   - `docs/reference/cli.md`: add `board plan`, `board findings`, `board task
     approve`, `board task request-changes`, `board task retry` (with `--review`),
     `validate agents`, `chat --message`; document `wait` exit codes 0/1/2/3 (lift
     from README).
   - Acceptance: every `program.command(...)` in `packages/cli/src/index.ts` is
     mentioned in `docs/reference/cli.md`.

10. **BUILD — run-name scheme + transition table corrections**
    - `docs/task-lifetime.md:201-209`: auxiliary run names carry a hash/random
      suffix via `auxiliaryRunName`; worker runs are deterministic sha256.
    - `docs/reference/task-lifecycle.md:34,44`: add `waiting-for-input → succeeded`
      and `failed → awaiting-feature-merge` to the transitions table.
    - Acceptance: naming table matches `worker-builder.ts:923-964`; transitions
      match `TRANSITION_TABLE` in `packages/api/src/index.ts:891-915`.

11. **BUILD — runner base-image lists**
    - `README.md:1517` and `docs/features/runner-packages.md:26-34`: add pnpm and
      bun to the base-image list (align with AGENTS.md and `images/runner/Dockerfile`).
    - Acceptance: all three lists identical.

12. **(Optional, if time-box permits) BUILD — timeoutSeconds documentation**
    - Add `spec.timeoutSeconds` (default 3600) to `docs/reference/crds.md` Run
      example and `docs/guide/configuration.md` Run notes, linked to the dispatcher
      hard-timeout behavior.

## Risks / open questions

- **Docs-only plan, no tests can assert doc truth.** Each BUILD's acceptance check
  is a grep against the canonical code string; there is no automated doc-truth CI.
  A follow-up (out of scope here) could add a link check: `.vitepress/config.ts`
  has `ignoreDeadLinks: true`, so broken internal links are currently silent.
- **Version drift in examples** (e.g. `gitops.md` pinning `v0.2.12`/`v0.2.13` vs the
  current `k8s/flux/percussionist.yaml` tag `v0.2.14`): examples are illustrative;
  flagged as known, not a claim error.
- **A1 scope question:** "Per-run web UI" removal is significant README surgery.
  If maintainers prefer keeping a short historical note, the BUILD should keep one
  sentence pointing at the current IDE-ingress behavior rather than deleting the
  section outright — the plan's default is to replace with the code-server note.
- **A8 is also a product question worth one line in the BUILD:** `docs/security.md`
  line 138 may be a leftover from a time when runners *could* reach the MCP port;
  the corrected text must not suggest granting runners access.

## Acceptance criteria (overall)

1. Every item in tables A1–A15 and B1–B5 above is addressed (fixed or explicitly
   accepted as a known-version-drift case).
2. `grep` acceptance checks from each BUILD pass.
3. `pnpm typecheck && pnpm test` remain green (no code changes expected; docs only).
4. No production code, schema, or manifest file is modified by any BUILD in this plan.
