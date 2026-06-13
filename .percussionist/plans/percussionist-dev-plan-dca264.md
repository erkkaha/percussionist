# Plan: Runner base-image strategy to reduce Alpine friction

**Task:** percussionist-dev-plan-dca264  
**Project:** percussionist-dev  
**Objective:** inventory Alpine coupling and define an implementation path for a lower-friction runner base strategy (glibc-first or dual-distro), without breaking existing run workflows.

---

## Implementation context

The runner/base-image behavior is currently Alpine-coupled in multiple layers:

1. **Runner image internals** (`images/runner/Dockerfile`)
   - Uses `apk` for core tooling.
   - Includes Alpine-specific compatibility glue: `gcompat`, compiled `gnu_stub.c`, and `LD_PRELOAD=/usr/local/lib/libgnustub.so`.
   - This is a direct signal that musl/glibc mismatch has already created friction.

2. **Workspace init package installation** (`packages/operator/src/pod-builder.ts`)
   - Injects `apk update --quiet && apk add --no-cache $RUNNER_PACKAGES` in both remote-git and local-git init paths.
   - `spec.runner.packages` therefore currently means “Alpine package names.”

3. **Manager MCP package tools** (`packages/manager-controller/src/agent/tools.ts`, `.../agent/security.ts`)
   - `install_packages` shells out to `apk ...`.
   - Security comments and regex naming policy are explicitly framed as Alpine package validation.
   - Plan-reading fallback commands install git via `apk add --no-cache git` before `git show`.

4. **Web backend git-diff helper** (`packages/web/src/server/routes/task-diff.ts`)
   - Shell script prepends `apk add --no-cache git` before executing git diff commands.

5. **Cleanup pod fallback images**
   - `packages/manager-controller/src/reconciler/effects.ts` fallback image is `"alpine/git"`.
   - `packages/operator/src/ttl.ts` TTL cleanup pod also hardcodes `"alpine/git"`.

6. **API/docs semantics and user-facing contracts**
   - `packages/api/src/index.ts` comments describe `RunnerPackagesSchema` as “System packages (apk).”
   - `README.md`, `AGENTS.md`, `SECURITY.md` describe runner packages and tooling in Alpine/apk terms.

**Conclusion:** this is not a single Dockerfile swap; Alpine assumptions are a cross-cutting contract in runtime scripts, security policy text, helper tools, cleanup pods, and documentation.

---

## Scope boundaries

### In scope

- Produce a concrete migration plan from Alpine-specific behavior toward distro-agnostic runner semantics.
- Decide target strategy:
  - **Option 1:** glibc-default runner, or
  - **Option 2:** dual support (`apk` + `apt-get`) with capability detection.
- Define implementation, verification, docs, and rollout steps with clear task boundaries.

### Out of scope

- Implementing code changes in this PLAN run.
- Redesigning unrelated reconciler/task lifecycle mechanics.
- Expanding package management beyond what is needed for runner package installs and helper commands.

---

## Approach

Use a **compatibility-first phased migration**:

1. Inventory all Alpine dependencies (done at planning level; to be codified in BUILD output).
2. Introduce a **shared package-manager detection strategy** for shell paths that currently hardcode `apk`.
3. Keep `spec.runner.packages` field stable for backward compatibility, but redefine semantics as distro-neutral “system package names for the selected base image.”
4. Eliminate opportunistic `apk add git` in helper flows where git is already guaranteed by image.
5. Validate via deterministic tests before changing the default runner base.
6. Defer default-image switch until canary evidence confirms reliability and acceptable startup/image-size tradeoffs.

**Recommended strategy:** dual-distro support first (Alpine + glibc), then optional default switch.

---

## Acceptance criteria

1. A documented decision exists: Alpine-default, glibc-default, or dual-support long-term.
2. No critical runtime path (workspace init, manager install tool, plan/diff helpers, cleanup pods) depends solely on `apk`.
3. Runner package docs/API comments are distro-neutral and explicit about package-name divergence risks.
4. Security posture is preserved (no shell-injection regressions) after installer abstraction.
5. Tests cover installer-path selection and cleanup image fallback behavior.
6. Rollout plan includes canary metrics, failure thresholds, and rollback steps.

---

## Tasks (implementation plan)

1. **Codify Alpine-coupling inventory artifact**
   - Capture the call sites and assumptions listed above in a checked-in inventory/ADR note.
   - Mark each as `must-change`, `should-change`, or `defer`.

2. **Define runner base candidates and evaluation rubric**
   - Candidate A: current Alpine-based runner.
   - Candidate B: glibc-based runner with equivalent tools.
   - Candidate C: keep Alpine default but provide first-class glibc override path.
   - Compare: image size, pull/start latency, native-module compatibility, and operational complexity.

3. **Design shared installer abstraction for shell paths**
   - Introduce standard script fragment/utility used by:
     - `packages/operator/src/pod-builder.ts`
     - `packages/manager-controller/src/agent/tools.ts` (`install_packages`)
     - helper scripts currently doing `apk add git`
   - Detection order proposal:
     - if `apk` exists → `apk update --quiet && apk add --no-cache ...`
     - else if `apt-get` exists → `apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y ...`
     - else fail with explicit “unsupported package manager” error.

4. **Refactor manager install tool and security framing**
   - Update MCP tool descriptions to distro-neutral wording.
   - Update `agent/security.ts` comments/tests from Alpine-only framing to package-manager-agnostic token validation.
   - Preserve strict package token validation and no-shell-metacharacter guarantees.

5. **Remove ad-hoc git install in helper paths where feasible**
   - `packages/manager-controller/src/agent/tools.ts` read-plan fallback commands.
   - `packages/web/src/server/routes/task-diff.ts` command prelude.
   - Prefer relying on a git-capable image baseline; only install git dynamically when absolutely required.

6. **Unify cleanup image fallback strategy**
   - Replace hardcoded `"alpine/git"` defaults in:
     - `packages/manager-controller/src/reconciler/effects.ts`
     - `packages/operator/src/ttl.ts`
   - Ensure cleanup pods use runner-aligned image assumptions (`git` + `sh` present) regardless of distro.

7. **Plan runner Dockerfile/base-image changes**
   - If glibc base is selected, validate whether `gcompat`, `gnu_stub.c`, and `LD_PRELOAD` can be removed.
   - Verify parity for required tools (`git`, `ssh`, `gh`, `node/npm`, `bun`, `pnpm`, `ripgrep`, locale/ICU support).

8. **Align API comments and docs**
   - Update wording in:
     - `packages/api/src/index.ts` comments around `RunnerPackagesSchema`
     - `README.md` runner section
     - `AGENTS.md` runner package + MCP package tools sections
     - `SECURITY.md` package validation section
   - Document distro package-name differences and how users should choose names.

9. **Add/adjust tests for deterministic coverage**
   - Unit:
     - installer command generation/detection in `pod-builder` tests
     - manager package validation + command construction tests
     - cleanup fallback image selection tests
   - E2E/smoke:
     - verify runner package installation behavior in selected strategy (at least one deterministic path that does not assume Alpine-only internals).

10. **Rollout in guarded phases**
    - Phase 1: abstraction + docs + tests, no default image change.
    - Phase 2: canary on internal project(s), monitor success rate/startup latency.
    - Phase 3: optional default switch once canary SLOs are met.

---

## Proposed BUILD task breakdown

1. **BUILD 1 — Inventory + ADR decision**
   - Output: Alpine coupling inventory, option matrix, and signed decision (dual-support first vs immediate glibc-default).

2. **BUILD 2 — Distro-agnostic package install abstraction**
   - Output: shared installer behavior in operator + manager tools, with security-safe command handling.

3. **BUILD 3 — Helper/cleanup path decoupling from Alpine**
   - Output: remove `apk add git` helper assumptions where possible; align cleanup pod image defaults across manager/operator.

4. **BUILD 4 — Runner base update (conditional) + compatibility checks**
   - Output: runner image adjustments (if selected), validated capability parity, explicit keep/remove decision for glibc workaround layers.

5. **BUILD 5 — Tests, docs, rollout/rollback guide**
   - Output: updated unit/e2e coverage, docs aligned to distro-neutral semantics, operational canary + rollback instructions.

---

## Risks / open questions

1. **Upstream base-image constraints**
   - Need confirmation whether the opencode upstream image family supports a glibc-friendly base flow without losing required behavior.

2. **Package-name portability**
   - Existing `spec.runner.packages` values may not map 1:1 between Alpine and Debian/Ubuntu.

3. **Native module regressions**
   - Removing current Alpine glibc workarounds could break provider paths that motivated `gnu_stub` in the first place.

4. **Security drift risk**
   - Broadening package-manager support increases script complexity; token validation and shell hardening must remain strict.

5. **Performance and cost tradeoff**
   - glibc-based image may increase size/startup time; must be measured, not assumed.

6. **Operational consistency**
   - Cleanup, manager maintenance, and runner images must share consistent tooling assumptions to avoid hidden distro drift.
