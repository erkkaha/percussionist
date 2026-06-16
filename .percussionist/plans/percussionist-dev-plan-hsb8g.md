# Plan: Docs accuracy sweep (README, AGENTS.md, docs/) — `percussionist-dev-plan-hsb8g`

## Scope

Apply documentation-only corrections from the code-hallucination scan and docs-accuracy fixes. This plan intentionally excludes runtime/code behavior changes and focuses on aligning docs with current implementation.

### In scope

- `README.md`
- `AGENTS.md`
- `docs/` markdown pages that currently repeat the same inaccuracies

### Out of scope

- Any TypeScript/CRD/controller/operator code changes
- Behavior changes to storage classes, host-key verification, CLI flags, or MCP ports
- New features or major doc restructuring unrelated to factual corrections

---

## Context

From repository inspection:

- **Data PVC model is unified under `/data`**, not a standalone `/cache` PVC.
  - Source of truth comments and schema: `packages/api/src/index.ts` (`RunSpecSchema.spec.data`, `ProjectSpecSchema.data`)
  - Operator defaults: `packages/operator/src/config.ts`
    - `DEFAULT_STORAGE_ACCESS_MODE = ReadWriteOnce`
    - `DEFAULT_STORAGE_SIZE = 50Gi`
- **README currently contains stale cache docs** describing a separate 5Gi/RWX `/cache` PVC and `spec.cache` overrides (`README.md`, caching section around lines ~590–657).
- **CLI board flags in README command table are stale**:
  - Docs currently show `--id` / `--task-id`
  - Actual CLI flags are `--title`, `--agent`, and `--task-name`
  - Source of truth: `packages/cli/src/index.ts` (`board task add/move/remove` options)
- **AGENTS verification snippet has a port mismatch**:
  - Config points to manager MCP at `http://127.0.0.1:4097/mcp`
  - Verification command uses `http://127.0.0.1:4096/mcp`
  - File: `AGENTS.md` (MCP configuration section)
- **CRD count mismatch exists in README**:
  - README says “all three CRDs”
  - Actual CRDs are 5 (`run`, `project`, `task`, `clusteragent`, `clustersettings`), corroborated by `k8s/crds/*.yaml` and `docs/reference/crds.md`
- **SSH host key verification docs are inconsistent with implementation defaults**:
  - Schema default is `sshHostKeyVerification: "no"` (`packages/api/src/index.ts`)
  - `docs/security.md` currently states `strict` is default and uses mode name `off`
  - Canonical mode set in code: `strict`, `accept-new`, `no`
- Additional drift found in `docs/`:
  - `docs/guide/configuration.md` says data PVC defaults are `10Gi` + `ReadWriteMany`
  - `docs/task-lifetime.md` describes auto-created data PVC as `ReadWriteMany`

---

## Approach

Use a **source-of-truth-first docs sync**:

1. Treat runtime defaults and allowed enum values in `packages/api/src/index.ts` and `packages/operator/src/config.ts` as authoritative.
2. Update user-facing docs to match current behavior and naming exactly.
3. Normalize repeated wording across README/AGENTS/docs to avoid future drift (especially for storage defaults, CLI flags, and SSH host-key modes).
4. Keep edits minimal and surgical (fact corrections only), preserving existing structure unless a section is fundamentally obsolete (e.g., separate `/cache` PVC narrative).

Key decisions:

- Reframe README caching section around the **project data PVC** (`{project}-data`) and `/data/cache/*` paths.
- Remove/replace `spec.cache` override examples with `spec.data` (or explicitly document current supported knobs).
- Use exact CLI option names from `packages/cli/src/index.ts`.
- Keep manager MCP docs consistently on `4097/mcp`; reserve `4096` references for opencode-web only where applicable.
- Use “5 CRDs” consistently across README and docs.
- Standardize SSH host-key mode names to `strict | accept-new | no`, with default `no`.

---

## Tasks (implementation breakdown)

1. **Fix README CRD count and deploy wording**
   - File: `README.md`
   - Update install/deploy language from “three CRDs” to “five CRDs”.
   - Ensure nearby phrasing still accurately reflects operator + manager + web deployment behavior.

2. **Correct README board CLI flags in command table**
   - File: `README.md`
   - Replace stale examples:
     - `board task add ... --id X --title Y --agent Z` → `board task add ... --title ... --agent ...`
     - `--task-id` usages for move/remove → `--task-name`
   - Keep table style and terse explanations unchanged.

3. **Rewrite README caching section to unified data PVC model**
   - File: `README.md` (Caching section)
   - Replace separate `/cache` PVC narrative with `{project}-data` PVC model.
   - Update defaults to `50Gi` and `ReadWriteOnce` (with note that RWX is optional via storage/access-mode override).
   - Update path examples from `/cache/*` to `/data/cache/*`.
   - Remove or replace obsolete `spec.cache` override example with current `spec.data` configuration fields.

4. **Correct SSH host-key verification docs in README**
   - File: `README.md` (git/SSH-related sections)
   - Ensure mode names match schema (`strict`, `accept-new`, `no`).
   - Correct default to `no` (backward compatibility default).
   - Replace any `off` terminology with `no` if present.

5. **Fix AGENTS MCP verification command port mismatch**
   - File: `AGENTS.md`
   - In MCP verification snippet, change `http://127.0.0.1:4096/mcp` to `http://127.0.0.1:4097/mcp`.
   - Confirm surrounding explanatory text remains internally consistent.

6. **Sweep docs for storage default inaccuracies**
   - Files:
     - `docs/guide/configuration.md`
     - `docs/task-lifetime.md`
     - any other matched pages under `docs/` with `10Gi`/`ReadWriteMany` default claims
   - Update defaults to `50Gi` + `ReadWriteOnce` where discussing operator defaults.
   - Preserve nuance: RWX remains a deployment option when supported by storage class/access mode overrides.

7. **Sweep docs for SSH host-key mode inaccuracies**
   - Primary file: `docs/security.md`
   - Update default mode from `strict` to `no`.
   - Update mode name `off` → `no` and align behavior descriptions to code comments.

8. **Cross-check CLI docs page against actual flags (sanity pass)**
   - File: `docs/reference/cli.md`
   - Verify board command examples already use `--title/--agent/--task-name`; keep as-is if accurate.
   - If any drift found elsewhere in page, align to `packages/cli/src/index.ts`.

9. **Consistency pass across README + AGENTS + docs/**
   - Run targeted string checks for:
     - `--task-id`, `--id` (board context)
     - “three CRDs”
     - `/cache` PVC phrasing implying separate cache PVC
     - defaults `10Gi`, `ReadWriteMany` when claiming platform defaults
     - SSH mode `off` and default `strict`
     - `4096/mcp` verification snippets for manager MCP
   - Resolve residual inconsistencies.

10. **Validation and acceptance check (docs-only)**
    - Confirm diff touches docs only (`README.md`, `AGENTS.md`, `docs/**/*.md` and plan artifact).
    - Verify each required correction from task description is explicitly addressed.

---

## Acceptance criteria

- README no longer describes a separate `/cache` PVC; it documents caches under unified `/data` PVC paths.
- README board CLI flags match implemented CLI (`--title`, `--agent`, `--task-name`) with no stale `--id`/`--task-id` board examples.
- AGENTS MCP verification snippet uses `http://127.0.0.1:4097/mcp`.
- README/docs do not claim “three CRDs”; CRD count is 5 where stated.
- Docs default storage values reflect code defaults (`50Gi`, `ReadWriteOnce`) and present RWX as optional/override.
- SSH host-key mode names/defaults match schema (`strict`, `accept-new`, `no`; default `no`).
- Only documentation files are modified.

---

## Risks / open questions

1. **Potential partial truth by deployment context**
   - Some docs may intentionally discuss RWX for specific clusters. Mitigation: phrase defaults vs optional overrides explicitly.

2. **Legacy wording spread across many docs**
   - Similar stale phrases may exist in non-obvious sections. Mitigation: run focused grep-based consistency sweep before finalizing.

3. **Schema defaults vs operational overrides**
   - Operators can override env defaults at deploy time. Docs should clearly mark what is code default versus cluster override.

4. **Scope creep risk**
   - While sweeping, additional inaccuracies may appear. Keep this task constrained to the listed accuracy fixes plus immediate consistency fixes discovered by targeted search.

---

## Proposed BUILD task breakdown

1. **BUILD A — README accuracy patch**
   - Fix CRD count, board CLI flags, caching/data PVC section, and SSH host-key terminology/defaults in `README.md`.

2. **BUILD B — AGENTS MCP port and command doc sync**
   - Correct `AGENTS.md` 4096/4097 verification mismatch and adjacent MCP wording consistency.

3. **BUILD C — docs/ defaults + security consistency sweep**
   - Update `docs/guide/configuration.md`, `docs/task-lifetime.md`, `docs/security.md` (and any additional affected docs) for PVC defaults and SSH mode/default correctness.

4. **BUILD D — final docs consistency verification pass**
   - Perform targeted grep checks for stale strings, resolve leftovers, and provide a concise verification summary in commit/PR notes.
