# Plan: Ubuntu/Debian support for runner (trimmed)

**Task:** percussionist-dev-plan-dca264  
**Project:** percussionist-dev  
**Goal:** add first-class Debian/Ubuntu runner support and remove hard Alpine-only assumptions.

## Implementation context

- `images/runner/Dockerfile` is Alpine-specific (`apk`, `gcompat`, `gnu_stub.c`, `LD_PRELOAD`).
- `packages/operator/src/pod-builder.ts` installs `spec.runner.packages` with `apk` in workspace-init.
- `packages/manager-controller/src/agent/tools.ts` `install_packages` hardcodes `apk`.
- Helper paths still run `apk add ... git` before git operations.
- Docs/API comments describe runner packages as Alpine/apk-specific.

## Scope boundaries

### In scope
- Add Debian/Ubuntu-capable runner path.
- Make runtime package install logic support both `apk` and `apt-get`.
- Keep `spec.runner.packages` field stable (no CRD rename).
- Update docs/comments/tests to distro-neutral wording.

### Out of scope
- Large task/reconciler redesigns unrelated to package installation.
- Breaking changes to Project/Run schemas.

## Approach

Use **dual support** first, then decide default image:
1. Keep Alpine working.
2. Add `apt-get` path wherever `apk` is currently assumed.
3. Ensure git-dependent helpers no longer assume `apk`.
4. Validate in tests and canary runs before any default flip.

## Acceptance criteria

1. Runner workflows work on Alpine and Debian/Ubuntu bases.
2. No critical path is hardcoded to `apk` only (`workspace-init`, manager install tool, helper git commands).
3. Security validation for package names remains enforced.
4. Docs clearly explain distro-dependent package names.
5. BUILD verification includes at least one Debian/Ubuntu runner scenario.

## Tasks

1. **Runner image strategy**
   - Add Debian/Ubuntu-compatible runner Dockerfile path (or build arg path) under `images/runner/`.
   - Confirm required tool parity (`git`, `ssh`, `bash`, `curl`, `gh`, `node/npm`, `bun`, `pnpm`, `ripgrep`).

2. **Package-manager abstraction in operator init**
   - Update `packages/operator/src/pod-builder.ts` script fragment:
     - if `apk` exists → current install flow
     - else if `apt-get` exists → `apt-get update && apt-get install -y ...`
     - else fail with clear error.

3. **Manager install tool support for apt**
   - Update `packages/manager-controller/src/agent/tools.ts` `install_packages` command generation for dual manager support.
   - Keep `isValidPackageName()` guard in place; make wording distro-neutral.

4. **Remove Alpine-only git bootstrap assumptions**
   - Replace `apk add git` prelude in helper flows with distro detection or baseline git guarantee.

5. **Docs and API wording**
   - Update Alpine-specific wording in `README.md`, `AGENTS.md`, `SECURITY.md`, and relevant comments in `packages/api/src/index.ts`.

6. **Tests and rollout**
   - Add/adjust unit tests for package-manager selection and command construction.
   - Add deterministic validation path for Debian/Ubuntu runner.
   - Canary deploy; switch default runner base only if canary is stable.

## Proposed BUILD task breakdown

1. **BUILD 1 — Dual package-manager plumbing**
   - Operator + manager command generation supports `apk` and `apt-get`.

2. **BUILD 2 — Runner image Debian/Ubuntu support**
   - Debian/Ubuntu runner path with required tool parity.

3. **BUILD 3 — Helper cleanup + docs**
   - Remove Alpine-only helper assumptions, update API/docs text.

4. **BUILD 4 — Tests + canary validation**
   - Unit/e2e coverage plus canary acceptance report and default-switch recommendation.

## Risks / open questions

1. Some `spec.runner.packages` names differ between Alpine and Debian/Ubuntu.
2. Debian/Ubuntu image size/startup time may increase.
3. If glibc path replaces Alpine workarounds, native provider compatibility must be rechecked.
4. Decision needed: long-term default stays Alpine, flips to Debian/Ubuntu, or remains configurable.
