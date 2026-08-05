# Plan: Add a persistent human repo folder to the project data PVC

Task: `percussionist-dev-plan-d3769e` — "Add human repo folder to project pvc"

## Context

A human user opening code-server for a project has no stable folder to work in.
The relevant existing machinery:

- **code-server Deployment** (`packages/operator/src/code-server.ts`,
  `renderIdeDeployment`): mounts the project's data PVC at
  `spec.data.mountPath` (default `/data`) and passes the mount path as the
  **last positional arg** to the `code-server` container — that is the folder
  code-server opens (verified by `code-server.test.ts`:
  `expect(last).toBe('/data')`). A `code-server-init` init container (same
  image, `runAsUser: 0`) seeds first-run config files to the PVC idempotently
  (`[ -f ... ] ||` guards), so customisations survive restarts.
- **Data PVC layout** (`packages/operator/src/pvc-helper.ts`,
  `packages/operator/src/pod-builder.ts`): for remote-git projects the PVC
  holds only `cache/`, `git-mirrors/{hash}/`, and ephemeral per-run
  `worktrees/{run-name}/`. `workspace/` exists only for `source.local` projects.
  So for remote-git projects (e.g. `percussionist-dev`, which is
  `git@github.com:erkkaha/percussionist.git` with `codeServer.enabled: true`),
  the human sees caches/mirrors/run-worktrees and no folder of their own.
- **Local-workspace git-init pattern** (`pod-builder.ts` lines ~643-691): the
  workspace-init container runs `git init`, `git symbolic-ref HEAD
  refs/heads/main`, and an empty initial commit — the established way this
  codebase bootstraps a repo on the PVC. The code-server image ships git.
- **Web UI**: links to `/projects/:name/code-server` (BoardHeader,
  app-sidebar); `CodeServerView.tsx` iframes the IDE and forwards an optional
  `?folder=` query param (used by `TaskDetailPanel` for worktrees).
- **Schema** (`packages/api/src/index.ts`): `CodeServerSpecSchema` has
  `enabled | image | resources | packages`. Project `data` spec is inline in
  `ProjectSpecSchema`. CRD YAML is generated from Zod via `pnpm codegen`
  (`codegen/gen-crds.mjs` → `k8s/crds/project.yaml`).

## Approach

Add an opt-in, persistent **human folder** to the project data PVC, created by
the code-server init container (the only PVC-seeding mechanism that runs
independently of agent runs), and make code-server open it by default so the
human lands in a usable repo instead of the raw PVC root.

New spec under `spec.codeServer.humanFolder`:

```yaml
codeServer:
  enabled: true
  humanFolder:
    enabled: true        # default false
    name: human          # default "human" — directory under mountPath
    branch: main         # default "main" — initial branch of the human repo
    remoteUrl: git@github.com:... # optional; defaults to spec.source.git.url
```

Behaviour:

1. **Init container** (when `humanFolder.enabled`): `mkdir -p
   ${mountPath}/${name}`, and if not already a git repo — `git init`,
   `symbolic-ref HEAD refs/heads/${branch}`, empty initial commit (author
   inline via `-c user.name/user.email` so it works without `GIT_AUTHOR_*`
   env), then best-effort `git remote remove origin` + `git remote add origin
   <url>` when a remote URL is known (passed via env var `HUMAN_FOLDER_REMOTE_URL`
   to avoid shell metacharacter issues in URLs). Idempotent across pod
   restarts via the `[ -d .git ]` guard, mirroring the existing config-file
   seeding style.
2. **Main container**: when enabled, the last positional arg (opened folder)
   becomes `${mountPath}/${name}` instead of `mountPath`. The whole PVC stays
   mounted, so the human can still browse `/data` via File → Open Folder;
   `ignore-last-opened: true` in the existing config keeps the human folder as
   the default.
3. **Remote defaulting**: `remoteUrl` falls back to `spec.source.git.url` when
   the project has a git source. Pushing still needs the human's own git
   credentials (code-server container mounts no SSH key/token secrets) — the
   repo is wired so `git pull`/`git push` work once the human authenticates.
4. **Web form**: toggle + folder-name input under the Code Server fieldset
   (`WorkspaceServicesTab.tsx` / `useProjectForm.ts`), plus the client type.
5. **Config/docs**: enable it on `percussionist-dev`, document it.

Scope boundaries:

- No agent/run-pod changes: agent runs keep working in worktrees; the human
  folder is not part of any agent workspace.
- No code-server UI/iframing changes: the "open human folder by default" is
  achieved via the container args; existing `?folder=` deep links are
  unaffected and take precedence when present.
- No PVC/worktree-cleanup changes: TTL and worktree cleanup are scoped to
  `/data/worktrees/{runName}/` (see `ttl.ts`, `worktree-cleanup.ts`) and never
  touch a new top-level `/data/human/`.
- Backwards compatible: when `humanFolder` is absent/disabled, rendered
  Deployment is byte-identical to today (open `/data`).

## Tasks

1. **API schema** — `packages/api/src/index.ts`:
   - Add `export const HumanFolderSpecSchema = z.object({ enabled:
     z.boolean().default(false), name: z.string().default('human'), branch:
     z.string().default('main'), remoteUrl: z.string().optional() })` with
     `export type HumanFolderSpec`.
   - Add `humanFolder: HumanFolderSpecSchema.optional()` to
     `CodeServerSpecSchema` (with a doc comment).
2. **Regenerate CRD** — run `pnpm codegen` (after `pnpm --filter
   @percussionist/api build`) and commit the updated `k8s/crds/project.yaml`.
3. **Operator rendering** — `packages/operator/src/code-server.ts`
   (`renderIdeDeployment`):
   - Compute `humanFolder` spec and `humanDir = ${mountPath}/${name}` when
     enabled.
   - Append an idempotent init-script block (mkdir, git init, HEAD → branch,
     empty commit, remote wiring) and pass `HUMAN_FOLDER_REMOTE_URL` via
     `initEnv` when a URL is resolved (explicit `remoteUrl` → `source.git.url`
     → unset).
   - Set the main container's last positional arg to `humanDir` when enabled,
     else keep `mountPath`.
4. **Operator unit tests** — `packages/operator/src/code-server.test.ts`:
   - init script contains `mkdir -p` + `git init` for the human dir when
     enabled, and nothing human-folder related when disabled.
   - last main-container arg is `${mountPath}/human` (customizable name) when
     enabled, `/data` when disabled.
   - `HUMAN_FOLDER_REMOTE_URL` env present when `remoteUrl` set and when
     defaulting from `source.git.url`; absent when no URL known.
5. **Web client type** — `packages/web/src/client/lib/types.ts`: add
   `humanFolder?: { enabled?: boolean; name?: string | null; branch?: string |
   null; remoteUrl?: string | null }` to the `codeServer` type.
6. **Web form state** — `packages/web/src/client/components/project-form/useProjectForm.ts`:
   - Add `humanFolderEnabled`, `humanFolderName` state + setters; initialize
     from `spec.codeServer?.humanFolder` in the edit path (pattern of
     `codeServerEnabled` at ~line 610).
   - Build `req.codeServer.humanFolder = { enabled, name }` when enabled
     (omit when disabled); keep it inside the existing `if (state.codeServerEnabled)` block.
7. **Web form UI** — `packages/web/src/client/components/project-form/WorkspaceServicesTab.tsx`:
   - Under the Code Server fieldset, add a "Human workspace folder" Switch +
   folder-name Input (shown when `codeServerEnabled`); wire the new hook
   fields through the component's `Pick<...>` types.
8. **Web form tests** — `packages/web/tests/project-form.test.ts`: assert the
   request payload carries `humanFolder: { enabled: true, name: 'human' }` when
   toggled, and is omitted when disabled.
9. **Self-dev config** — `k8s/self-dev/projects/percussionist-dev.yaml`: add
   `humanFolder: { enabled: true }` under the existing `codeServer:` block.
10. **Docs** — update `docs/features/code-server.md` (new Enable block +
    Workspace Layout row for `/data/human/`) and the Code-Server "Workspace
    Layout" section in `AGENTS.md`.
11. **Verify** — `pnpm typecheck`, `pnpm lint`, `pnpm test` all green;
    `pnpm --filter @percussionist/operator test` and `pnpm --filter
    @percussionist/web test` for the touched suites.

## Risks / open questions

- **Git author identity**: the empty initial commit is created without
  `GIT_AUTHOR_*` env; inline `-c user.name/-c user.email` with a sensible
  default ("Percussionist Agent" / "agent@percussionist.dev", matching
  `pod-builder.ts` line 320) avoids a failed commit. Confirm this default is
  acceptable.
- **Push credentials**: the code-server container has no SSH key / GitHub
  token mounts, so `git push` from the human folder requires the human to
  configure credentials in the code-server terminal (or the operator to
  optionally mount the project's `sshSecret` later — out of scope for v1).
  `pull` from a public repo works without auth.
- **`remoteUrl` defaulting**: for projects with no `source.git.url`
  (`source.local`), no origin is wired — the human repo is standalone unless
  `remoteUrl` is set explicitly.
- **Existing deployments**: the operator SSA-patches the Deployment on project
  reconcile, triggering a `Recreate` rollout whose init container creates the
  folder — no manual intervention needed, but expect a brief IDE downtime on
  enable.
- **Open question**: is a folder-name/branch/remoteUrl config surface the right
  scope, or should v1 be a bare `humanFolder: { enabled: true }` (fixed name
  `human`, branch `main`)? The plan proposes the fuller schema; trimming is a
  small follow-up.
- **Naming**: `humanFolder` vs `humanWorkspace`/`workspace.human` — `humanFolder`
  chosen for clarity and to avoid confusion with the agent `workspace/` dir.
  Flag if a different name is preferred (schema + CRD + form would follow).

## Acceptance criteria

1. With `spec.codeServer.humanFolder.enabled: true`, the PVC gains
   `{mountPath}/{name}` (default `/data/human/`) after the code-server pod
   restarts; it is a git repo with `main` (or configured branch) checked out
   and an initial commit; `git remote -v` shows origin when a URL is known.
2. Opening code-server (UI link or port-forward) lands the human in the human
   folder, not the raw PVC root; File → Open Folder still reaches `/data`.
3. Toggling the feature off restores prior behavior (code-server opens
   `mountPath`); the folder and its contents persist on the PVC (no deletion).
4. The web project form can enable the human folder and set its name; editing
   an existing project preserves the settings.
5. TTL/worktree cleanup, agent run pods, and `?folder=` worktree deep links are
   unaffected.
6. `pnpm typecheck && pnpm lint && pnpm test` pass; CRD `project.yaml`
   regenerated and committed.

## Proposed BUILD task breakdown

1. **BUILD — api: humanFolder schema + CRD regen** (`packages/api/src/index.ts`,
   `k8s/crds/project.yaml`, api schema test). No dependencies.
2. **BUILD — operator: create & open human folder** (`code-server.ts` +
   `code-server.test.ts`). Depends on BUILD 1 (consumes `HumanFolderSpecSchema`).
3. **BUILD — web: human folder form controls** (`types.ts`,
   `useProjectForm.ts`, `WorkspaceServicesTab.tsx`, `project-form.test.ts`).
   Depends on BUILD 1 (consumes the type).
4. **BUILD — config/docs: enable on percussionist-dev + document**
   (`k8s/self-dev/projects/percussionist-dev.yaml`, `docs/features/code-server.md`,
   `AGENTS.md`). Depends on BUILD 2 (verification on the live project).

Each BUILD is independently reviewable; 2–4 can run after 1 lands. Manual
verification step after all builds: enable the folder on `percussionist-dev`,
roll the `ide-percussionist-dev` deployment, and confirm `/data/human/` exists
and opens by default.
