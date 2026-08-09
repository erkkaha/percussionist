# Plan: Validation gaps — Zod-only invariants enforced nowhere, claude-code skips auth preflight, code-server image default conflict, codegen drift

**Task:** `percussionist-dev-plan-rev18`

Four related hardening gaps in the schema → CRD → reconcile pipeline. Each has a
cheap, surgical fix; three of the four are pure verification/plumbing fixes with
no behavior change beyond failing fast and loudly.

## Context

### Gap 1 — Zod-only invariants are enforced nowhere (Run + Project)

`packages/api/src/index.ts:3-5` claims *"When they disagree the Zod definition
wins at admission time inside the operator"* — but the operator never Zod-parses
any CR, and the generated CRDs contain no CEL equivalents of the `.refine()`
rules.

- `packages/operator/src/reconciler.ts:426` (`reconcile()`) reads `run.spec`
  fields directly; the informer (`packages/operator/src/index.ts:79-81`)
  hands raw CRs to the worker with no schema pass. Verified: `RunSchema` /
  `ProjectSchema` / `*.safeParse` appear nowhere in `packages/operator/src`.
- `codegen/gen-crds.mjs` builds CRDs via `z.toJSONSchema(..., { target:
  'openapi-3.0' })` (gen-crds.mjs:108-117), which has **no representation for
  `.refine()`** — verified by regenerating: current `k8s/crds/*.yaml` match
  codegen output byte-for-byte and contain zero `x-kubernetes-validations`.
- The two invariants the task names:
  - **RunSpecSchema** (api:740-743): `.refine((s) => s.interactive || !!s.task)`
    with message `'spec.task is required unless spec.interactive is true'`.
    A kubectl-applied Run with neither field is admitted; pod-builder then
    emits no `RUN_TASK` env (`packages/operator/src/pod-builder.ts:1075`) and
    the dispatcher exits `process.exit(2)` with "missing required env:
    RUN_TASK" (`packages/dispatcher/src/index.ts:51`) — an opaque in-pod
    failure, or worse an auto-prompted session with an empty task
    (`packages/dispatcher/src/polling.ts:936`).
  - **SourceSchema** (api:358-360): `.refine((s) => !(s.git && s.local))` with
    message `'source.git and source.local are mutually exclusive'`. Used by
    **both** `RunSpecSchema` (api:699) **and** `ProjectSpecSchema` (api:1110).
    A contradictory source is admitted; pod-builder's `workspaceSubPath`
    (`pod-builder.ts:744`) picks git and ignores local, and code-server renders
    an inconsistent mount set.
- A third refine exists (`DiffLineAnchorSchema`, api:1398) but is status-level
  (review findings), not a Run admission invariant — **out of scope**.
- The operator already has the exact surfacing pattern needed: the
  `assertCredentialsUnambiguous` catch in `reconcile()` (reconciler.ts:467-479)
  patches `{ phase: RunPhase.Failed, message }` and returns, and
  `RunPhase.Failed` ∈ `TERMINAL_PHASES` (api:758-762) so the terminal-phase
  guard (reconciler.ts:432-453) short-circuits all future reconciles — no retry
  storm. The Project side has the same pattern via `safeReconcileProject`
  (reconciler.ts:1106+) → `status.reconcile = { state: 'Error', message,
  observedGeneration }` with the `hasReconcileStatusChanged` loop guard
  (reconciler.ts:1140-1150).

### Gap 2 — `validateModelAuth` does not know `claude-code`

- `CLOUD_PROVIDERS` (`packages/kube/src/index.ts:2037-2054`) lacks
  `'claude-code'` (`CLAUDE_ENGINE_PROVIDER_ID`, api:152). Unrecognized
  providers fall through to `return { ok: true }` (kube:2115), so a
  `claude-code/claude-opus-5` model with no secrets passes the pre-flight check
  on **every** run-creation path: `worker-builder.ts:94`,
  `facilitator.ts:522`, `agent/tools.ts:1386` + `:1554`, `cli/submit.ts:354`,
  and the web routes (`projects.ts:186/271`, `board.ts:209`).
- The run then dies opaquely in the pod: `resolveAuthSecretKey`
  (`pod-builder.ts:204-211`) only mounts an auth value when
  `spec.secrets.authSecret` is set (key falls back to
  `runner.authEnvVar` = `CLAUDE_CODE_OAUTH_TOKEN` for the claude engine).
- `parseModelProvider` (kube:2085-2089) duplicates `parseModelRef`
  (api:162-170) — identical first-slash split, and `parseModelRef` is already
  the canonical helper used by `deriveEngine` (api:189-193). Its only consumers
  are `validateModelAuth` (kube:2110) and the kube unit test.

### Gap 3 — two contradictory code-server image defaults

- `CodeServerSpecSchema.image` default `'codercom/code-server:4.96.4'`
  (api:225) is stamped onto every Project CR at admission — the CRD preserves
  Zod defaults deliberately (gen-crds.mjs:54-61), so `spec.codeServer.image` is
  **always present** after admission.
- The operator fallback `CODE_SERVER_DEFAULT_IMAGE =
  'ghcr.io/erkkaha/percussionist/code-server:latest'` (api:1909) used at
  `packages/operator/src/code-server.ts:82` (`spec.codeServer?.image ??
  CODE_SERVER_DEFAULT_IMAGE`) is therefore **dead code** — the custom image
  never ships.
- The ghcr image is the tooled one: `images/code-server/Dockerfile` extends
  codercom with bun, pnpm, node, npm, ripgrep, jq — exactly what a human needs
  in a Percussionist workspace — and it **is** in the CI publish matrix
  (`.github/workflows/images.yml:53-55` → `ghcr.io/erkkaha/percussionist/code-server`).
- The web form carries the same literal in three places:
  `useProjectForm.ts:498` (payload builder), `useProjectForm.ts:617` (initial
  state), `WorkspaceServicesTab.tsx:67` (placeholder), and tests assert it
  (`packages/web/tests/project-form.test.ts:56, 69, 85, 291`).
- Local dev loads `percussionist/code-server:dev` with **no ghcr alias**
  (`scripts/minikube-load.sh:349`), unlike runner/dispatcher which get ghcr
  aliases (minikube-load.sh:343-345, 368-374) so a local build shadows the
  published one.

### Gap 4 — codegen drift on `spec.engine` description

- Current state verified: `k8s/crds/run.yaml` matches `node
  codegen/gen-crds.mjs` output **byte-for-byte** — the hand-edited description
  block on `spec.engine` was already silently deleted by a prior regeneration
  (commit `f0fdecd` "feat(api): add humanFolder schema and regenerate CRDs";
  `git show 00ba2d0:k8s/crds/run.yaml` still has it). So the drift the task
  describes is already a *fait accompli*; the remaining work is to restore the
  description **as generated output** so it can never be deleted again.
- The description text survives only as a code comment above the field
  (api:660-662). `z.toJSONSchema` emits `.describe()`, not comments. Verified:
  `.describe()` on an enum field flows into the CRD schema as a `description`
  key.
- Exact text to restore (from the deleted CRD block):
  `Agent runtime for this run. "opencode" (default) uses the opencode runner; "claude" uses the runner-claude image, which serves the same runner HTTP contract backed by the Claude Agent SDK and authenticates via spec.secrets.authSecret holding a CLAUDE_CODE_OAUTH_TOKEN.`

## Approach

**Gap 1 — Zod-validate specs at the operator reconcile entry point (primary);
CEL explicitly deferred.** The task allows either "emit x-kubernetes-validations
CEL rules from codegen" or "Zod-validate at the operator reconcile entry point".
Zod-at-reconcile is the better fit here:

- **Zero drift:** the validation *is* the Zod schema (`RunSpecSchema` /
  `ProjectSpecSchema`), so the "Zod definition wins" comment becomes literally
  true with no second source of truth. CEL would require a hand-maintained
  refine→CEL mapping table in `gen-crds.mjs` — a fresh drift surface of exactly
  the kind this task is about (and `.refine()` closures are not introspectable,
  so it cannot be generated).
- **No cluster-version constraint:** `x-kubernetes-validations` needs k8s ≥ 1.25
  and rejects the CRD apply on older API servers; the repo targets minikube /
  k3s / kind / docker-desktop / homelab with no pinned version.
- **Surfaced failure:** a failed Run gets `status.phase = Failed` with an
  actionable message (dispatcher never starts; the board flow already treats
  Failed as the trigger for facilitation/retry — see rev03). A failed Project
  gets `status.reconcile.state = Error` with no retry, exactly like the
  existing permanent-4xx classification.
- **Compose-safe:** a future CEL rule would only reject earlier at admission;
  it would never conflict with the reconcile-time check.

Concretely: a new pure module `packages/operator/src/spec-validation.ts` with
`validateRunSpec(spec)` and `validateProjectSpec(spec)` wrapping
`RunSpecSchema.safeParse` / `ProjectSpecSchema.safeParse` and formatting Zod
issues as `path.join('.') + ': ' + message`. `reconcile()` calls it right after
the terminal-phase guard and before the credentials check, patching Failed on
failure; `reconcileProjectOnce` calls it before `reconcileProject`, patching
`status.reconcile = { state: 'Error', ... }` on failure (permanent — no retry).

**Gap 2 — one-line provider addition + de-duplication.** Add `'claude-code'` to
`CLOUD_PROVIDERS` (kube:2037-2054); `validateModelAuth` already accepts
`secrets.authSecret` (kube:2117), which is the correct channel for claude-code
(`resolveAuthSecretKey` maps it to `CLAUDE_CODE_OAUTH_TOKEN`). Replace the
duplicate `parseModelProvider` with api's `parseModelRef` inside
`validateModelAuth` (and `requiresCloudAuth` for consistency) and delete
`parseModelProvider` (only consumer is the internal call + the unit test). Make
the failure message provider-aware: for `claude-code`, point at
`spec.secrets.authSecret` holding `CLAUDE_CODE_OAUTH_TOKEN` — the generic
message's `llmKeysSecret` / `ANTHROPIC_API_KEY` advice is wrong for this
provider (it needs an OAuth token, not an API key).

**Gap 3 — one default: `ghcr.io/erkkaha/percussionist/code-server:latest`.**
It is the published, tooled image (bun/pnpm/node/ripgrep/jq on top of
codercom:4.96.4) and is what the operator already tries to fall back to. Move
the `CODE_SERVER_DEFAULT_IMAGE` constant above `CodeServerSpecSchema` and use it
in `.default()` (single source of truth; the operator import at
`code-server.ts:25` is unchanged), update the two web-form literals + the
placeholder, add the ghcr alias to `minikube-load.sh`'s code-server load so a
local build shadows the published image (mirroring the runner pattern), update
the web tests, and regenerate the Project CRD. Alternative considered and
rejected: keep `codercom:4.96.4` as the default and delete the ghcr constant +
operator fallback — that keeps shipping the untooled image; flagged for the
reviewer in case image-pull policy argues otherwise.

**Gap 4 — move the description into Zod.** Add `.describe(...)` with the exact
restored text to the `engine` field (api:663) and regenerate CRDs. The
description then survives every future `pnpm codegen`.

## Scope boundaries

**In scope:**
- `packages/operator/src/spec-validation.ts` (new, pure) + wiring in
  `reconciler.ts` (`reconcile()` and `reconcileProjectOnce`) + unit tests.
- `packages/kube/src/index.ts` (CLOUD_PROVIDERS, parseModelRef reuse,
  provider-aware message) + `packages/kube/src/__tests__/auth-validation.test.ts`.
- `packages/api/src/index.ts` (constant relocation + `.default()` wiring for the
  code-server image; `.describe()` on `engine`; header comment correction at
  api:3-5) + regenerated CRDs (`k8s/crds/project.yaml`, `k8s/crds/run.yaml`).
- `packages/web` form literals + placeholder + `project-form.test.ts`
  assertions; `scripts/minikube-load.sh` ghcr alias for code-server.

**Out of scope (explicitly):**
- CEL `x-kubernetes-validations` emission from codegen (deferred — rationale in
  Approach; design sketch in Risks).
- `DiffLineAnchorSchema` refine (status-level review-finding invariant).
- Validating ClusterAgent / ClusterSettings specs (no named invariants; not
  implicated in undefined-state runs).
- Manager-side `RunSpecSchema.safeParse` in `buildWorkerRun` /
  `buildFacilitatorRun` (optional hardening — noted in BUILD 1; the operator is
  the enforcement point and catches any creator).
- Surfacing validation failures in the web dashboard beyond what `status`
  already provides.

## Tasks

1. **New pure validation module** — Create `packages/operator/src/spec-validation.ts`:
   `export function validateRunSpec(spec: unknown): { ok: true } | { ok: false; error: string }`
   (uses `RunSpecSchema.safeParse`) and
   `export function validateProjectSpec(spec: unknown): { ok: true } | { ok: false; error: string }`
   (uses `ProjectSpecSchema.safeParse`). Format issues as
   `issue.path.join('.') + ': ' + issue.message`, joined by `'; '`. Keep the
   two named messages intact (`spec.task is required unless spec.interactive is
   true`, `source.git and source.local are mutually exclusive`).
2. **Wire validation into `reconcile()`** — In `reconciler.ts`, after the
   terminal-phase guard (line 432-453) and before the `deriveEngine` /
   credentials block (line 465+): `const specCheck = validateRunSpec(run.spec);
   if (!specCheck.ok) { err(...); await patchStatus(run, { phase:
   RunPhase.Failed, message: specCheck.error }); return; }` — mirroring the
   `assertCredentialsUnambiguous` catch at 467-479.
3. **Wire validation into the Project path** — In `reconcileProjectOnce`
   (reconciler.ts:1190), before `reconcileProject`: run `validateProjectSpec`;
   on failure log with the `[project/ns/name]` prefix and
   `patchProjectReconcileStatus(project, { state: 'Error', message:
   truncateReconcileMessage(error), observedGeneration })` (guarded by
   `hasReconcileStatusChanged`) then return — permanent, no retry.
4. **Unit tests for spec-validation** — `packages/operator/src/spec-validation.test.ts`:
   Run spec with neither `task` nor `interactive` → fails with the exact task
   message; with `interactive: true` → passes; with `task` → passes; Project
   spec with both `source.git` and `source.local` → fails with the exact
   message; each alone → passes; a spec with no source → passes (NAND, not
   XOR); `safeParse`-tolerant shapes (defaults absent) → passes.
5. **Reconcile-path tests** — Extend `packages/operator/src/reconciler-flow.test.ts`
   (or add a focused test): an invalid Run spec (no task, not interactive)
   reaches `status.phase = Failed` with the message and is not re-enqueued; a
   Project with contradictory source reaches `status.reconcile.state = Error`
   with no retry timer armed (assert via the existing fake-kube harness;
   terminal-phase guard prevents re-processing).
6. **Correct the api header comment** — Update `packages/api/src/index.ts:3-5`
   so the claim matches reality: the Zod definition wins at **reconcile time**
   inside the operator (Run/Project specs are re-validated); CRD defaults are
   authoritative at admission.
7. **Add `claude-code` to `CLOUD_PROVIDERS`** — `packages/kube/src/index.ts:2037-2054`:
   add `'claude-code'` to the set.
8. **Reuse `parseModelRef`; delete `parseModelProvider`** — In kube: import
   `parseModelRef` from `@percussionist/api` (already a dependency, kube:58);
   in `validateModelAuth` replace `parseModelProvider(model)` with
   `parseModelRef(model).providerID` (same semantics: no-slash → `undefined` →
   `{ ok: true }`); do the same in `requiresCloudAuth`; delete
   `parseModelProvider` (kube:2085-2089).
9. **Provider-aware failure message** — In `validateModelAuth`'s failure branch
   (kube:2119-2126): when `lowerProvider === 'claude-code'`, return
   `Model "<model>" uses provider "claude-code" which requires authentication. Set spec.secrets.authSecret to a Secret whose key holds the CLAUDE_CODE_OAUTH_TOKEN subscription token (e.g. produced by \`claude setup-token\`).`
   Keep the existing generic message for all other cloud providers (tests assert
   substrings `'requires authentication'`, `'authSecret'`, `'llmKeysSecret'`).
10. **kube auth-validation tests** — `packages/kube/src/__tests__/auth-validation.test.ts`:
    replace the `parseModelProvider` describe block with `parseModelRef`-based
    assertions (or drop it — `parseModelRef` is already covered by api tests);
    add `requiresCloudAuth('claude-code/claude-opus-5') === true`; add
    `validateModelAuth('claude-code/claude-opus-5')` → fails and the error
    mentions `CLAUDE_CODE_OAUTH_TOKEN`; with `{ authSecret: { name: 's' } }` →
    passes; add `'claude-code/claude'` to the "fails for all known cloud
    providers" list (test:126-149).
11. **Single source of truth for the image default** — In
    `packages/api/src/index.ts`: move `CODE_SERVER_DEFAULT_IMAGE`
    (currently api:1909) above `CodeServerSpecSchema` (api:221) and change the
    field to `image: z.string().default(CODE_SERVER_DEFAULT_IMAGE)` (api:225).
    `CODE_SERVER_PORT` may stay where it is.
12. **Web form literals** — Update `packages/web/src/client/components/project-form/useProjectForm.ts:498`
    and `:617` to the ghcr default, and the placeholder in
    `WorkspaceServicesTab.tsx:67`. Update the assertions in
    `packages/web/tests/project-form.test.ts` (lines 56, 69, 85, 291).
13. **minikube-load ghcr alias** — In `scripts/minikube-load.sh`: add
    `CODE_SERVER_GHCR_TAG="ghcr.io/erkkaha/percussionist/code-server:latest"`
    and load it alongside `CODE_SERVER_TAG` in both the `--only code-server`
    branch (line 378) and the all-images branch (after line 389), mirroring the
    runner/dispatcher alias pattern (343-345).
14. **Restore the engine description via `.describe()`** — In
    `packages/api/src/index.ts:663`: `engine: z.enum(RUNNER_ENGINES).describe('Agent runtime for this run. "opencode" (default) uses the opencode runner; "claude" uses the runner-claude image, which serves the same runner HTTP contract backed by the Claude Agent SDK and authenticates via spec.secrets.authSecret holding a CLAUDE_CODE_OAUTH_TOKEN.').optional(),`.
    Replace the now-redundant comment above it (api:660-662) with a short
    pointer to the describe text.
15. **Regenerate CRDs and verify** — Run `pnpm codegen` (builds api, writes
    `k8s/crds/`). Verify with `git diff k8s/crds/`: `project.yaml` changes only
    the codeServer image default; `run.yaml` gains only the engine `description`;
    the other three CRDs are byte-identical (no incidental drift). Re-run the
    codegen-output equivalence check (`node codegen/gen-crds.mjs --out /tmp/x &&
    diff -rq /tmp/x k8s/crds/`) to confirm the committed CRDs are exactly the
    generated ones.
16. **Full verification pass** — `pnpm typecheck && pnpm test && pnpm lint`
    from the repo root. `pnpm test` covers the operator, kube, api, and web
    suites; confirm no other package references `parseModelProvider` or the
    codercom literal (`grep -rn "parseModelProvider\|codercom/code-server" packages/`).

### Proposed BUILD task breakdown

Four BUILD tasks, each independently shippable:

- **BUILD 1 — Operator spec validation (Gap 1):** Tasks 1-6.
  `fix(operator): Zod-validate Run/Project specs at reconcile entry and fail with a clear status message`.
- **BUILD 2 — claude-code auth preflight (Gap 2):** Tasks 7-10.
  `fix(kube): treat claude-code as a cloud provider in validateModelAuth and reuse api parseModelRef`.
- **BUILD 3 — code-server image default (Gap 3):** Tasks 11-13 (+ CRD regen of
  `project.yaml` from Task 15). `fix(api,web): unify code-server image default on the published ghcr image`.
- **BUILD 4 — engine description (Gap 4):** Tasks 14 (+ CRD regen of `run.yaml`
  from Task 15). `docs(api): move spec.engine description into Zod describe() so codegen preserves it`.

BUILDs 3 and 4 both run `pnpm codegen`. They touch disjoint CRD files
(`project.yaml` vs `run.yaml`), so each BUILD should commit **only** the CRD
file(s) it changed and the untouched CRDs will merge cleanly (identical bytes on
both branches). If parallelism is a concern, order them with `predecessorRef`
(3 → 4 or 4 → 3). Task 16 runs in every BUILD; Task 6 lives in BUILD 1.

## Risks / open questions

- **Rollout of BUILD 1:** every existing Run/Project CR is validated on its next
  reconcile. The schemas are permissive (all fields optional, defaults applied),
  so false failures are unlikely — but an in-flight Run whose spec was
  previously tolerated (e.g. a hand-edited Run missing `task`) will now be
  force-Failed mid-flight. This is the intended behavior, but call it out in the
  BUILD 1 PR description.
- **CRD apply ordering (BUILDs 3/4):** the new defaults/description only take
  effect after `kubectl apply -f k8s/crds/`; deploy tooling already applies CRDs
  before manifests. Existing Project CRs keep their already-stamped codercom
  image until edited (admission-time defaulting is not retroactive) — operators
  who want the tooled image on existing projects must re-save them or patch
  `spec.codeServer.image`.
- **Local dev code-server after BUILD 3:** the new default references the
  published ghcr image. Before the next release it does not exist in the
  registry, so a dev cluster must either run `minikube-load.sh` (BUILD 3 adds
  the ghcr alias so the local build shadows the published image) or set an
  explicit per-project `spec.codeServer.image` (the web form already supports
  this). Without either, code-server pulls nothing and the Deployment is
  ImagePullBackOff — visible in `status.reconcile` thanks to rev03.
- **Message text (BUILD 2) is user-visible:** tests assert substrings
  (`'requires authentication'`, `'authSecret'`, `'llmKeysSecret'`) — the
  generic branch keeps them; only the claude-code branch diverges.
- **CEL deferred — design sketch if ever needed:** export a
  `CEL_VALIDATIONS` data table from `@percussionist/api`
  (`[{ rule: 'self.interactive == true || has(self.task)', message, path: 'spec' },
  { rule: '!has(self.git) || !has(self.local)', message, path: 'source' }]`)
  and have `gen-crds.mjs` inject `x-kubernetes-validations` into the matched
  schema nodes. Requires k8s ≥ 1.25 and a drift guard (a test asserting the
  refine messages still match the table). Not scheduled — BUILD 1 already makes
  the failure loud and early.
- **Open question for the reviewer:** delete `parseModelProvider` outright
  (recommended — internal-only, two consumers) vs. keep a one-line delegating
  shim for API stability. Task 8 assumes deletion.
- **Open question for the reviewer (Gap 3):** the ghcr tooled image as the
  single default (recommended) vs. reverting to upstream codercom and deleting
  the ghcr constant + operator fallback. The recommendation stands unless
  image-pull policy / registry availability argues otherwise.

## Acceptance criteria

- A kubectl-applied Run with neither `spec.task` nor `spec.interactive: true`
  reaches `status.phase = Failed` with message `task: spec.task is required
  unless spec.interactive is true` on the first reconcile, its pod is never
  created, and it is not retried (terminal guard). A valid Run (either field
  set) is unaffected. (BUILD 1)
- A Project (or Run) with both `spec.source.git` and `spec.source.local` set
  reaches `status.reconcile.state = Error` (Projects) / `status.phase = Failed`
  (Runs) with `source: source.git and source.local are mutually exclusive`, with
  no retry storm. (BUILD 1)
- `validateModelAuth('claude-code/claude-opus-5')` returns `ok: false` with a
  message naming `CLAUDE_CODE_OAUTH_TOKEN`/`authSecret`; with `authSecret` set it
  returns `ok: true`; `parseModelProvider` no longer exists and no package
  imports it; all existing generic-provider tests pass unchanged. (BUILD 2)
- The Project CRD's `codeServer.image` default, the operator fallback, the web
  form payload/initial-state defaults, and the form placeholder all name
  `ghcr.io/erkkaha/percussionist/code-server:latest`; `CODE_SERVER_DEFAULT_IMAGE`
  is the single source of truth in the api package; `minikube-load.sh` loads the
  ghcr alias. (BUILD 3)
- `k8s/crds/run.yaml` carries the engine description block and `node
  codegen/gen-crds.mjs --out /tmp/x && diff -rq /tmp/x k8s/crds/` is clean —
  the committed CRDs are exactly what codegen produces, so no future `pnpm
  codegen` can silently delete anything. (BUILD 4)
- `pnpm typecheck && pnpm test && pnpm lint` pass from the repo root.
