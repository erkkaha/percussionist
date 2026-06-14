# Plan: Configurable exec/maintenance pod image with sane per-project override

## Context

- The maintenance pod used by `manager-agent_exec_in_workspace` is created in `packages/kube/src/index.ts` by `execInWorkspace(...)`.
  - It currently hardcodes `image: "alpine:3.20"` and `pvcName = `${projectName}-data``.
  - All manager MCP tools that execute workspace commands (`exec_in_workspace`, `read_plan` fallback, `install_packages`, worktree cleanup paths) go through this helper.
- `Project` schema is defined in `packages/api/src/index.ts` (`ProjectSpecSchema`) and CRD is generated into `k8s/crds/project.yaml`.
- Project create/update API validates with `ProjectSpecSchema` in `packages/web/src/server/routes/projects.ts`, so adding a schema field propagates server-side validation automatically.
- Project settings UI is implemented in:
  - `packages/web/src/client/components/project-form/useProjectForm.ts`
  - `packages/web/src/client/components/project-form/WorkspaceServicesTab.tsx`
  - request types in `packages/web/src/client/lib/types.ts`.
- Self-dev project manifest is `k8s/self-dev/projects/percussionist-dev.yaml`.

## Scope boundaries

### In scope

1. Add a per-project config field for maintenance/exec pod image (`spec.exec.image` preferred).
2. Use that field when spawning workspace exec pods.
3. Preserve backward compatibility when field is unset.
4. Surface the setting in the project config UI.
5. Set `percussionist-dev` project manifest to a richer image (requested: `ubuntu:24.04`).

### Out of scope

1. Reworking command semantics for distro-specific package managers beyond what is required for compatibility.
2. Broader refactors of maintenance tools (`install_packages`, sanitizer logic, etc.) unrelated to image selection.
3. Changing run pod images (`spec.image`) or workspace-init behavior.

## Assumptions

1. `spec.exec` is acceptable as a new top-level section (cleaner than overloading `spec.data`).
2. To avoid breaking existing projects/tools, fallback should remain the current hardcoded image (`alpine:3.20`) unless explicitly configured.
3. The self-dev project can opt into `ubuntu:24.04` even if global default remains Alpine.

## Approach

Use a **project-level override with safe fallback**:

1. Extend Project API/CRD with optional `spec.exec.image`.
2. Update `execInWorkspace(...)` to resolve project config at runtime:
   - fetch project via `getProject(projectName, ns)`
   - derive image from `project.spec.exec?.image ?? "alpine:3.20"`
   - keep current behavior when unset.
3. Keep existing MCP tool call signatures unchanged (no required changes to `exec_in_workspace` arguments).
4. Add UI field in Workspace & Services tab for `Exec/Maintenance Pod Image` that binds to `spec.exec.image`.
5. Update self-dev manifest to set `spec.exec.image: ubuntu:24.04`.

This “different approach” (vs. globally changing default) minimizes regression risk in existing Alpine-oriented helper commands while still solving the self-dev usability issue.

## Tasks

1. **Extend Project schema/types for exec image override**
   - File: `packages/api/src/index.ts`
   - Add optional `exec` object under `ProjectSpecSchema`, with `image?: string`.
   - Keep it optional to preserve compatibility.

2. **Regenerate CRD artifacts**
   - Command: `pnpm codegen` (or package-specific equivalent used in repo)
   - Ensure `k8s/crds/project.yaml` includes `spec.exec.image` in OpenAPI schema.

3. **Propagate type additions to web client request types**
   - File: `packages/web/src/client/lib/types.ts`
   - Add `exec?: { image?: string }` to `CreateProjectRequest` (and rely on `ProjectDetail` from API types for read path).

4. **Plumb form state for exec image**
   - File: `packages/web/src/client/components/project-form/useProjectForm.ts`
   - Add state fields:
     - `execImage: string`
     - setter `setExecImage`
   - Initialize from `spec.exec?.image ?? ""`.
   - Include in `buildProjectRequest(...)` as `req.exec = { image: ... }` when non-empty.
   - Include in returned hook object/types (`ProjectFormState`, `ProjectFormHookReturn`).

5. **Expose field in Project UI (Workspace & Services tab)**
   - File: `packages/web/src/client/components/project-form/WorkspaceServicesTab.tsx`
   - Add labeled input for maintenance/exec pod image (monospace text input).
   - Hint text should clarify fallback behavior when blank.
   - Update prop typing (`Pick<...>`) to include `execImage` and `setExecImage`.

6. **Wire CreateProjectForm prop passthrough**
   - File: `packages/web/src/client/components/CreateProjectForm.tsx`
   - Include `execImage`/`setExecImage` in `workspaceServicesProps.form` mapping.

7. **Use configured image in workspace exec pod creation**
   - File: `packages/kube/src/index.ts`
   - In `execInWorkspace(...)`:
     - Fetch project once (`getProject(projectName, ns)`) before pod creation.
     - Resolve:
       - `execImage = project.spec.exec?.image ?? "alpine:3.20"`
       - (optionally also normalize PVC name from `project.spec.data?.pvcName ?? `${projectName}-data`` if touched while editing this path).
     - Set pod container image to `execImage`.
   - Keep timeout/logging/deletion flow unchanged.

8. **Update self-dev project manifest**
   - File: `k8s/self-dev/projects/percussionist-dev.yaml`
   - Add:
     - `spec.exec.image: ubuntu:24.04`
   - Place near other workspace/data settings for discoverability.

9. **Documentation updates**
   - Primary: `README.md` project spec/config sections.
   - Add new field docs (`spec.exec.image`) and short explanation that it controls maintenance pods used by tools like `exec_in_workspace`.
   - Mention default fallback image when unset.

10. **Validation and compatibility checks**
    - Run targeted checks:
      - typecheck/build for affected packages (`api`, `kube`, `web`, `manager-controller` consumption path)
      - any existing tests covering API schema or project form compilation.
    - Manual verification path (self-dev): run `exec_in_workspace` command that checks tool presence (e.g. `git --version`, `curl --version`) and confirm pod image in returned/debug logs.

## Acceptance criteria mapping

1. **Project spec has `exec.image` field**
   - Satisfied by schema addition in `packages/api/src/index.ts` + generated `k8s/crds/project.yaml`.

2. **Exec pods use configured image, with fallback**
   - Satisfied by `execInWorkspace(...)` image resolution logic (`spec.exec.image` or Alpine fallback).

3. **Self-dev project uses richer tooling image**
   - Satisfied by manifest update (`k8s/self-dev/projects/percussionist-dev.yaml`) and runtime check via `exec_in_workspace`.

4. **Existing projects continue unchanged**
   - Satisfied by optional field + unchanged fallback behavior when unset.

## Proposed BUILD task breakdown

1. **BUILD A — API/CRD + kube exec image resolution**
   - Implement `spec.exec.image` in API schema.
   - Regenerate CRD.
   - Update `execInWorkspace(...)` to read project setting with fallback.

2. **BUILD B — Web UI/config plumbing**
   - Add request typing and form state.
   - Add Workspace & Services UI input.
   - Wire Create/Edit project submission payload.

3. **BUILD C — Self-dev config + docs + verification**
   - Update `k8s/self-dev/projects/percussionist-dev.yaml`.
   - Update README docs.
   - Run typecheck/tests and validate `exec_in_workspace` tool availability expectation.

## Risks / open questions

1. **Distro-coupled helper commands**
   - Some manager helper commands currently prepend `apk ...` (e.g. read-plan fallback/install-packages). On non-Alpine images this can fail.
   - Mitigation for this task: preserve Alpine fallback by default and keep self-dev override intentional.
   - Follow-up candidate: make helper commands package-manager-aware or avoid runtime package installs where possible.

2. **Extra API call in `execInWorkspace`**
   - Fetching project before every exec adds one K8s call.
   - Likely acceptable for maintenance workloads; if needed later, cache can be added.

3. **PVC naming mismatch (existing behavior)**
   - `execInWorkspace` currently assumes `${project}-data` and may ignore `spec.data.pvcName`.
   - If addressed within same change, ensure no regressions; otherwise document as known follow-up.
