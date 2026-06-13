# Plan: Evaluate and reduce Alpine-related runner friction

**Task:** percussionist-dev-plan-dca264  
**Project:** percussionist-dev  
**Goal:** Determine whether a non-Alpine runner base (or a distro-agnostic runner design) would reduce operational friction, and define an implementation path that preserves existing Percussionist workflows.

---

## Context

Current runner behavior is tightly coupled to Alpine:

- `images/runner/Dockerfile` uses `apk` for runtime tooling and includes Alpine-specific compatibility workarounds (`gcompat`, `gnu_stub.c`, `LD_PRELOAD=/usr/local/lib/libgnustub.so`) to satisfy glibc-linked native modules.
- Run bootstrap scripts in `packages/operator/src/pod-builder.ts` install project-declared tools via:
  - `apk update --quiet && apk add --no-cache $RUNNER_PACKAGES`
- Manager MCP tooling is Alpine-specific:
  - `install_packages` in `packages/manager-controller/src/agent/tools.ts` shells out to `apk add`
  - package validation in `packages/manager-controller/src/agent/security.ts` explicitly uses Alpine package token rules
  - `read_plan` fallback paths in the same file run `apk add --no-cache git` before `git show`
- Web route `packages/web/src/server/routes/task-diff.ts` also prepends `apk add --no-cache git` before git operations.
- Docs and API surface expose Alpine semantics:
  - README + AGENTS describe `spec.runner.packages` as Alpine packages installed with `apk`
  - SECURITY.md references `apk` validation guarantees.
- There is also a latent mismatch in manager cleanup fallback image selection (`packages/manager-controller/src/reconciler/effects.ts` uses fallback `"alpine/git"`), which further assumes Alpine tooling.

Net: Alpine is not just the runner image base; it is an implicit contract across operator scripts, manager tools, docs, security assumptions, and tests. A base-image swap without architecture changes would break package install and helper flows.

---

## Scope boundaries

### In scope

- Planning and designing a safe migration path from Alpine-only assumptions to distro-agnostic runner behavior.
- Deciding whether the preferred target is:
  1. full migration to glibc-based runner base (e.g., Debian/Ubuntu), or
  2. dual support (Alpine + glibc) with runtime package-manager detection.
- Defining required code, schema, test, and documentation updates.

### Out of scope (for this task)

- Immediate code implementation in this PLAN run.
- Large unrelated refactors of operator/manager reconciliation logic.
- Changing external product behavior beyond runner image + package installation semantics.

---

## Approach

Use a **decision-first, compatibility-preserving** strategy:

1. **Map all Alpine couplings** and classify each as runtime-critical vs convenience.
2. **Prototype target base options** (Alpine baseline vs glibc-based) and compare reliability, image size, startup time, and tool compatibility.
3. **Introduce a package-manager abstraction layer** in run bootstrap and manager tooling so image base can vary.
4. **Migrate docs/API semantics from “Alpine packages” to “system packages”** while preserving backward compatibility.
5. **Gate migration with deterministic tests** that validate both package install paths and existing run lifecycle flows.

Key design decision to make early:

- **Preferred path:** dual-runtime support initially (auto-detect `apk`/`apt-get`) to de-risk rollout.
- **Optional phase-2:** switch default runner image to a glibc base after compatibility and perf validation.

---

## Acceptance criteria

1. A written architecture decision records whether Percussionist remains Alpine-first, becomes glibc-first, or supports both.
2. All current hardcoded `apk` call sites used by run bootstrap and manager tools have a distro-agnostic implementation plan.
3. Runner package semantics are documented as distro-neutral, with explicit compatibility notes.
4. Migration includes deterministic verification updates (unit/e2e where relevant) for package installs and affected helper flows.
5. Rollout plan includes fallback/rollback guidance if the new base image increases failures or startup latency.

---

## Tasks

1. **Create an Alpine-coupling inventory**
   - Audit and catalog all Alpine-specific call sites and assumptions in:
     - `images/runner/Dockerfile`
     - `packages/operator/src/pod-builder.ts`
     - `packages/manager-controller/src/agent/tools.ts`
     - `packages/manager-controller/src/agent/security.ts`
     - `packages/web/src/server/routes/task-diff.ts`
     - `packages/manager-controller/src/reconciler/effects.ts`
     - README/AGENTS/SECURITY docs
   - Classify each item as: must-change for base swap / optional cleanup.

2. **Define runner base image candidates and evaluation matrix**
   - Candidate A: current Alpine-based runner (control).
   - Candidate B: glibc-based runner (Debian/Ubuntu-style) with equivalent toolchain.
   - Candidate C: keep current default but enable explicit glibc override path via `spec.image` and docs.
   - Measure: build complexity, image size, startup latency, tool compatibility (git/gh/node/bun/pnpm), and native module behavior (especially paths currently requiring `gcompat` + `gnu_stub`).

3. **Draft package-manager abstraction design**
   - Specify a shared runtime installer contract used by:
     - workspace-init scripts in `pod-builder.ts`
     - manager `install_packages` tool
     - any ad-hoc git bootstrap callsites that currently do `apk add git`
   - Define behavior order, e.g.:
     - if `apk` exists → Alpine path
     - else if `apt-get` exists → Debian/Ubuntu path
     - else fail with actionable error
   - Define package cache/update strategy per manager (`apk update` vs `apt-get update`).

4. **Plan API and terminology alignment**
   - Keep `spec.runner.packages` schema as-is for compatibility.
   - Update language from “Alpine packages” to “system packages available via image package manager.”
   - Decide whether security validation remains regex-based per package manager or moves to stronger argument-safe execution with minimal token validation.

5. **Plan manager tool hardening for multi-distro support**
   - Update `install_packages` implementation and its tool description in `tools.ts`.
   - Refactor Alpine-specific validation comments and tests in `security.ts` / `security.test.ts` to distro-neutral policy.
   - Replace `apk add git` helper snippets in:
     - manager `read_plan` fallback commands
     - web `task-diff` command assembly
   - Prefer using base image guarantees (git preinstalled) where possible to avoid repeated package installs.

6. **Plan runner Dockerfile simplification opportunities**
   - If moving to glibc base, evaluate removing:
     - `gcompat`
     - `gnu_stub.c` compile step
     - `LD_PRELOAD` workaround
   - Ensure equivalent runtime capabilities (tini, git, openssh, gh, node/npm, bun, pnpm, ripgrep, ICU locale support).

7. **Plan cleanup-image consistency fix**
   - In `packages/manager-controller/src/reconciler/effects.ts`, replace `"alpine/git"` fallback with runner-aligned default to avoid distro drift in cleanup pods.
   - Verify this is consistent with `spawnWorktreeCleanupPod` requirement (“image must have git and sh available”).

8. **Plan test updates**
   - Unit tests:
     - `packages/operator/src/pod-builder.test.ts` for installer script generation and fallback logic.
     - `packages/manager-controller/src/agent/__tests__/security.test.ts` for updated package validation/command construction semantics.
     - `packages/manager-controller/src/reconciler/__tests__/effects.test.ts` for cleanup image selection behavior.
   - E2E/smoke updates:
     - Add or extend deterministic path that validates `spec.runner.packages` installation under chosen base image strategy.

9. **Plan docs and migration communication**
   - Update:
     - `README.md` Runner Packages section
     - `AGENTS.md` runner package/tool sections
     - `SECURITY.md` package-install validation section
   - Add migration notes: expected behavior changes, known package-name differences between distros, and rollback instructions.

10. **Define rollout sequence**
    - Phase 1: ship distro-agnostic installer + docs (no default image change).
    - Phase 2: optional canary default-image switch for internal project(s).
    - Phase 3: make glibc image default only if canary metrics are stable.

---

## Proposed BUILD task breakdown

1. **BUILD A — Coupling inventory + ADR**
   - Deliverables: inventory doc, decision matrix, chosen strategy (Alpine-only vs dual vs glibc-default).

2. **BUILD B — Package-manager abstraction in operator + manager tools**
   - Deliverables: distro-aware install execution path for workspace-init and `install_packages`; removal of hardcoded `apk` snippets in helper commands.

3. **BUILD C — Runner image/base adjustments**
   - Deliverables: Dockerfile/base updates (or explicit no-change decision), cleanup image fallback consistency fix, retained runtime tool parity.

4. **BUILD D — Tests, docs, and rollout guardrails**
   - Deliverables: updated unit/e2e coverage, README/AGENTS/SECURITY updates, rollout + rollback playbook.

---

## Risks / open questions

1. **Upstream runtime constraints**
   - Need confirmation that `ghcr.io/anomalyco/opencode:*` supports (or has an equivalent for) the desired glibc base workflow.

2. **Package-name divergence across distros**
   - `spec.runner.packages` values that work on Alpine may not exist with the same names on Debian/Ubuntu.

3. **Behavior drift from removing Alpine workarounds**
   - If glibc workarounds are removed, must validate all provider/native module paths that motivated `gnu_stub` in the first place.

4. **Tooling/security policy complexity**
   - Multi-distro install support can broaden command surface area; command construction and validation must remain injection-safe.

5. **Image size and cold-start tradeoffs**
   - glibc-based images may reduce compatibility hacks but increase image size and pull/start latency; needs measured data before default switch.
