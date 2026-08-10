# PLAN: Hide code-server board link when code-server is not enabled

**Task ID:** `percussionist-dev-plan-00710e`  
**Scope:** Web UI only (`packages/web/src/client/*`). No backend API or operator changes are required.

## Context

The web dashboard currently shows a "Code" link in three places whenever the browser hostname has a subdomain:

1. `BoardHeader` (`packages/web/src/client/components/board/BoardHeader.tsx`): both desktop and mobile compact layouts.
2. `AppSidebar` (`packages/web/src/client/components/app-sidebar.tsx`): next to each project name.
3. `TaskDetailPanel` (`packages/web/src/client/components/board/TaskDetailPanel.tsx`): on the git branch of an active worker run.

All three sites derive the URL via `deriveIdeUrl(projectName)` in `packages/web/src/client/lib/code-server-url.ts`. That helper returns a URL any time `window.location.host` contains a dot, with no knowledge of whether the project has `spec.codeServer.enabled === true`.

The board API (`packages/web/src/server/routes/board.ts`) already loads the full `Project` CR in `GET /api/projects/:project/board`, but it currently only returns `settings`, `columns`, `approvals`, `status`, and `authWarning`. It does not expose the `codeServer` block.

Because `CodeServerView` embeds an iframe at the derived URL, a user without code-server enabled can navigate to `/projects/:name/code-server` and receive a blank/404 page after a misleading "not enabled" message. The more immediate UX issue described in the task is that the link is visible on the board even for projects that never enabled code-server.

## Approach

1. **Expose the project flag on the board payload.** Extend the `settings` object returned by `GET /api/projects/:project/board` to include `codeServer: { enabled: boolean }`. This is the single authoritative source for the board UI.
2. **Make the link conditional on the flag.** Update all three UI call sites to pass an effective code-server URL to child components only when `settings.codeServer?.enabled` is true *and* the derived URL is defined.
3. **Keep `deriveIdeUrl` unchanged.** It should remain a pure helper; the product decision about whether code-server is enabled should live in the board route and components.
4. **Update unit tests.** Adjust `packages/web/tests/board-header.test.tsx` so the existing tests exercise the combined condition (`enabled && url defined`), and ensure the component can be rendered with both the flag and the URL.

### Out of scope

- Operator code-server reconciler / deployment lifecycle.
- Memory service or embedding.
- `CodeServerView` iframe behavior; only the link visibility is in scope.
- Backwards-compatible API shape changes have minor impact; the new `codeServer` field is additive.

## Task Breakdown

### BUILD 1 — Expose `codeServer.enabled` on the board API
**Owner:** backend/web (small route change)

1. In `packages/web/src/client/lib/api.ts`, update the `fetchBoard` return type:
   ```ts
   settings: {
     maxParallel: number;
     agents: Array<{ name: string }>;
     phase: string;
     codeServer?: { enabled?: boolean };
   };
   ```
2. In `packages/web/src/server/routes/board.ts`, inside `GET /:project/board`, populate the new field from the project CR:
   ```ts
   const settings = {
     maxParallel: project.spec.maxParallel ?? 2,
     agents: project.spec.agents ?? [],
     phase: project.spec.phase ?? 'Active',
     codeServer: project.spec.codeServer,
   };
   ```
3. Run `pnpm typecheck` and `pnpm lint` for `packages/web`.

### BUILD 2 — Gate board-level code-server links on the flag
**Owner:** web/client

1. In `packages/web/src/client/components/BoardView.tsx`:
   - Read `data.settings.codeServer?.enabled`.
   - Compute `codeServerUrl` as:
     ```ts
     const codeServerUrl =
       data.settings.codeServer?.enabled && projectName
         ? deriveIdeUrl(projectName)
         : undefined;
     ```
   - Pass the resulting `codeServerUrl` unchanged to `BoardHeader` and `TaskDetailPanel`.
2. In `packages/web/src/client/components/app-sidebar.tsx`:
   - In the project list map, guard the per-project code-server link with `p.spec.codeServer?.enabled`.
3. Verify the branch link in `TaskDetailPanel` is already correctly gated via the propagated `codeServerUrl` prop, so no direct change is needed there.

### BUILD 3 — Update tests and run the web smoke/unit suite
**Owner:** web/client tests

1. In `packages/web/tests/board-header.test.tsx`:
   - Update `renderHeader` to accept a `codeServerEnabled` option (default `false`).
   - Change existing tests:
     - "renders Code link when codeServerUrl is provided" → also set `codeServerEnabled: true`.
     - "does NOT render Code link without codeServerUrl" → keep `codeServerEnabled: false`.
     - Add a test: "does NOT render Code link when enabled is false even if codeServerUrl is provided".
     - Mirror the same for the mobile compact test cases.
2. In `packages/web/tests/board-view.test.tsx` (if relevant), ensure the `fetchBoard` mock includes `settings.codeServer: { enabled: true }` for code-server scenarios.
3. Run `pnpm test` to confirm no regressions.

## Acceptance Criteria

- [ ] When a Project has `spec.codeServer.enabled: false` or no `codeServer` block, the "Code" link is not visible in `BoardHeader`, `AppSidebar`, or `TaskDetailPanel` (worker branch), regardless of the browser hostname.
- [ ] When a Project has `spec.codeServer.enabled: true` and the board is loaded on a host with a subdomain, the "Code" link remains visible in all three places and opens the derived IDE URL.
- [ ] `GET /api/projects/:project/board` returns a new additive `settings.codeServer` field matching the project CR.
- [ ] `BoardHeader` tests explicitly cover the combination of the enabled flag and derived URL.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass for `packages/web`.

## Risks / Open Questions

1. **Port-forward / localhost UX.** Users who access the dashboard via `kubectl port-forward` see no link today because `deriveIdeUrl` returns `undefined`. This behavior is unchanged.
2. **Deployment with Ingress.** `deriveIdeUrl` assumes an Ingress-based hostname structure (`ide-{project}.{base}`). If `Ingress` is not configured, the link may point to an unresolved host. That is a pre-existing, independent issue and should not be conflated with this scope.
3. **Sidebar project list source.** `AppSidebar` iterates over projects loaded via `useProjects`, which returns full Project CRs, so `p.spec.codeServer?.enabled` is available without waiting for the board fetch.
4. **Test environment.** The unit tests mock `deriveIdeUrl` directly. New tests must be careful to assert on the component's combined condition, not the helper itself.
