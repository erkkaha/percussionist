# Security Review — `percussionist-dev-plan-251a9a`

## 1. Context

### 1.1 What is being reviewed

Percussionist is a Kubernetes-native orchestration system for AI agent runs: a
pnpm monorepo of TypeScript packages (`@percussionist/api`, `kube`, `operator`,
`dispatcher`, `manager-controller`, `memory-service`, `web`, `cli`) plus
deployment manifests under `k8s/`. The threat model is unusual: **runner pods
execute untrusted, AI-driven code inside the cluster**, so the cluster is
already partially hostile. Every control-plane boundary that a runner pod can
reach — or that can be reached by a CR-editing user — is in scope.

The repo already has a `SECURITY.md` that documents the intended security model
(auth model, SSH host-key modes, network policies, secret handling). This review
verifies that the implementation matches the documented model, and finds gaps
that are either undocumented or under-hardened.

### 1.2 What this planning run established

During planning, a systematic reconnaissance pass was completed across all
packages (web auth, manager MCP + chat, operator pod building + RBAC, dispatcher
MCP, memory service, CLI, API schemas, network policies). Top claims were
**verified directly against source** (file:line below). The result is a ranked
candidate-findings list (§3) that forms the initial backlog for the review, with
an execution plan (§4) for confirming each one and completing the remaining
surface.

### 1.3 Verified security-positive controls (do not regress)

- Web API: human GitHub-OAuth sessions vs. scoped API keys are strictly
  separated; keys can never satisfy `auth()`/`adminAuth()`
  (`packages/web/src/server/auth.ts`); empty `GITHUB_ALLOWED_LOGINS` = nobody
  (`lib/better-auth.ts`); run keys scoped to `stats:write` with expiry +
  revocation; no `?token=` acceptance on HTTP routes (no cred leak in logs).
- Manager MCP: constant-time token compare; **loopback exemption does not grant
  `trustedBearer`** — sanitization bypass and image override are token-gated
  (`tools.ts:2911–2954`); 1 MB body limit (`readBody`, `tools.ts:918–936`).
- Dispatcher MCP binds `127.0.0.1` only (`packages/dispatcher/src/mcp-server.ts:1553`);
  `search_code` uses array-arg `execFile` + lexical confinement to `/workspace`.
- Operator: user-controlled git fields pass via env vars, never string
  interpolation into shell (`pod-builder.ts:683–707`); runner container drops
  all capabilities, `automountServiceAccountToken: false`, `RuntimeDefault`
  seccomp (`pod-builder.ts:838–871`); sidecar `securityContext` sanitizer strips
  privileged/root unless `PERCUSSIONIST_ALLOW_PRIVILEGED_SIDECARS=true`.
- Manager's own worktree cleanup quotes correctly (`worktree-cleanup.ts:67–69`).
- No `eval(`, no `shell: true`, no template-literal `child_process`, no MD5/SHA1
  auth use, no hardcoded secrets anywhere in `packages/*/src`.

## 2. Scope

### In scope
- Control-plane ingress/auth: manager MCP (`:4097`), chat handler (`:4098`),
  opencode-web sidecar (`:4096`), dispatcher MCP, memory service (`:4100`), web
  REST + SSE + WebSocket + Ingress.
- Command construction / injection: operator pod-builder, TTL cleanup, manager
  exec/cleanup helpers, `apk add` paths, code-server init.
- Secrets handling: mounting, env injection, session snapshot persistence,
  RBAC breadth.
- Kubernetes manifests: `k8s/deploy/*.yaml` RBAC + NetworkPolicy + Ingress/TLS.
- API schemas (`packages/api`) as they widen the attack surface (initScript,
  sidecars, packages, ollamaUrl, mountPath).

### Out of scope
- The AI provider SDKs / opencode core itself (third-party).
- LLM prompt-injection *within* a single run (agent vs. its own task) — the
  board workflow already treats that as the product's job; we review only the
  surfaces where **another tenant / runner pod** can inject.
- Code-level review of `@percussionist/cli` beyond secret handling (its surface
  is a local user's machine).
- Fixes themselves — this PLAN produces the review + remediation BUILD backlog.

## 3. Initial candidate findings (from planning reconnaissance)

Priority = likely severity × likelihood. Each requires confirmation by the BUILD
step that implements it (see Tasks). All file:line references verified during
planning.

| # | Sev | Finding | Location | Remediation direction |
|---|-----|---------|----------|----------------------|
| F1 | **High** | Manager chat port `:4098` is **unauthenticated**, binds `0.0.0.0`, has **no body-size limit**, and drives the decision agent (which has `bash: allow` + the full loopback MCP tool surface incl. `delete_run`, `set_task_state admin:true`, `force_retry`, `apply_upgrade`). NetworkPolicy deliberately leaves 4098 open to all pods. Any runner pod can prompt-inject the manager LLM into destructive tool calls. | `chat-handler.ts:138–145, 156–187`; `k8s/deploy/networkpolicy.yaml:46–53` | Bearer-token auth on 4098 (reuse `MCP_TOKEN`), body-size cap, and either restrict the NetworkPolicy rule (with a documented exception path for `beatctl chat`) or an explicit `beatctl chat` auth flow. |
| F2 | **High** | Manager + operator ClusterRoles hold `secrets get` at **cluster scope**; manager also holds `deployments get/list/patch` (enables `apply_upgrade` image swap). Compromise of the manager (chat agent, `apply_upgrade`, or web pod which holds `MCP_TOKEN` + `pods/exec` + full Secret CRUD) ≈ cluster-wide secret disclosure / control-plane RCE. | `manager-controller.yaml:57–63`; `operator.yaml:63–65, 70–72`; `web.yaml:70–77` | Namespace-scoped Roles with `resourceNames` limits for the specific Secrets each component needs; web Role: drop `secrets` create/update/delete (settings/secrets should route through manager or a dedicated path). |
| F3 | **High** | No per-tool authorization beyond the coarse MCP boundary: `set_task_state`'s `admin:true` bypass and `force_retry`'s forced transitions are usable by any **loopback** caller without a token; `apply_upgrade`, `delete_run`, `create_run`, `install_packages`, `patch_board` also ungated. The sidecar agent (inside every run pod) reaches all of these. | `tools.ts:1499–1630, 1725–1841`; `tools.ts:1092–2836` | Gate destructive tools on `ctx.trustedBearer` (mirror the `exec_in_workspace` model): `apply_upgrade`, `delete_run`, `set_task_state` (+`admin`), `force_retry`, `create_run`, `install_packages`, `patch_board` reject untrusted callers; explicit allowlist for the few the sidecar legitimately needs. |
| F4 | **Medium-High** | Shell injection from `spec.data.mountPath` in the operator's TTL cleanup Job: `rm -rf ${worktreeDir}` **unquoted** (root, `alpine/git`) — the manager's equivalent quotes correctly. Same unquoted/unescaped interpolation in manager `cleanupRunWorktree` (`tools.ts:1038`) and `read_plan` git fallback (`tools.ts:2102`). Exploit needs CR write (project editor), but CR write already implies `spec.exec.image` control — defense-in-depth gap, and the operator's quoting is simply inconsistent with its own sibling code. | `operator/src/ttl.ts:119–126, 167`; `tools.ts:1025–1045, 2096–2128` | Quote with the existing `shQuote` helper; validate/normalize `spec.data.mountPath` in `packages/api` Zod schema (allowlist of path chars, no whitespace/`'`/`;`). |
| F5 | **Medium** | `exec_in_workspace` maintenance pod has **no `securityContext`** (root), **no `automountServiceAccountToken:false`**, no ownerReference; mounts the project PVC (bare git mirrors whose configs can embed credentials) with the namespace default SA token readable. | `packages/kube/src/index.ts:1877–1906` | Add `automountServiceAccountToken: false`, non-root + capability-drop + seccomp, and an ownerReference (or a `ttlSecondsAfterFinished`-style guarantee) to the `ws-exec` pod. |
| F6 | **Medium** | Memory service auth silently **off by default**: when `manager-mcp-token` Secret is absent, `MCP_TOKEN` is empty and `isAuthorized()` returns true for everything. The Secret is only created by `beatctl auth mcp-token rotate` — nothing bootstraps it like the operator/manager keys. Memories are injected verbatim into worker prompts (prompt-injection surface). | `packages/memory-service/src/index.ts:32, 77–84`; `cli/src/auth-keys.ts:228–252` | Bootstrap `manager-mcp-token` at web startup (like `agent-keys.ts:238`), or make memory-service refuse to start (fail-closed) without a token; document in SECURITY.md. |
| F7 | **Medium** | `embedding.ollamaUrl` is per-project and **unvalidated** → SSRF from the memory pod to arbitrary internal addresses (metadata endpoint, kube-apiserver, other services); the memory pod also automounts the default SA token. | `packages/api/src/index.ts:256`; `operator/src/memory-service.ts:66`; `memory-service/src/embed.ts:10–15` | Validate URL scheme (`http(s)`) + host (cluster-DNS suffix or explicit allowlist); `automountServiceAccountToken: false` on memory-service + code-server Deployments. |
| F8 | **Medium** | Code-server runs with `auth: none`, as root, exposed via an Ingress with **no TLS/auth** when `PERCUSSIONIST_INGRESS_BASE_URL` is set — unauthenticated full read/write of the project PVC + root terminal from the network. | `packages/operator/src/code-server.ts:239–240, 509, 553, 652–708` | Require a generated/configured password (`password` field or basic-auth Ingress annotation), non-root where possible, and TLS via Ingress annotations; document opt-in warnings. |
| F9 | **Medium** | Session snapshots + web stats DB persist agent **tool-call inputs unredacted** (`compactMessagesForSnapshot` keeps `state.input` verbatim; `stats-reporter` stores `JSON.stringify(state.input)`). Agents routinely echo secrets (env exports, `curl -H "Authorization: Bearer …"`, `gh` tokens) into tool inputs → secrets at rest in ConfigMaps + SQLite, readable via `read_session` and the dashboard. | `dispatcher/src/session.ts:99–128`; `dispatcher/src/stats-reporter.ts:267, 291` | Redaction layer for snapshot/stats persistence (secret-shaped patterns: `KEY=`, `Bearer `, `sk-`, `ghp_`, ssh private key headers) with an allowlist for URLs; document residual exposure. |
| F10 | **Medium** | Dispatcher MCP `read_session`/`read_plan`/`write_plan` accept **arbitrary runName/project** and read/write any `{…}-session`/`{…}-plans` ConfigMap in the namespace → intra-namespace cross-project data access when multiple projects share a namespace. | `packages/dispatcher/src/mcp-server.ts:745–815` | Pin to `RUN_PROJECT`/own run by default with an explicit override flag; or namespace-per-project; at minimum document + enforce in a shared-namespace guide. |
| F11 | **Medium** | Web Ingress + `WEB_BASE_URL` are plain HTTP → session cookie (not `Secure`) and bearer traffic in cleartext; no security headers (CSP, X-Frame-Options, X-Content-Type-Options). | `k8s/deploy/web.yaml:212–213, 316–336` | TLS block + `WEB_BASE_URL` https by default in reference manifests (documented as dev default); add security-header middleware to the Hono app; mark cookie `Secure` when TLS. |
| F12 | **Medium** | Per-run stats key falls back to the operator's **standing key** when minting fails (`runApiKey ?? WEB_AUTH_TOKEN`, pod-builder.ts:1062) — a leaked fallback exposes the operator credential to the untrusted pod (scoped to `runkeys:mint` only, but erodes the per-run isolation model). | `operator/src/pod-builder.ts:1062` | Fail the run or mint a scoped fallback that is never the standing key; log loudly when fallback engages. |
| F13 | **Low-Med** | NetworkPolicy is ingress-only (no egress), unenforced on default minikube/kind CNI, and the memory-service rule allows only `component: manager` while the **web pod also proxies `:4100`** (`project-memories.ts`) — on enforcing CNIs the dashboard's memories tab breaks, on non-enforcing CNIs runners can reach everything. | `k8s/deploy/networkpolicy.yaml:9–11, 55–80`; `web/src/server/routes/project-memories.ts:25–38` | Add web pod to the memory-service allowlist (fix functional break) + a runner-isolation policy (runner→manager/web/other runners denied) + document egress policy. |
| F14 | **Low-Med** | CLI `auth.ts:326`: `runWebTokenRotate --dry-run` prints the **full web-auth admin token** to stderr. `runWebTokenShow` prints full token by design. | `packages/cli/src/auth.ts:257, 326` | Print a fingerprint (first/last 4) unless an explicit `--show-value` flag; keep `show` but flag in docs. |
| F15 | **Low** | `runner.packages` / `codeServer.packages` are interpolated **unquoted** into `apk add` / `apt-get install` (word-splitting safe-ish, but option/URL/path smuggling possible: `--allow-untrusted`, remote `.apk` URL, local path); `initScript` is unconstrained arbitrary root shell (design-accepted, no size cap). | `packages/api/src/index.ts:74, 237, 697`; `operator/src/pod-builder.ts:467–478`; `operator/src/code-server.ts:228–236` | Harden package validation (reuse the manager's allowlist regex from `security.ts`), add size caps to `initScript`; document as accepted risk. |
| F16 | **Low** | `patch_board` ignores `args.namespace` and always patches the constant namespace — cross-namespace footgun if namespace params are used. | `tools.ts:1310–1321` | Honor namespace arg or validate it equals the constant. |

### Findings summary
3 High, 9 Medium, 4 Low-Med/Low. No critical (the SSRF at F7 and exec at F5 are
mitigated by the operator already being the trust boundary for CR writers, and
by token-gating on exec — they are defense-in-depth items).

## 4. Approach

The review is **evidence-first**: every finding in §3 must be confirmed by
reading the cited code (done for the top items during planning; the rest get
confirmed during execution), then by a targeted reproduction where feasible
(unit-level reproduction via existing test harness — no live cluster mutations
for destructive paths). Only confirmed findings are carried into the report and
the remediation backlog.

1. **Verify §3 candidates** (F1–F16): re-read the cited code, check for
   mitigations the planning pass may have missed, confirm exploitability
   preconditions (who can set the field / reach the port), and assign final
   severity using a simple likelihood×impact rubric.
2. **Close remaining surface**: a focused read of (a) `packages/kube` clients
   for auth/interpolation, (b) `packages/api` schema `refine()`s vs. operator
   re-validation, (c) `dispatcher` snapshot + stats write path, (d) web SSE/WS
   attach auth (already flagged — verify origin checks), (e) Flux gitops path
   (`k8s/flux/`, `gitops.ts`) for credential handling.
3. **Produce the deliverable**: `docs/security-review-YYYY-MM.md` — full report
   (methodology, scope, verified findings with file:line + reproduction +
   remediation, accepted risks, control inventory) and a **proposed hardening
   backlog** (the BUILD breakdown in §7, ordered).
4. **Update `SECURITY.md`** to reflect any model changes the report mandates
   (e.g. chat auth, memory token bootstrap, TLS default).
5. **File BUILD tasks** for the confirmed hardening backlog (§7) via
   `create_task`, with `predecessorRef` where ordering matters (F1 before F3 if
   the trust-gating touches the same request path; F13 after F6 to avoid
   breaking the memories tab).

Acceptance criteria (review deliverable):
- Every §3 candidate is dispositioned (confirmed + severity, confirmed-not-issue
  with reason, or re-classified).
- The report covers all components in §2 scope; no component is "not looked at".
- Each confirmed finding has: trigger conditions (who can do what), file:line,
  suggested fix, and a proposed BUILD task reference.
- `SECURITY.md` is updated in the same work as the report.
- High-severity findings (F1–F3) each map to at least one BUILD task; nothing
  confirmed High is left without a remediation task.

## 5. Tasks (review execution, ordered)

1. Confirm F1–F16 against source; drop or downgrade any that are already
   mitigated; record evidence per finding in the report draft.
2. Focused review pass on the remaining surface (§4.2) — at minimum verify:
   `attach-ws` origin/session checks, `packages/kube` exec + mirror helpers,
   schema `refine()` enforcement (`spec-validation.ts`), Flux gitops credential
   handling, web SSE auth path, `stats-reporter` payload size limits.
3. Write `docs/security-review-2026-08.md` with §4.3 structure.
4. Update `SECURITY.md` with changes the review mandates (chat auth model,
   memory token bootstrap, TLS note, new RBAC table if Roles change).
5. Create BUILD tasks (§7) with `create_task`, wired with `predecessorRef`
   where required; each BUILD task description embeds the confirmed finding +
   file:line + remediation target from the report.
6. Run `pnpm typecheck && pnpm test` on any repo-touching confirmations, and
   ensure the branch builds before merging.

## 6. Risks / open questions

- **`beatctl chat` vs. 4098 auth (F1):** port-forward traffic arrives on the
  pod's loopback, so a plain token check would not distinguish it from the
  sidecar. Options: (a) require `MCP_TOKEN` on 4098 and make `beatctl chat`
  send it (CLI already reads `~/.config/percussionist` creds); (b) restrict the
  NetworkPolicy to web + manager pods and document that `beatctl chat` breaks
  on enforcing CNIs. Needs a product decision — the review report should
  recommend one.
- **Threat-model boundary for RBAC (F2):** `secrets get` cluster-wide may be
  load-bearing for operator features (e.g. reading a project's GitHub token
  Secret). The fix must verify each current Secret read and enumerate needed
  names before narrowing.
- **Session redaction (F9):** redaction is lossy for legitimately-secret-bearing
  sessions; need a conservative default (redact + store a marker) and a
  dashboard toggle. Product decision.
- **Code-server auth (F8):** password UX for the opt-in IDE — store generated
  password in a Secret + surface via `kubectl`/CLI, or require the user to set
  one. Open question.
- **NetworkPolicy enforcement:** the reference manifests admit non-enforcing
  CNIs. Hardening code paths (F1/F3) is the effective control; NetworkPolicy
  changes are defense-in-depth. State this in the report.
- **Scope question for the orchestrator:** whether this review should also
  produce the hardening BUILD tasks (recommended here) or stop at the report.
  Default assumed: review + remediation backlog.

## 7. Proposed BUILD task breakdown (ordered, each independently shippable)

1. **`build-*: chat handler auth + limits` (F1)** — bearer token on `:4098`
   (accept `MCP_TOKEN`, loopback-only exemption narrowed to nothing or to a
   documented dev mode), 1 MB body cap reusing the MCP `readBody` pattern;
   update `beatctl chat` to send the token; NetworkPolicy: close 4098 to
   non-web/manager or document the tradeoff.
2. **`build-*: destructive MCP tool trust-gating` (F3)** — require
   `ctx.trustedBearer` for `apply_upgrade`, `delete_run`, `set_task_state`
   (incl. `admin`), `force_retry`, `create_run`, `install_packages`,
   `patch_board`; add tests for loopback-without-token rejection.
3. **`build-*: RBAC least-privilege pass` (F2)** — narrow manager/operator
   `secrets get` to namespace Roles with `resourceNames`; drop web Role's
   `secrets` write verbs and `pods/exec` if chat/terminal can route through
   manager; update manifests + tests; document any load-bearing reads.
4. **`build-*: quote shell paths in cleanup paths` (F4)** — apply `shQuote` in
   `operator/src/ttl.ts` (worktreeDir + symbolic-ref line), manager
   `cleanupRunWorktree`, `read_plan` git fallback; add unit tests with hostile
   `mountPath` values; add `mountPath` validation to `packages/api`.
5. **`build-*: harden ws-exec pods` (F5)** — `automountServiceAccountToken:
   false`, non-root + cap-drop + seccomp securityContext, ownerReference to the
   triggering Run/Project; regression tests on the pod spec builder.
6. **`build-*: memory service auth bootstrap + SSRF hardening` (F6+F7)** —
   bootstrap `manager-mcp-token` at web startup (fail-closed on missing token
   for memory-service), validate `ollamaUrl` scheme/host, SA-token hardening on
   memory + code-server Deployments; fix NetworkPolicy to include web pod (F13
   half).
7. **`build-*: code-server auth` (F8)** — password auth (Secret-backed) with
   CLI/kubectl retrieval path, TLS annotation on the IDE Ingress, docs.
8. **`build-*: session snapshot + stats redaction` (F9)** — redact
   secret-shaped tool inputs in `session.ts` and `stats-reporter.ts`; snapshot
   size guards; tests with fixture secrets.
9. **`build-*: dispatcher cross-project access scoping` (F10)** — pin
   `read_session`/`read_plan`/`write_plan` to `RUN_PROJECT`/own run with
   explicit allowlist override; docs for shared-namespace deployments.
10. **`build-*: TLS + security headers for web` (F11)** — TLS block in
    `web.yaml` (documented default for real clusters), `WEB_BASE_URL` https
    guidance, Hono security-header middleware, `Secure` cookie behind TLS.
11. **`build-*: per-run key isolation` (F12)** — remove the standing-key
    fallback in `pod-builder.ts:1062` (fail run or mint scoped fallback),
    loud logging when fallback engages.
12. **`build-*: CLI token echo + package validation` (F14+F15)** — fingerprint
    instead of full token in `--dry-run`; apply the package allowlist regex in
    operator/code-server package installs; `initScript` size cap.
13. **`build-*: network policy coverage` (F13)** — runner-isolation policy,
    memory-service policy includes web pod, documented egress policy template.
14. **`docs: security review report + SECURITY.md update` (deliverable)** —
    `docs/security-review-2026-08.md` + SECURITY.md refresh. Should land with or
    immediately after the code BUILD tasks.

Suggested ordering for `predecessorRef`: 14 depends on the code tasks being
confirmed; 6 before 13 (policy change affects the web proxy); 2 before 1 if
they share the request path; 3 independent. Tasks 1–3 are the High-severity
fixes and should be scheduled first.
