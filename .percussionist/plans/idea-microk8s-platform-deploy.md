# beatctl deploy — native MicroK8s support (first-class citizen, Traefik ingress)

Task ID: `idea-microk8s-platform-deploy`
Branch: `feature/idea-microk8s-platform-deploy`
Revision: 3 (retry 2/3)

> Supersedes revision 1 (the copy currently in the plans ConfigMap) and
> revision 2 (worktree-only, committed but never persisted). Revision 3 is the
> authoritative plan; it carries the retry feedback forward and deepens the
> revision-2 approach with live-verified MicroK8s facts and a full nginx
> reference inventory.

## Context

`beatctl deploy` (`packages/cli/src/deploy.ts`) installs the whole control plane
(CRDs + operator + manager + web + NetworkPolicies) but is written against one
reference topology — minikube with the ingress-nginx addon:

- **TLS setup is always attempted and hardcodes ingress-nginx.** `setupTls()`
  targets the `ingress-nginx` namespace, the `ingress-nginx-controller`
  Deployment and Service, patches its args with
  `--default-ssl-certificate=ingress-nginx/percussionist-tls-wildcard`, and pins
  the HTTPS NodePort to 30443. ~30 literal `ingress-nginx` / `ingress-nginx-*`
  strings live in `deploy.ts` alone (verified: lines 7-11, 123, 149-172,
  185-197, 222-259, 262-305, 312-355, 362-367, 480, 636, 644, 668-669, 756-757).
- **nip.io is assumed.** `setupTls()`, `patchedOperatorManifest()`,
  `applyGitopsBootstrap()` and the summary banner all build
  `https://{nodeIP}.nip.io:30443`; `patchedOperatorManifest` only replaces
  `value:` lines that already contain `nip.io`.
- **Checked-in manifests carry minikube defaults.** `k8s/deploy/operator.yaml`
  sets `DEFAULT_STORAGE_CLASS=standard` and
  `PERCUSSIONIST_INGRESS_BASE_URL=http://192.168.49.2.nip.io:30080`;
  `k8s/deploy/web.yaml` hardcodes Ingress host `app.192.168.49.2.nip.io` with
  `ingressClassName: nginx` and `WEB_BASE_URL=http://app.192.168.49.2.nip.io`.
  `beatctl deploy` never patches web.yaml — it relies on those checked-in
  defaults matching the cluster, which only holds for minikube.
- **Nginx references leak into shared surfaces** (complete repo inventory,
  verified with ripgrep across `packages scripts k8s docs`):
  `packages/cli/src/deploy.ts` (code), `packages/cli/src/gitops-manifest.ts`
  (docstring example `https://1.2.3.4.nip.io:30443`),
  `scripts/minikube-load.sh` (NodePort-pin block, lines 409-421),
  `k8s/deploy/operator.yaml` (env comments lines 229-234, 249-252),
  `k8s/deploy/web.yaml` (comment block lines ~305-322 + `ingressClassName: nginx`
  line 325 — the comment block also contains a **stale `traefik.me` reference**
  that contradicts the actual nip.io host in the same file),
  `k8s/local.example/tailnet-ingress.yaml` (comment),
  `docs/guide/installation.md` (line 111), `docs/guide/lxd-microk8s-tailscale.md`
  ("Do not use `beatctl deploy`" + "fails looking for nginx" failure row),
  `README.md` (ingress-controller table, `PERCUSSIONIST_INGRESS_CLASS=nginx`
  + nginx-annotation examples, lines 1023-1131).

The operator side is already platform-agnostic: `packages/operator/src/config.ts`
consumes `DEFAULT_STORAGE_CLASS`, `PERCUSSIONIST_INGRESS_BASE_URL`,
`PERCUSSIONIST_INGRESS_CLASS` and `PERCUSSIONIST_INGRESS_ANNOTATIONS` from env
(data PVCs, per-run + code-server Ingresses), so **zero operator code changes
are needed** — the deploy just has to set the right env values. `beatctl doctor`
(`doctor-platform.ts`) is already platform-neutral (no nginx strings).

### Verified MicroK8s facts (official docs, microk8s.io/docs/addon-ingress)

1. **Addons** — `microk8s enable dns rbac hostpath-storage ingress`. `rbac`
   switches the API server from `AlwaysAllow` to real RBAC; Percussionist relies
   on dedicated ServiceAccounts + scoped RoleBindings, which are meaningless
   under `AlwaysAllow`. `hostpath-storage` creates the `microk8s-hostpath`
   StorageClass (`WaitForFirstConsumer`, node-local, single-node only).
   MicroK8s' default Calico CNI enforces `k8s/deploy/networkpolicy.yaml` — this
   is a CNI-dataplane concern, independent of the RBAC enablement, but both are
   part of the security posture the deploy must enable/verify.
2. **Ingress backend differs by MicroK8s version.** Since **1.35 the ingress
   addon ships Traefik** (Helm chart in the `ingress` namespace) with three
   IngressClasses: **`public` (default), `traefik`, and `nginx`** (backward
   compat: existing `ingressClassName: nginx` resources keep working, routed
   through Traefik's `kubernetesIngressNginx` provider). The `public` class is
   documented as "backward compatible with the previous NGINX setup", i.e. it
   keeps the host/path routing behaviour Percussionist already relies on —
   which is exactly why it is the right default for us. Before 1.35 the addon
   is NGINX (`nginx-ingress-microk8s-controller` in the `ingress` namespace).
   `microk8s disable ingress` removes Traefik, Gateway API CRDs, and cleans up
   legacy NGINX resources.
3. **Traefik default TLS cert** is set by re-enabling the addon with an option:
   `microk8s enable ingress --default-ssl-certificate <namespace>/<secret>` —
   the documented, idempotent mechanism (the Secret must exist first). The
   addon also supports NGINX annotations via the `kubernetesIngressNginx`
   provider, so legacy annotation users keep working.
4. **kubectl access** — the workstation talks to MicroK8s through a kubeconfig
   exported from `microk8s config`; the `microk8s` binary may not exist on the
   workstation (LXD-VM topology) and may need `sudo` when it does. The deploy
   must not require the `microk8s` CLI.

### Retry feedback (drives this revision)

1. **Make MicroK8s a first-class citizen** — not a bolt-on `--platform
   microk8s` flag bolted onto a minikube-first design. MicroK8s must get the
   same out-of-the-box experience minikube has today: `beatctl deploy` with no
   flags should work on MicroK8s (auto-detect), docs give MicroK8s equal
   billing, and the LXD playbook's "apply manifests by hand" workaround must go
   away.
2. **Traefik is the de facto ingress class** — on MicroK8s 1.35+ Percussionist
   Ingresses must use the native Traefik path (`public` IngressClass, the
   documented default), not the `nginx` backward-compat class;
   `ingressClassName: nginx` is only for legacy <1.35 installs. TLS uses the
   documented `--default-ssl-certificate` addon mechanism.
3. **Clean up nginx references and code** — every *unconditional* nginx
   assumption must be removed from shared code, manifests, scripts and docs.
   (minikube's addon *is* ingress-nginx, so the minikube profile legitimately
   keeps nginx handling — but nothing else in the repo should assume it.)

## Approach

Introduce a **platform layer** in the CLI: platform profiles + best-effort
**auto-detection** (default), with explicit `--platform` override. MicroK8s
gets a full peer profile of minikube (addons, storage, ingress backend
detection, TLS, URL construction), Traefik-first on 1.35+, and the nginx
references are swept out of the shared deploy path and docs.

### Key decisions

1. **`--platform auto|minikube|microk8s|generic`** — **default `auto`**:
   resolve from the cluster, print the result, never silently guess wrong in a
   destructive way (detection feeds *which preflight checks run and which
   defaults are patched*, and `--platform` always overrides). Detection order:
   - kubeconfig context name (`kubectl config current-context`) containing
     `microk8s` → microk8s; containing `minikube` → minikube. The context name
     is the **authoritative** signal — it works even on a fresh MicroK8s with
     no addons enabled yet (the `microk8s-hostpath` StorageClass probe below
     would miss that case).
   - else cluster probes: `microk8s-hostpath` StorageClass exists → microk8s;
     any node carries the `node.kubernetes.io/microk8s-controlplane` label →
     microk8s; node names start with `minikube` → minikube. These are secondary
     signals for renamed contexts (common in LXD-VM topologies).
   - else `generic` (no ingress/TLS assumptions — covers LXD/Tailscale and
     real clusters). `generic` implies `--skip-tls`.
   - On a minikube cluster, `auto` **must** resolve to the minikube profile so
     existing no-flag behavior is byte-for-byte preserved (regression target).
2. **Platform profile struct** in a new `packages/cli/src/deploy-platform.ts`:
   `{ name, ingressNamespace, controllerDeployment, controllerService,
   ingressClass, storageClass, httpNodePort, httpsNodePort, defaultDomain(ip),
   controllerKind: 'nginx' | 'traefik' | 'none' }`. All TLS helpers in
   `deploy.ts` take the profile instead of hardcoded strings.
   - minikube: `ingress-nginx` / `ingress-nginx-controller` / `nginx` /
     `standard` / 30080 + 30443 / `{ip}.nip.io` — exactly today's behavior.
   - microk8s: `ingress` namespace, backend detected at deploy time (Traefik
     deployment present → **`ingressClass: public`**, `controllerKind:
     'traefik'`; legacy `nginx-ingress-microk8s-controller` present → `nginx`,
     `controllerKind: 'nginx'`), `storageClass: microk8s-hostpath`, HTTPS
     NodePort pin 30443 (only when the controller Service is NodePort — see
     risks), domain `{ip}.nip.io` default, overridable.
   - generic: no TLS, no ingress namespace/class assumptions, storage class
     left as the manifest default unless `--storage-class` is given.
3. **`--domain <host>`** decouples the base URL from nip.io (default
   `{ip}.nip.io` per profile); wildcard cert becomes `*.{domain}`.
   **`--http-port` / `--https-port`** override NodePorts (profile defaults).
   **`--storage-class <name>`** overrides `DEFAULT_STORAGE_CLASS` (also useful
   for longhorn/rwx clusters on any platform). **`--skip-tls`** skips cert
   generation, controller default-cert config and port pinning; `generic`
   implies it. `--tls-secret <ns>/<name>` names the Secret (default
   `percussionist-tls-wildcard` in the deploy namespace).
4. **MicroK8s addon handling is CLI-optional, verification-mandatory.**
   - `microk8s` on PATH → `microk8s status --wait-ready` →
     `microk8s enable dns rbac hostpath-storage ingress` →
     `microk8s status --wait-ready`. Addons are idempotent; re-enabling
     `ingress` with `--default-ssl-certificate percussionist/<secret>` after
     applying the Secret is the documented Traefik TLS mechanism.
   - No CLI (LXD-VM) → verify effects through kubectl: `microk8s-hostpath`
     StorageClass exists, a controller is present in the `ingress` namespace,
     CoreDNS Available; fail with the exact `microk8s enable …` command to run
     on the host if anything is missing. RBAC enablement is not externally
     verifiable → best-effort warning with instructions (never a silent skip).
   - Never shell out to `sudo microk8s` implicitly.
5. **Traefik-first TLS on MicroK8s (ordering matters):**
   - Phase A (preflight): addons enabled (`microk8s enable dns rbac
     hostpath-storage ingress` — includes ingress) or verified present.
   - Phase B (TLS): Secret applied to the deploy namespace **before** any
     controller config (both backends require the Secret to exist first).
   - Traefik backend: `microk8s enable ingress
     --default-ssl-certificate percussionist/percussionist-tls-wildcard` —
     documented, idempotent, works whether ingress was just enabled or already
     enabled (reconfiguration). No-CLI fallback: patch the Traefik Deployment
     args with the default-certificate flag, **documented as best-effort**
     (exact flag name on the Traefik container to be verified live — see
     risks).
   - Legacy NGINX backend: arg patch
     `--default-ssl-certificate=ingress/percussionist-tls-wildcard` + NodePort
     pin (same mechanics as minikube, different namespace/deployment).
   - Ingress class choice: `public` on Traefik (documented default and
     nginx-routing-compatible), `nginx` on legacy NGINX. Traefik's
     backward-compat `nginx` class remains the cross-version safe fallback when
     backend detection is inconclusive.
6. **Manifest patching generalized and extended to web.yaml** (pure functions
   in a new `packages/cli/src/deploy-manifests.ts` so they are unit-testable):
   - `patchedOperatorManifest(yaml, { baseUrl, storageClass, ingressClass })`
     — replace the `value:` under `PERCUSSIONIST_INGRESS_BASE_URL` (drop the
     nip.io-specific regex), replace `DEFAULT_STORAGE_CLASS`, set
     `PERCUSSIONIST_INGRESS_CLASS`. Keep the warn-and-apply-unmodified
     fallback.
   - `patchedWebManifest(yaml, { host, ingressClass, webBaseUrl })` — replace
     the Ingress `host:` line, `ingressClassName`, and `WEB_BASE_URL` env value
     so the dashboard origin always matches the Ingress (this is what
     `checkDashboard` in `doctor-platform.ts` verifies).
   - `patchFluxManifest` (`gitops-manifest.ts`) gains optional `storageClass`
     and `ingressClass` substitutions (same name/value-pair regex style as the
     existing `INGRESS_RE`, throw-on-drift as today); the gitops path threads
     the computed `baseUrl` instead of the hardcoded nip.io URL.
7. **Nginx cleanup (shared code/docs/scripts), enumerated:**
   - `packages/cli/src/deploy.ts` — remove every literal `ingress-nginx` /
     `ingress-nginx-controller` string (lines listed in Context); TLS helpers
     become profile-driven (functionally identical output on the minikube
     profile).
   - `packages/cli/src/gitops-manifest.ts` — docstring example at line 15
     becomes controller-neutral (`https://{host}:{port}`).
   - `scripts/minikube-load.sh` (lines ~409-421) — the NodePort pin block stays
     (it is a minikube+nginx script) but its comments must not present nginx
     pinning as the generic path; wording updated.
   - `k8s/deploy/operator.yaml` — the commented `PERCUSSIONIST_INGRESS_*`
     example (lines ~249-252) switches from nginx annotations to a
     controller-neutral note + a Traefik example; the "minikube with nip.io"
     comment (line ~229) gains the microk8s variant.
   - `k8s/deploy/web.yaml` — comment block (lines ~305-322) rewritten, **also
     fixing the stale `traefik.me` reference that contradicts the file's own
     nip.io host**; `ingressClassName: nginx` stays as the *checked-in* default
     (it works on minikube, on MicroK8s legacy, and on MicroK8s 1.35+ via the
     backward-compat class, so plain `kubectl apply -k k8s/deploy/` keeps
     working everywhere) but the comment states the deploy patches it per
     platform (`public` on Traefik backends).
   - `k8s/local.example/tailnet-ingress.yaml` — nginx comment tidied; class
     stays `nginx` (minikube example).
   - `README.md` — minikube setup paragraph no longer describes the deploy as
     nginx-specific; ingress-controller table and operator-config examples gain
     MicroK8s/Traefik variants (`PERCUSSIONIST_INGRESS_CLASS=public` +
     Traefik-aware annotations); add a MicroK8s quickstart block.
   - `docs/guide/installation.md` — line ~111 nginx mention generalized.
   - `docs/guide/lxd-microk8s-tailscale.md` — "Do not use `beatctl deploy`"
     section replaced with `beatctl deploy` (auto-detects microk8s, or
     `--platform microk8s --skip-tls` where ingress addon is disabled for
     Tailscale Serve); the `standard` StorageClass alias workaround and the
     "fails looking for nginx" failure row are removed.
8. **`ensureNamespace(ns)`** — create the target namespace if missing (all
   platforms benefit; the LXD playbook currently hand-rolls this).
9. **`--down`** — unchanged resource deletion; optionally delete the TLS Secret
   from the profile's namespace. Addons are never disabled on teardown
   (conservative: cluster-level state the user may share).
10. **MicroK8s API-server TLS is out of scope** — kubectl reaches MicroK8s via
    the exported kubeconfig (:16443 with its own certs); `beatctl` never
    touches it.

## Scope boundaries

- **CLI + checked-in deploy manifests + docs/scripts only.** No changes to
  `packages/operator`, `packages/web`, `packages/manager-controller`,
  `packages/api`, or the CRDs. The operator already consumes every env knob the
  deploy sets.
- **No microk8s image-load script.** `scripts/minikube-load.sh` is untouched
  functionally; loading locally-built images into MicroK8s (`microk8s ctr
  images import` / `sideload`) is a separate concern.
- **No E2E suite in CI** — CI has no MicroK8s cluster. Verification is unit
  tests (pure functions) + the documented manual playbook run.
- **minikube profile keeps nginx** — nginx is minikube's addon; "cleanup" means
  removing *unconditional* nginx assumptions and stale references, not deleting
  nginx support.
- **RBAC enforcement** is enabled/verified best-effort (warning), never
  silently disabled.
- `--platform generic` is included because the LXD/Tailscale playbook is the
  exact topology where the current command fails; it is the smallest expression
  of "no nginx, no nip.io assumptions".

## Tasks (BUILD breakdown)

1. **BUILD: platform profiles, auto-detection, CLI flags**
   - New `packages/cli/src/deploy-platform.ts`:
     `DeployPlatform = 'auto' | 'minikube' | 'microk8s' | 'generic'`,
     `PlatformProfile` interface, `platformProfile(platform)` resolver,
     `resolvePlatform(clusterHints)` auto-detection (context name, then
     StorageClass / node-label / node-name probes — see decision 1),
     `baseUrl(profile, domain, port)`, `detectMicroK8sIngressBackend()` (probe
     `ingress` namespace for a Traefik deployment vs
     `nginx-ingress-microk8s-controller`), and the three concrete profiles.
   - `packages/cli/src/index.ts`: add `--platform`, `--domain`, `--http-port`,
     `--https-port`, `--storage-class`, `--skip-tls`, `--tls-secret` to the
     `deploy` command (currently lines 64-75); extend `DeployOpts` in
     `deploy.ts`.
   - Behavior-preserving guarantee: `auto` on a minikube cluster resolves to
     the minikube profile; no flags ⇒ identical flow to today.

2. **BUILD: parameterize TLS/ingress setup (deploy.ts)**
   - Refactor `setupTls()` / `applyTlsSecret()` / `patchIngressNginxDefaultCert()`
     / `pinHttpsNodePort()` to take the `PlatformProfile` (namespace, deployment,
     service, ports, controller kind). `generateCert(ip, domain, dir)` uses
     `*.{domain}`. No literal `ingress-nginx` strings remain.
   - `--skip-tls` and `platform === 'generic'`: skip the whole TLS block; patch
     with the profile/default base URL and print a "TLS not configured" note.
   - MicroK8s backend dispatch: Traefik (default-cert via addon re-enable or
     deployment-args fallback) vs legacy NGINX (arg patch + port pin) —
     decision 5; Secret applied to the correct namespace *before* controller
     config.
   - NodePort pin only when the controller Service type is NodePort; when
     LoadBalancer, detect the LB address for the summary URL (see risks).
   - `ensureNamespace(ns)` helper (create-if-missing, ignore already-exists).

3. **BUILD: MicroK8s preflight (addons, RBAC, storage, ingress backend)**
   - New `packages/cli/src/deploy-microk8s.ts`: `ensureMicroK8sPrereqs()`
     (CLI path vs kubectl-verification path, decision 4) and
     `configureMicroK8sDefaultCert()` (addon re-enable vs fallback patch).
   - Wire into `runDeploy()` before TLS setup, microk8s platform only; resolve
     `detectMicroK8sIngressBackend()` and use it to pick
     `DEFAULT_STORAGE_CLASS=microk8s-hostpath` + the ingress class (`public` on
     Traefik, `nginx` on legacy).

4. **BUILD: generalize manifest patching (+ web.yaml, + gitops)**
   - New `packages/cli/src/deploy-manifests.ts`:
     `patchedOperatorManifest(yaml, { baseUrl, storageClass, ingressClass })`
     (nip.io-agnostic regex; idempotent; warn-and-apply-unmodified fallback
     kept) and `patchedWebManifest(yaml, { host, ingressClass, webBaseUrl })`.
   - `deploy.ts` applies the patched web.yaml next to the patched operator.yaml
     (temp file, `finally` cleanup, same pattern as today's operator patch).
   - `gitops-manifest.ts`: `patchFluxManifest` gains optional `storageClass` /
     `ingressClass` fields (name/value-pair regexes, throw-on-drift as today);
     `applyGitopsBootstrap()` threads the computed `baseUrl`/storage/class.
   - Extend `k8s/flux/percussionist.yaml` patch block to also carry the
     `DEFAULT_STORAGE_CLASS` and `PERCUSSIONIST_INGRESS_CLASS` env entries so
     gitops mode reaches MicroK8s parity (web Ingress under gitops keeps the
     `nginx` backward-compat class until backend-aware web patching lands in
     the flux path — documented decision, see risks).

5. **BUILD: nginx cleanup sweep**
   - `packages/cli/src/deploy.ts` literals (task 2 removes them; this task
     verifies zero remain via grep) and
     `packages/cli/src/gitops-manifest.ts` docstring (line 15).
   - `scripts/minikube-load.sh` comment tidying (lines ~409-421).
   - `k8s/deploy/operator.yaml` commented examples (Traefik-aware annotations,
     microk8s base-URL comment, lines ~229-252); `k8s/deploy/web.yaml` comment
     block incl. the stale `traefik.me` reference (lines ~305-322);
     `k8s/local.example/tailnet-ingress.yaml` comment.
   - `README.md`: minikube setup paragraph, ingress-controller table, operator
     config examples (`PERCUSSIONIST_INGRESS_CLASS` + annotations) — add
     MicroK8s/Traefik variants; add a MicroK8s quickstart block
     (`microk8s enable dns rbac hostpath-storage ingress`, export kubeconfig,
     `beatctl deploy`).
   - `docs/guide/installation.md` nginx mention (line ~111) →
     controller-neutral.

6. **BUILD: docs**
   - `docs/guide/installation.md`: add a "Platforms" section — `--platform
     auto` detection, MicroK8s quickstart (Traefik path + legacy path), the new
     flags (`--domain`, `--storage-class`, `--skip-tls`, ports, `--tls-secret`).
   - `docs/reference/cli.md`: extend the `deploy` section (currently line 74)
     with the new flags and one microk8s example.
   - `docs/guide/lxd-microk8s-tailscale.md`: replace the "Do not use `beatctl
     deploy` for this topology" + manual `kubectl set env` + `standard` SC alias
     steps with `beatctl deploy --platform microk8s --skip-tls` (ingress addon
     disabled / Tailscale Serve termination); update the "Common failures" nginx
     row; keep the hostpath single-node caveat.

7. **BUILD: unit tests**
   - `packages/cli/test/deploy-platform.test.ts` (bun:test, pure-function style
     like `gitops-manifest.test.ts`): `auto` detection (context-name hits,
     StorageClass-probe hit, node-label hit, fallback to generic), profile
     resolution (minikube/microk8s/generic), `baseUrl()` / domain handling,
     backend detection with stubbed probe output.
   - `packages/cli/test/deploy-manifests.test.ts`: `patchedOperatorManifest`
     (base URL + storage class + ingress class substitution, idempotency on
     re-run, unknown-value warning path), `patchedWebManifest` (host /
     ingressClassName / WEB_BASE_URL) — both against the real checked-in
     manifests (repo-root read, same trick as `gitops-manifest.test.ts`).
   - Extend `gitops-manifest.test.ts` for the new `storageClass`/`ingressClass`
     substitutions (throw-on-drift covered).
   - `--skip-tls` flag plumbing asserted at the `DeployOpts` mapping level.
   - Gate: `pnpm typecheck && pnpm test` from repo root; `packages/cli` suite
     green.

## Acceptance criteria

- `beatctl deploy` **with no flags** works end-to-end on MicroK8s 1.35+
  (auto-detection resolves microk8s; `dns rbac hostpath-storage ingress`
  enabled when the CLI is present, verified with actionable errors when not;
  operator deployed with `DEFAULT_STORAGE_CLASS=microk8s-hostpath`,
  `PERCUSSIONIST_INGRESS_BASE_URL=https://{domain}:{https-port}`,
  `PERCUSSIONIST_INGRESS_CLASS=public`; web Ingress host + `WEB_BASE_URL`
  patched to `app.{domain}`; wildcard TLS Secret installed and wired to Traefik
  via the documented `--default-ssl-certificate` mechanism; dashboard
  reachable at the printed URL).
- MicroK8s <1.35 (legacy NGINX backend) is detected and handled with
  `ingressClass: nginx` + the arg-patch path — no manual manifest surgery.
- `ingressClassName: public` (Traefik native, documented default) is what
  MicroK8s Ingresses get on 1.35+; `nginx` is used only for legacy backends.
- Data PVCs bind on MicroK8s without a `standard` alias StorageClass.
- `beatctl deploy --platform generic` applies manifests without touching any
  ingress controller / TLS state (LXD + Tailscale topology works).
- No literal `ingress-nginx` string remains in `packages/cli/src/deploy.ts`;
  the remaining nginx references in the repo are confined to the minikube
  profile/script or clearly labeled minikube examples.
- Default behavior on minikube is unchanged (auto → minikube profile; same
  commands, same URLs, same TLS flow).
- `pnpm typecheck && pnpm test` pass; new unit tests cover detection, profile
  resolution, URL building, and both manifest-patch functions deterministically
  without a cluster.
- Docs updated (installation.md, cli.md, lxd-microk8s-tailscale.md, README.md),
  including the MicroK8s/Traefik ingress-class and quickstart material.
- The plans ConfigMap holds this revision (revision 3), not the stale revision
  1.

## Risks / open questions

- **Traefik details need live verification on a real MicroK8s 1.35+ cluster**:
  exact Deployment/Service names in the `ingress` namespace, the controller
  Service type (NodePort vs LoadBalancer/metallb) and its NodePorts, and the
  correct Traefik container-arg flag for the default certificate on the no-CLI
  path. The plan's primary TLS path is the documented addon option
  (`microk8s enable ingress --default-ssl-certificate …`); the arg-patch
  fallback is marked best-effort until verified. Backend detection must probe
  before choosing class/TLS strategy.
- **NodePort pinning may be impossible or unnecessary** on MicroK8s if the
  ingress Service is LoadBalancer; the pin step must detect Service type and
  skip gracefully, and the summary URL must use the actual detected
  port/address.
- **GitOps parity for the web Ingress** is deferred: `patchFluxManifest` will
  carry storage/ingress-class into the operator patch, but the web Ingress
  under `--gitops` keeps the backward-compat `nginx` class until backend-aware
  web patching is added to the flux manifest — documented, not silently broken
  (the class works on both backends).
- **`microk8s` CLI may not exist on the workstation** (LXD-VM topology) and may
  need `sudo` when it does; the verification-only path plus clear fatal
  messages must cover both. Never shell out to `sudo microk8s` implicitly.
- **RBAC enablement is not externally verifiable** — best-effort warning only.
- **`WEB_BASE_URL`/GitHub App coupling**: changing the domain/port changes the
  OAuth callback; docs must state that `--domain`/`--https-port` must match the
  registered callback.
- **hostpath-storage is node-local** — single-node only, not HA; docs repeat
  the caveat.
- **Auto-detection is advisory** — `--platform` always overrides, and the
  detected platform is always printed; detection never gates destructive
  actions.
- **Deterministic E2E coverage is not possible in CI** (no MicroK8s); manual
  playbook verification is the gate. Keep every testable pure function isolated
  from kubectl so unit coverage is meaningful.
