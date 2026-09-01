# Plan: Secret updates destroy sibling keys in three write paths (+ stubbed settings UI)

**Task:** `percussionist-dev-plan-rev07`
**Branch:** `feature/percussionist-dev-plan-rev07`
**Severity:** high (silent, unrecoverable data loss + broken auth from a single CLI/web command)

---

## Context

A `replace`-instead-of-`merge` pattern appears in three Secret write paths, each of
which can silently destroy sibling keys in the same Secret. The `web-auth` Secret
(see `k8s/deploy/web.yaml:217-269`) carries **multiple** independent keys —
`token`, `session-secret`, `github-client-id`, `github-client-secret`,
`github-allowed-logins`, `legacy-token-auth` — and is consumed by the web pod via
six `secretKeyRef`s. Any full-replace that only carries one key wipes the rest,
breaking GitHub sign-in and invalidating every browser session.

The sibling module `packages/cli/src/auth-keys.ts` already does this correctly via
`patchWebAuthSecret` (auth-keys.ts:140-181): it reads the existing Secret, carries
`existing.data` forward, and only overrides the keys it is given through
`stringData`. The three broken paths below each reinvent their own full-replace body
instead of reusing it.

Separately, the Settings "Provider Secrets" panel (`packages/web/src/client/
components/SettingsPage.tsx:225-324`) has no key/value inputs — `llmSecretData`
and `authSecretData` are always `{}`, so the Create/Update buttons always POST/PUT
`{}` and the server rejects with 400. The panel cannot function at all.

### Affected code (verified)

1. **`beatctl auth web-token set|rotate|disable`** — `packages/cli/src/auth.ts`
   - `runWebTokenSet` (auth.ts:279-319) builds a `V1Secret` body with
     `stringData: { token }` only, then `replaceNamespacedSecret`.
   - `runWebTokenRotate` (auth.ts:326-333) delegates to `runWebTokenSet` → same bug.
   - `runWebTokenToggle` disable branch (auth.ts:351-381) builds a body with
     `stringData: { disabled: '1' }` only → wipes all sibling keys.
   - The enable branch (auth.ts:382-412) already reads existing data, drops
     `disabled`, and rewrites everything else — so **enable is correct** and only
     needs to be unified.
   - Fix precedent: `patchWebAuthSecret` in `auth-keys.ts:140-181` already carries
     existing data forward. Route the web-token ops through it.

2. **`PUT /api/settings/secrets/:name`** — `packages/web/src/server/routes/settings.ts:139-159`
   - Calls `upsertSecret(name, data)` (kube-upsert.ts:16-33), which does a full
     `replaceNamespacedSecret` with **only** the submitted `data`. Updating
     `OPENAI_API_KEY` in `llm-keys` deletes `ANTHROPIC_API_KEY`.
   - Fix: merge the submitted keys into the existing Secret's data before replacing.

3. **`PUT /api/projects/:name`** — `packages/web/src/server/routes/projects.ts:436-448`
   - `rawInjectFiles` defaults to `[]` when the field is absent (projects.ts:353-354).
     The management block then calls `deleteOrphanedInjectFileSecrets(name,
     spec.injectFiles ?? [], new Set())` → **every** inject-file Secret is deleted
     on a partial-body PUT (e.g. a script changing only `maxParallel`). Unrecoverable.
   - The `opencodeConfig` field is already guarded with `Object.hasOwn(body, 'opencodeConfig')`
     (projects.ts:350) for exactly this reason. `injectFiles` is not. Mirror the guard.

4. **Settings "Provider Secrets" panel** — `SettingsPage.tsx:225-324`
   - `llmSecretData`/`authSecretData` are empty `{}` → the Create/Update Secret
     buttons send `{}` → server 400 (settings.ts:125-127, 149-151). The buttons can
     never succeed. Add key/value editing rows (with masked values) or drop the buttons.

### Bonus (same area)

5. **Inject-file Secret name slugging collision** — `projects.ts:35-43`
   (`injectFileSecretName`). `notes.md` → slug `notes-md`; `notes_md` → `notes-md`
   → **same** Secret name `project-inject-notes-md`. Last writer wins, and orphan
   cleanup can delete a still-referenced Secret. Append a short filename hash so
   distinct filenames never collide.

---

## Approach

- **Reuse, don't reinvent.** Route CLI web-token writes through the existing
  `patchWebAuthSecret` (it already preserves siblings). Extend it with an optional
  `removeKeys` argument so the `enable` (remove `disabled`) path also goes through
  it, keeping a single write primitive.
- **Merge on the server side.** Add `mergeUpsertSecret` in `kube-upsert.ts` that
  reads the existing Secret, base64-decodes its `data`, merges the incoming
  plaintext keys, and re-upserts (via `stringData`). Use it only for the settings
  `PUT /secrets/:name` path; leave `upsertSecret` (used for single-key inject-file
  Secrets and `POST /secrets` create) untouched to avoid behavior change elsewhere.
- **Guard partial PUTs.** In the projects `PUT` handler, wrap the inject-file
  management block in an `Object.hasOwn(body, 'injectFiles')` check, mirroring the
  existing `opencodeConfig` guard. When the field is absent, preserve the existing
  `spec.injectFiles` (already carried forward by `mergeProjectPatch`) and perform no
  delete/upsert.
- **Fix the UI.** Replace the inert `llmSecretData`/`authSecretData` with real
  editable key/value row state, build the `data` object from non-empty rows, mask
  values with password inputs, and disable the buttons when there are no valid rows.
- **De-risk the slug change.** Append a short deterministic hash (`sha1(filename)`,
  first 8 hex chars) to the inject-file Secret name. The name function is used
  consistently for both create and orphan-delete, so it stays internally consistent;
  the hash only disambiguates colliding source filenames.

---

## BUILD Task Breakdown

### BUILD-1 — Route `beatctl auth web-token` through `patchWebAuthSecret`
**Files:** `packages/cli/src/auth.ts`, `packages/cli/src/auth-keys.ts`,
`packages/cli/test/auth.test.ts`

- In `auth-keys.ts`, extend `patchWebAuthSecret` signature to accept a trailing
  `removeKeys: string[] = []` parameter:
  - Build `merged = { ...(existing?.data ?? {}) }`; delete each `removeKeys` entry.
  - `body.data = merged`, `body.stringData = data` (unchanged merge semantics;
    stringData wins for keys present in both, matching the existing unit test
    auth.test.ts:440-457).
  - Dry-run message lists both set keys and `-<key>` removals.
  - If `existing` is null and `Object.keys(data).length === 0` (enable on a missing
    Secret), print the existing helpful message
    (`beatctl auth web-token set <token>`) and return without creating an empty Secret.
- In `auth.ts`:
  - `runWebTokenSet` → replace the hand-built body + replace/create logic with
    `await patchWebAuthSecret(opts.namespace, { [TOKEN_KEY]: opts.token }, opts.dryRun === true)`.
  - `runWebTokenRotate` already calls `runWebTokenSet` — no change needed beyond the above.
  - `runWebTokenToggle` disable branch → `await patchWebAuthSecret(opts.namespace, { [DISABLED_KEY]: '1' }, opts.dryRun === true)`.
  - `runWebTokenToggle` enable branch → `await patchWebAuthSecret(opts.namespace, {}, opts.dryRun === true, undefined, [DISABLED_KEY])`.
  - Remove now-unused `V1Secret`/`loadKube` references **only where** they become
    dead (note `runWebTokenShow` still uses them — keep imports).
- Tests: add an auth.test.ts case for `patchWebAuthSecret` with `removeKeys`
  (existing secret carrying `token` + `session-secret`; call with `removeKeys:
  ['disabled']`; assert `body.data` no longer has `disabled` and still has `token`/
  `session-secret`, `stringData` is `{}`). Add a case for enable-on-missing Secret.
  Confirm `create-vs-replace` and `key-preservation` cases still pass.

### BUILD-2 — Merge on `PUT /api/settings/secrets/:name`
**Files:** `packages/web/src/server/lib/kube-upsert.ts`,
`packages/web/src/server/routes/settings.ts`,
`packages/web/tests/settings-secrets.test.ts` (new or extend existing)

- Add `mergeUpsertSecret(name, data, labels?)` to `kube-upsert.ts`:
  - Read existing Secret; decode each `data` value from base64 to UTF-8 plaintext.
  - `merged = { ...decodedExisting, ...data }`.
  - Call existing `upsertSecret(name, merged, labels)` (which re-stores as
    `stringData`). If the read throws (not found), fall through to plain create.
- In `settings.ts` `PUT /secrets/:name`, replace `upsertSecret(name, data)` with
  `mergeUpsertSecret(name, data)` (no label change — settings Secrets are
  unlabeled today; keep parity).
- Tests: create `llm-keys` with `{ ANTHROPIC_API_KEY: 'a' }`; `PUT` with
  `{ OPENAI_API_KEY: 'b' }`; assert the Secret now has **both** keys (sibling
  preserved). Confirm `POST` still creates/replaces as full set.

### BUILD-3 — Guard inject-file Secret writes on partial `PUT /projects/:name`
**Files:** `packages/web/src/server/routes/projects.ts`,
`packages/web/tests/projects-injectfiles.test.ts` (new)

- Compute `const hasInjectFiles = Object.hasOwn(body as object, 'injectFiles')`
  next to the existing `hasOpencodeConfig` guard (projects.ts:350).
- Wrap the entire inject-file management block (projects.ts:436-448) in
  `if (hasInjectFiles) { ... }`. When the field is absent:
  - Leave `spec.injectFiles` as the value preserved by `mergeProjectPatch`
    (existing refs stay; no orphan deletion, no upsert).
- When `hasInjectFiles` is true but `rawInjectFiles` is `[]` (explicit clear), keep
  the existing behavior: delete orphans and set `spec.injectFiles = undefined`.
- Tests: `PUT /api/projects/:name` with a body that updates `maxParallel` only (no
  `injectFiles` field) while the project already has an inject-file Secret → assert
  the Secret still exists and `spec.injectFiles` is unchanged. Add a positive case
  where `injectFiles` IS present and an orphan is correctly deleted.

### BUILD-4 — Functional Provider Secrets panel (key/value rows)
**Files:** `packages/web/src/client/components/SettingsPage.tsx`,
`packages/web/tests/client/settings-page.test.tsx` (new, or extend)

- Replace the inert `llmSecretData`/`authSecretData` `{}` state with editable row
  state per secret, e.g. `Array<{ key: string; value: string }>`, initialized empty.
- Render, for each of the LLM-keys and auth Secrets:
  - A header row with the name Input (existing).
  - A dynamic list of rows: a `key` Input + a **password** Input (`type="password"`)
    for the masked `value` + a remove (✕) button; an "Add key" button.
  - The Create/Update button is disabled unless there is ≥1 row with a non-empty
    `key` and `value` (mirrors server `data (key-value pairs) is required` 400).
- On click, build `data` from non-empty rows and call
  `onSecretOp(name, data, existing ? 'update' : 'create')`.
- Keep the "Save Secrets Reference" button (writes `llmKeysSecret`/`authSecretName`
  into `spec.secrets`) unchanged.
- Tests: render panel; assert inputs exist; add a row, set key/value, click Update;
  assert `secretMutation` is called with the assembled `data` (not `{}`).

### BUILD-5 (bonus) — Disambiguate inject-file Secret names
**Files:** `packages/web/src/server/routes/projects.ts`

- In `injectFileSecretName` (projects.ts:36-44), import `createHash` from
  `node:crypto` and append `-<hash>` where `hash = createHash('sha1').update(filename).digest('hex').slice(0, 8)`.
- Keep the same slug sanitization; append the hash after the slug so
  `notes.md` and `notes_md` produce distinct names.
- No behavior change for the common (non-colliding) case; the function is used
  consistently for both upsert and orphan-delete so references stay aligned.
- Tests: assert `injectFileSecretName('notes.md') !== injectFileSecretName('notes_md')`
  and that a given filename is stable across calls.

---

## Risks / Open Questions

- **Secret name length (BUILD-5).** `projectName-inject-<slug>-<8hex>` is a single
  DNS-subdomain label (max 63 chars). Long project names + long slugs could exceed
  it (pre-existing risk, not worsened materially by an 8-char hash). Out of scope;
  flagged for awareness.
- **Existing inject-file Secrets under the old (hash-less) names.** After BUILD-5,
  `upsertInjectFileSecret` computes new hash-named Secrets. A re-save of an existing
  project keeps the same filename, so `deleteOrphanedInjectFileSecrets` matches the
  stored ref by `filename` (still present) and does **not** delete the old
  hash-less Secret — it simply becomes a dangling (unreferenced) Secret. Not data
  loss; old Secret can be cleaned manually. Acceptable for the bug fix.
- **`removeKeys` + empty `stringData` on enable.** `patchWebAuthSecret` will send
  `stringData: {}` alongside the merged base64 `data`. The API server accepts an
  empty `stringData` map; only the data keys remain. Verified-safe pattern (mirrors
  existing create-with-data behavior).
- **Settings `PUT` merge semantics.** The merge prevents accidental deletion of
  sibling keys but also means there is no UI path to *remove* a single key. That is
  out of scope for this fix; the 400-on-empty guard remains so `{ }` PUTs still fail
  (intentional — a PUT with nothing is a no-op error, not a clear).
- **Backward compatibility of `patchWebAuthSecret`.** Adding `removeKeys` as a
  trailing optional parameter with default `[]` keeps existing callers
  (`runGithubSetApp`, `runGithubAllow`, `runSessionSecretRotate`) and the existing
  unit tests (auth.test.ts:392-457) passing unchanged.
- **Web-auth enable message change.** Routing enable through `patchWebAuthSecret`
  changes the dry-run/console wording slightly. Functionally equivalent; acceptable.

---

## Acceptance Criteria

1. `beatctl auth web-token rotate` preserves `session-secret`,
   `github-client-id/-secret/-allowed-logins`, `legacy-token-auth` in the `web-auth`
   Secret (only `token` is replaced).
2. `beatctl auth web-token disable` preserves all sibling keys; `enable` removes
   only `disabled` and keeps the rest.
3. `PUT /api/settings/secrets/llm-keys` with one key does not delete other keys
   already in the Secret.
4. `PUT /api/projects/:name` that changes an unrelated field (e.g. `maxParallel`)
   and omits `injectFiles` leaves existing inject-file Secrets intact.
5. The Settings "Provider Secrets" panel lets a user add key/value rows, mask values,
   and successfully Create/Update a Secret (no 400 from empty `{}`).
6. Two distinct filenames that previously slug-collided now get distinct Secrets.
7. `pnpm typecheck && pnpm test` pass; Biome lint clean.
