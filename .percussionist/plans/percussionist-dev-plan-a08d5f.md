# Plan: Security Review and Hardening Sweep

**Task:** percussionist-dev-plan-a08d5f  
**Project:** percussionist-dev  
**Goal:** Review the Percussionist codebase for security issues, prioritize findings, and implement high-impact hardening fixes with verification.

---

## Context

Initial code review identified several security-sensitive areas across the monorepo:

1. **Web server routes are broadly unauthenticated**
   - `packages/web/src/server/app.ts` registers all API routes without auth middleware.
   - Sensitive endpoints include secret management and run control:
     - `packages/web/src/server/routes/settings.ts` (`/api/settings/secrets` CRUD)
     - `packages/web/src/server/routes/runs.ts` (run create/delete, session reply)
     - `packages/web/src/server/routes/projects.ts` (project create/update/delete with secret references)
   - `AUTH_SECRET` exists in `settings.ts` but is unused, suggesting planned but missing auth enforcement.

2. **Manager MCP server binds to all interfaces and exposes privileged tools**
   - `packages/manager-controller/src/agent/tools.ts` listens on `0.0.0.0:4097`.
   - Toolset includes high-risk operations (`exec_in_workspace`, `set_task_state`, `create_run`, `apply_upgrade`, etc.) with no request authentication layer in this server.

3. **Potential command injection in package install path**
   - `packages/manager-controller/src/agent/tools.ts` builds a shell command via string concat:
     - `apk update --quiet && apk add --no-cache ${pkgs.join(" ")}`
   - Unvalidated package names may permit shell metacharacter injection when routed through `execInWorkspace`.

4. **SSH host verification disabled by default in run pods**
   - `packages/operator/src/pod-builder.ts` sets `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null` for git operations.
   - This lowers integrity guarantees for git/SSH fetch and push paths.

5. **Renderer safety surface in web client**
   - `packages/web/src/client/components/SessionView.tsx` and `CodeBlock.tsx` use `dangerouslySetInnerHTML` for syntax-highlighted output.
   - Source is Shiki-generated HTML, but we should explicitly validate trust assumptions and enforce sanitization guarantees.

6. **Positive controls already present**
   - Request body cap in manager MCP (`MAX_BODY_SIZE = 1 MB`) in `manager-controller/src/agent/tools.ts`.
   - Session JSON size cap (`20 MB`) in `packages/kube/src/index.ts` and dispatcher session helpers.
   - Dispatcher MCP binds loopback (`127.0.0.1`), which is a good security default.

---

## Scope Boundaries

### In Scope
- Security review and hardening for:
  - `packages/web` (API authn/authz, sensitive route protection, data exposure)
  - `packages/manager-controller` (MCP exposure, tool abuse surface, command safety)
  - `packages/operator` (runtime security defaults in pod setup)
  - Shared helpers in `packages/kube` where they affect security boundaries

### Out of Scope (for this task)
- Full external pentest / fuzzing campaign
- Re-architecting entire auth model across all components
- Cluster/network policy rollout outside repo code (documented as follow-up if needed)

---

## Approach

1. **Threat model first, then patch**
   - Build a concise threat model for control plane APIs, run execution paths, and secret handling.
   - Classify findings by severity (Critical/High/Medium/Low) and exploitability in realistic cluster deployments.

2. **Prioritize “remote abuse” and “secret exposure” fixes**
   - First wave: authentication/authorization guards and command-injection prevention.
   - Second wave: secure defaults (network bind, SSH trust, least privilege).

3. **Minimize breaking changes**
   - Add secure defaults with feature flags or backward-compatible options where necessary.
   - Preserve local/dev usability with explicit opt-outs rather than silent insecure behavior.

4. **Produce auditable outputs**
   - Deliver a written findings report, code fixes, tests, and operator docs for migration/rollout.

---

## Tasks

1. **Create a structured security findings baseline**
   - Inventory all externally reachable API/MCP endpoints and privileged actions.
   - Produce a findings matrix: `finding`, `affected files`, `impact`, `exploit path`, `recommended fix`.

2. **Add authentication guardrails to web API routes**
   - Implement reusable auth middleware in `packages/web/src/server`.
   - Apply middleware to high-risk routes (`settings`, `projects`, `runs`, upgrade/apply, agent proxy paths).
   - Ensure secrets endpoints are not anonymously accessible.

3. **Define and enforce route-level authorization policy**
   - Split read-only vs mutating endpoint privileges.
   - Restrict sensitive operations (secrets CRUD, run deletion/creation, project deletion) to admin-level auth.

4. **Harden manager MCP server exposure**
   - Limit bind address by default (prefer loopback or configurable explicit host allowlist).
   - Add lightweight request authentication/authorization mechanism for MCP tool calls.
   - Ensure high-risk tools cannot be called without privileged identity.

5. **Eliminate shell-injection risk in package installation flow**
   - Validate package names against an allowlist regex (e.g. Alpine package token format).
   - Reject suspicious values before command construction.
   - Prefer argument-safe execution strategy where possible.

6. **Review and tighten `exec_in_workspace` usage controls**
   - Confirm which callers legitimately need arbitrary command execution.
   - Add explicit safeguards (privilege checks, audit logging, and optional command restrictions for non-admin contexts).

7. **Improve SSH/Git security defaults**
   - Introduce secure host key verification mode in `operator/src/pod-builder.ts`.
   - Keep compatibility path explicit and documented if strict checking cannot be defaulted immediately.

8. **Validate client-side HTML rendering safety assumptions**
   - Verify Shiki output encoding guarantees.
   - Add sanitization or explicit trust boundary comments/tests for `dangerouslySetInnerHTML` usage.

9. **Add automated security regression tests**
   - Web route tests: unauthorized requests should fail for sensitive endpoints.
   - Manager tool tests: disallow unauthorized/invalid package install inputs.
   - Include negative tests for command injection payloads.

10. **Document security model and operational rollout**
    - Update `AGENTS.md`/README with:
      - auth requirements
      - secure defaults
      - migration guidance for existing clusters
      - emergency override mechanisms (if any)

11. **Verification pass**
    - Run `pnpm typecheck`, `pnpm build`, and relevant test suites.
    - Validate no regressions in expected orchestration workflows.

---

## Risks / Open Questions

1. **Auth source of truth is not explicit yet**
   - Need decision: cluster secret token, mTLS, service-account identity, or proxy-based auth.

2. **Potential compatibility impact**
   - Existing deployments may rely on currently open web APIs/MCP; tightening could break workflows unless migration path is clear.

3. **Network topology assumptions**
   - If components are assumed private inside cluster, maintainers may consider some risks acceptable; this assumption should be made explicit and enforceable via network policies.

4. **Tooling trust model**
   - Some dangerous tools are intentionally powerful for operators; must distinguish operator-only access from agent access.

5. **SSH strict mode rollout**
   - Enforcing strict host keys may require known_hosts provisioning workflow that is not currently automated.

---

## Acceptance Criteria

- A documented findings report exists with severity and remediation mapping to concrete files/functions.
- Sensitive web endpoints require authentication and reject unauthenticated access.
- Manager MCP high-risk operations are no longer openly callable without authorization.
- Package install command path rejects injection-style input and has test coverage.
- Security defaults around SSH/network exposure are hardened (or explicit, documented opt-out paths exist).
- Regression tests cover at least the new auth and injection protections.
- Build/typecheck/tests pass for changed packages.

---

## Proposed BUILD Task Breakdown

1. **BUILD A — Web API AuthN/AuthZ Hardening**
   - Implement auth middleware and protect sensitive routes in `packages/web/src/server/routes/*`.
   - Add tests for unauthorized access rejection.

2. **BUILD B — Manager MCP Access Control + Bind Hardening**
   - Restrict MCP listener exposure and add auth checks in `packages/manager-controller/src/agent/tools.ts`.
   - Add tests for forbidden tool invocation.

3. **BUILD C — Command Injection Remediation in Workspace Tooling**
   - Validate/sanitize package inputs and harden command execution paths (`install_packages`, related workspace exec callers).
   - Add negative injection tests.

4. **BUILD D — Secure Git/SSH Defaults + Documentation**
   - Improve SSH trust defaults in `packages/operator/src/pod-builder.ts`.
   - Document migration strategy and security model updates in repo docs.
