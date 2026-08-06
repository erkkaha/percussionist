# Plan: Add a persistent human repo folder to the project data PVC

Task: `percussionist-dev-plan-d3769e` — "Add human repo folder to project pvc"

Revision: RETRY 1 — folder named `code`, clones the repo from
`spec.source.git`, checked out on the project default branch.

## Context

A human user opening code-server for a project has no stable folder to work
in. The relevant existing machinery:

- **code-server Deployment** (`packages/operator/src/code-server.ts`,
  `renderIdeDeployment`): mounts the project's data PVC at
  `spec.data.mountPath` (default `/data`) and passes the mount path as the
  **last positional arg** to the `code-server` container — that is the folder
  code-server opens (verified by `code-server.test.ts`:
  `expect(last).toBe('/data')`). A `code-server-init` init container (same
  image, `runAsUser: 0`) seeds first-run config files to the PVC idempotently
  (`[ -f ... ] ||` guards), so customisations survive restarts. The init
  container runs with `set -e` and already supports package installs via an
  env-injected variable (`CODE_SERVER_PACKAGES`).
- **Data PVC layout** (`packages/operator/src/pvc-helper.ts`,
  `packages/operator/src/pod-builder.ts`): for remote-git projects the PVC
  holds only `cache/`, `git-mirrors/{hash}/`, and ephemeral per-run
  `worktrees/{run-name}/`. `workspace/` exists only for `source.local`
  projects. So for remote-git projects (e.g. `percussionist-dev`, which is
  `git@github.com:erkkaha/percussionist.git` with `codeServer.enabled: true`),
  the human sees caches/mirrors/run-worktrees and no folder of their own.
- **Remote-git clone precedent** (`pod-builder.ts`): agent run pods clone via a
  bare mirror, but the code-server init container has no mirror access. The
  nearest reusable patterns are (a) the SSH-secret mount used by run pods —
  `git-ssh` volume from `source.git.sshSecret`, mounted at `/etc/git-ssh`,
  with `GIT_SSH_COMMAND="ssh -i /etc/git-ssh/id -o IdentitiesOnly=yes ..."`
  (pod-builder.ts lines ~279, 411-415, 722-783, 911-917) and (b) the
  local-workspace `git init` + `symbolic-ref HEAD` + empty-commit bootstrap
  (pod-builder.ts lines ~643-691). The `codercom/code-server` image ships git.
- **Project default branch**: for remote-git projects the branch the platform
  works on by default is `spec.source.git.ref` (`packages/api/src/index.ts`
  `GitSourceSchema.ref`, optional). `percussionist-dev.yaml` sets
  `source.git.ref: main`. `GitSource` also carries optional `sshSecret`,
  `known_hostsSecret` + `sshHostKeyVerification`, and `author`
  (name/email) — all usable by the clone.
- **Schema / CRD**: `CodeServerSpecSchema` (`packages/api/src/index.ts` lines
  ~210-221) has `enabled | image | resources | packages`. CRD YAML is
  generated from Zod via `pnpm codegen` (`codegen/gen-crds.mjs` →
  `k8s/crds/project.yaml`).
- **Web UI**: project form in `packages/web/src/client/components/project-form/`
  (`useProjectForm.ts` builds `req.codeServer` inside
  `if (state.codeServerEnabled)`; `WorkspaceServicesTab.tsx` renders the Code
  Server fieldset; client type in `packages/web/src/client/lib/types.ts`).
- **Docs**: `docs/features/code-server.md` (Enable block + Workspace Layout
  table) and the "Code-Server (Interactive Workspace Access)" section of
  `AGENTS.md`.

## Approach

Add an opt-in, persistent **human folder** named `code` to the project data
PVC. The code-server init container (the only PVC-seeding mechanism that runs
independently of agent runs) **clones the project repo from `spec.source.git`**
into the folder and checks out the **project default branch**, and code-server
opens that folder by default so the human lands in a usable repo instead of the
raw PVC root.

New spec under `spec.codeServer.humanFolder`:

```yaml
codeServer:
  enabled: true
  humanFolder:
    enabled: true        # default false
    name: code           # default "code" — directory under mountPath (RETRY: must be "code")
    # branch:            # optional — defaults to project default (spec.source.git.ref)
    # remoteUrl:         # optional — defaults to spec.source.git.url
```

Branch and URL resolution (deterministic, matches "project default"):

- **Branch** = `humanFolder.branch` → `spec.source.git.ref` → (unset) remote's
  default HEAD (clone default; no forced checkout). For `percussionist-dev`
  this resolves to `main` via `source.git.ref`.
- **Remote URL** = `humanFolder.remoteUrl` → `spec.source.git.url` → (unset,
  e.g. `source.local` project) no origin; fall back to the local-workspace
  `git init` + empty-commit bootstrap so the folder still exists as a usable
  git repo.

Init-container behaviour (idempotent, `set -e` with fallible ops guarded):

1. `mkdir -p "${mountPath}/${name}"` (default `/data/code`).
2. If `${mountPath}/${name}/.git` does **not** exist:
   - If a remote URL is resolved: `git clone <url> <dir>` (git allows cloning
     into an existing empty dir), then `git checkout <branch>` when a branch
     was resolved and differs from the clone's default HEAD (`checkout -b` from
     `origin/<branch>` if the local branch doesn't exist yet). URL passed via
     env `HUMAN_FOLDER_REMOTE_URL` (avoids shell metacharacter issues), branch
     via `HUMAN_FOLDER_BRANCH`.
   - If no URL (source.local without explicit remoteUrl): `git init`,
     `symbolic-ref HEAD refs/heads/<branch|main>`, empty initial commit — the
     pod-builder local-workspace pattern.
3. If the folder is already a git repo (pod restart): refresh — ensure
   `origin` points at the URL (`remote set-url`/`remote add`), `git fetch
   origin` (guarded), checkout the resolved branch, then
   `git pull --ff-only` (guarded). Never delete local changes.
4. Best-effort author seeding so the human's first commit works without
   configuring git: `git -C <dir> config user.name/user.email` from
   `source.git.author`, falling back to "Percussionist Agent" /
   "agent@percussionist.dev" (pod-builder.ts line ~320 default).
5. If the clone/fetch fails (offline, auth), **do not fail the pod** — fall
   back to the `git init` bootstrap so code-server still comes up and the
   folder exists; log the reason.

SSH auth for private repos (required for `percussionist-dev`):

- When `source.git.sshSecret` is set, mount the `git-ssh` volume (secretName +
  `items: [{key, path: 'id'}]`) into the **init container only** at
  `/etc/git-ssh` (read-only) and set `GIT_SSH_COMMAND` mirroring pod-builder
  (including `StrictHostKeyChecking` derived from `sshHostKeyVerification`,
  and `known_hostsSecret` when configured). Also set `GIT_TERMINAL_PROMPT=0`
  so a missing key never hangs the pod on an auth prompt.
- The key is **not** mounted into the main code-server container: the IDE runs
  with `auth: none` (config.yaml), so exposing the project's deploy key to the
  no-auth web UI would be a privilege escalation. The human authenticates for
  `push` with their own credentials from the IDE terminal (documented; same
  stance as the previous plan).

Main container: when `humanFolder.enabled`, the last positional arg (opened
folder) becomes `${mountPath}/${name}` instead of `mountPath`. The whole PVC
stays mounted, so the human can still browse `/data` via File → Open Folder;
`ignore-last-opened: true` in the existing config keeps the human folder as
the default.

Scope boundaries:

- No agent/run-pod changes: agent runs keep working in worktrees; the human
  folder is not part of any agent workspace.
- No code-server UI/iframing changes: default-folder behaviour is achieved via
  the container args; existing `?folder=` deep links are unaffected and take
  precedence when present.
- No PVC/worktree-cleanup changes: TTL and worktree cleanup are scoped to
  `/data/worktrees/{runName}/` (`ttl.ts`, `worktree-cleanup.ts`) and never
  touch the new top-level `/data/code/`.
- Backwards compatible: when `humanFolder` is absent/disabled, the rendered
  Deployment is byte-identical to today (open `/data`, no git-ssh volume).
- Web form v1 exposes only the enable toggle; `name`/`branch`/`remoteUrl`
  overrides are YAML-only in v1 (defaults satisfy the retry requirements).

## Tasks

1. **API schema** — `packages/api/src/index.ts`:
   - Add `export const HumanFolderSpecSchema = z.object({ enabled:
     z.boolean().default(false), name: z.string().default('code'), branch:
     z.string().optional(), remoteUrl: z.string().optional() })` with
     `export type HumanFolderSpec`.
   - Add `humanFolder: HumanFolderSpecSchema.optional()` to
     `CodeServerSpecSchema` with a doc comment (folder named `code`, clones
     `spec.source.git` on the project default branch).
2. **Regenerate CRD** — `pnpm codegen` (after `pnpm --filter
   @percussionist/api build`) and commit the updated `k8s/crds/project.yaml`.
3. **Operator rendering** — `packages/operator/src/code-server.ts`
   (`renderIdeDeployment`):
   - Resolve `humanFolder` spec; compute `humanDir = ${mountPath}/${name}`
     when enabled, plus resolved `branch` (`humanFolder.branch` →
     `git.ref` → undefined) and `remoteUrl` (`humanFolder.remoteUrl` →
     `git.url` → undefined).
   - Append an idempotent human-folder block to `initScript` (mkdir; clone-or-
     init-or-refresh per Approach; checkout resolved branch; pull --ff-only;
     author seeding; guarded failures with `|| true`).
   - Pass `HUMAN_FOLDER_REMOTE_URL` / `HUMAN_FOLDER_BRANCH` / author name +
     email via `initEnv` when resolved; set `GIT_TERMINAL_PROMPT=0`.
   - When `source.git.sshSecret` present: add the `git-ssh` volume to
     `volumes`, mount it in the init container, and set `GIT_SSH_COMMAND` on
     the init container following pod-builder's construction
     (`sshHostKeyVerification` / `known_hostsSecret` handling, `-o
     IdentitiesOnly=yes`).
   - Main container: last positional arg = `humanDir` when enabled, else keep
     `mountPath`.
4. **Operator unit tests** — `packages/operator/src/code-server.test.ts`:
   - Enabled: init script contains `mkdir -p ... /code` + `git clone`; last
     main-container arg is `${mountPath}/code`; `HUMAN_FOLDER_REMOTE_URL` env
     set from `source.git.url`; `HUMAN_FOLDER_BRANCH` set to `git.ref`; no
     git-ssh volume when no sshSecret.
   - Enabled + `name: human` + explicit `branch`/`remoteUrl`: dir and args
     reflect the overrides.
   - Enabled + `sshSecret`: init container mounts `git-ssh` volume, has
     `GIT_SSH_COMMAND`; main container does **not**.
   - Disabled / absent: no human-folder strings in init script, last arg is
     `/data`, no git-ssh volume, no `HUMAN_FOLDER_*` env (byte-compatible).
   - `source.local` without URL: init-script fallback contains `git init` +
     `symbolic-ref HEAD` for the human dir.
5. **Web client type** — `packages/web/src/client/lib/types.ts`: add
   `humanFolder?: { enabled?: boolean }` to the `codeServer` type.
6. **Web form state** — `packages/web/src/client/components/project-form/useProjectForm.ts`:
   - Add `humanFolderEnabled` state + setter; initialize from
     `spec.codeServer?.humanFolder?.enabled ?? false` in the edit path
     (pattern of `codeServerEnabled` at ~line 610).
   - Inside the existing `if (state.codeServerEnabled)` block, add
     `humanFolder: { enabled: state.humanFolderEnabled }` to `req.codeServer`
     when `humanFolderEnabled` is true; omit when false (keep the payload
     minimal). When code-server is disabled entirely, no `humanFolder` key.
7. **Web form UI** — `packages/web/src/client/components/project-form/WorkspaceServicesTab.tsx`:
   - Under the Code Server fieldset, add a "Human workspace folder (repo
     clone)" Switch shown when `codeServerEnabled`; wire
     `humanFolderEnabled` through the component's `Pick<...>` types.
8. **Web form tests** — `packages/web/tests/project-form.test.ts`: assert the
   request payload carries `codeServer.humanFolder: { enabled: true }` when
   toggled on (with code-server enabled), and no `humanFolder` key when
   toggled off or code-server disabled.
9. **Self-dev config** — `k8s/self-dev/projects/percussionist-dev.yaml`: add
   `humanFolder: { enabled: true }` under the existing `codeServer:` block
   (uses defaults: name `code`, branch from `source.git.ref` = `main`, URL
   from `source.git.url`, sshSecret for the clone).
10. **Docs** — update `docs/features/code-server.md` (Enable block with
    `humanFolder`, Workspace Layout row for `/data/code/` — "Human repo clone
    on project default branch", note that `push` needs the human's own
    credentials) and the "Workspace Layout" section in `AGENTS.md`.
11. **Verify** — `pnpm typecheck`, `pnpm lint`, `pnpm test` all green;
    `pnpm --filter @percussionist/operator test` and
    `pnpm --filter @percussionist/web test` for the touched suites.

## Risks / open questions

- **Clone duration / size**: the init container performs a full `git clone` of
  the project repo on first start (large for `percussionist-dev`). K8s waits
  for init containers by default, so code-server simply starts later. Mitigate
  later with a local bare-mirror clone (`/data/git-mirrors/{hash}/`) — out of
  scope for v1; the mirror hash computation lives in pod-builder and would need
  sharing.
- **SSH key scope**: the `sshSecret` is mounted only in the init container (the
  no-auth IDE must not expose the project's deploy key). Consequence: `git
  pull`/`git push` from the human folder requires the human to configure their
  own credentials (SSH key or token) in the IDE terminal — documented. Open
  question: should a future version mount the key with a per-user auth guard
  once code-server auth is enabled?
- **`set -e` in initScript**: the human-folder block must guard every fallible
  git op with `|| true` (clone/fetch/pull/checkout) and fall back to `git init`
  so a transient network/auth failure never takes down the IDE pod.
- **Branch default**: "project default" is interpreted as
  `spec.source.git.ref` (e.g. `main` for `percussionist-dev`); when `ref` is
  unset the clone's default HEAD is used (no forced checkout). If reviewers
  expect a hardcoded `main` fallback instead, that is a one-line change in
  step 3's resolution.
- **First-run existing directory**: if `/data/code` already exists with files
  but no `.git` (e.g. a manual `mkdir`), `git clone` into it fails → the
  fallback `git init` path handles it (repo bootstraps in place, no data
  loss).
- **Rollout**: the operator SSA-patches the Deployment on project reconcile,
  triggering a `Recreate` rollout whose init container clones the repo — expect
  a brief IDE downtime on enable.
- **Schema surface**: v1 keeps `name`/`branch`/`remoteUrl` as optional
  overrides with defaults that satisfy the retry (name `code`, project default
  branch, spec git URL). The web form exposes only the toggle; overrides are
  YAML-only.

## Acceptance criteria

1. With `spec.codeServer.humanFolder.enabled: true`, the PVC gains
   `/data/code/` (name `code`) after the code-server pod restarts; it contains
   a **clone of `spec.source.git.url`** checked out on the **project default
   branch** (`spec.source.git.ref`, e.g. `main`), with `origin` set and an
   initial working tree from the remote (not an empty repo).
2. Restarting the code-server pod is idempotent: the folder is refreshed
   (fetch + ff-only pull), never re-cloned from scratch, and never deletes
   local human changes.
3. Opening code-server (UI link or port-forward) lands the human in
   `/data/code`, not the raw PVC root; File → Open Folder still reaches
   `/data`.
4. Private-repo projects (e.g. `percussionist-dev`) clone successfully via the
   mounted `source.git.sshSecret`; the key is not exposed in the main
   code-server container.
5. Toggling the feature off restores prior behavior (code-server opens
   `mountPath`, no git-ssh volume); the folder and its contents persist on the
   PVC (no deletion).
6. The web project form can enable the human folder; editing an existing
   project preserves the setting; disabling it removes `humanFolder` from the
   payload.
7. TTL/worktree cleanup, agent run pods, and `?folder=` worktree deep links are
   unaffected.
8. `pnpm typecheck && pnpm lint && pnpm test` pass; CRD `project.yaml`
   regenerated and committed.

## Proposed BUILD task breakdown

1. **BUILD — api: humanFolder schema + CRD regen** (`packages/api/src/index.ts`,
   `k8s/crds/project.yaml`, api schema test). No dependencies.
2. **BUILD — operator: clone & open human folder** (`code-server.ts` +
   `code-server.test.ts`: init-script clone/refresh/fallback, branch+URL
   resolution, git-ssh volume for init container, main-container arg).
   Depends on BUILD 1 (consumes `HumanFolderSpecSchema`).
3. **BUILD — web: human folder toggle** (`types.ts`, `useProjectForm.ts`,
   `WorkspaceServicesTab.tsx`, `project-form.test.ts`). Depends on BUILD 1
   (consumes the type).
4. **BUILD — config/docs: enable on percussionist-dev + document**
   (`k8s/self-dev/projects/percussionist-dev.yaml`,
   `docs/features/code-server.md`, `AGENTS.md`). Depends on BUILD 2
   (verification on the live project).

Each BUILD is independently reviewable; 2–4 can run after 1 lands. Manual
verification step after all builds: enable the folder on `percussionist-dev`,
roll the `ide-percussionist-dev` deployment, and confirm `/data/code/` exists,
is a clone on `main`, and opens by default.
