# Security

Percussionist's security model spans authentication, authorization, network isolation, and secure defaults.

## Authentication & Authorization

Every `/api/*` route requires authentication. There are two kinds of caller and
they are deliberately not interchangeable — see
[SECURITY.md](https://github.com/erkkaha/percussionist/blob/main/SECURITY.md) for
the full model.

### Humans — GitHub sign-in

The dashboard uses [better-auth](https://www.better-auth.com) with GitHub as the
only identity provider, and issues an httpOnly session cookie. There is no
password and no SMTP. Only the GitHub logins on the allowlist may sign in; the
OAuth callback is otherwise open to every GitHub account on the internet.

```bash
beatctl auth github set-app <client-id> <client-secret>
beatctl auth github allow <your-github-login>
beatctl auth session-secret
```

The allowlist is checked on **every** sign-in, not only when the account is first
created, so removing a login blocks their next attempt.

The session cookie also authorizes SSE streams and the terminal WebSocket, so no
credential appears in a URL.

### Agents — scoped API keys

Agents hold API keys limited to a small permission set. A key is accepted *only*
on routes marked with the `scoped()` middleware, so it can never read settings,
manage secrets, delete projects or apply an upgrade — those require a session.

| Holder | Scopes | Lifetime |
|--------|--------|----------|
| Run pods (dispatcher) | `stats:write` | Per run; expires after the run's timeout and is revoked when it ends |
| manager-controller | `stats:write`, `events:write`, `board:read` | Standing (`manager-api-key`) |
| operator | `runkeys:mint` | Standing (`operator-api-key`) |

Standing keys are minted by the web server on startup — it is the only component
with database access — and written to per-component Secrets. Inspect and rotate
them with `beatctl auth key list` and `beatctl auth key rotate <component>`;
rotation requires restarting that Deployment, since values resolve via
`secretKeyRef` at pod start.

### CLI

`beatctl auth login` uses the OAuth 2.0 device grant (RFC 8628): it prints a code
you approve in an already-signed-in browser, then holds a real session. No token
is pasted between the two.

### Manager MCP Server

The manager's MCP server (port 4097) is cluster-internal. Cross-pod callers must
present `MCP_TOKEN` (the `manager-mcp-token` Secret), shared with the web pod only
and never injected into a run pod — so an agent reading its own environment cannot
reach the destructive tools. A NetworkPolicy restricts pod-network access to the
port as defence in depth, but requires a CNI that enforces NetworkPolicy.

Same-pod callers on `127.0.0.1` are exempt from the token. That is not a boundary
against anyone with cluster access: `kubectl port-forward` traffic arrives on the
pod's loopback interface, which is how `beatctl chat` connects.

### Escape hatches

- `AUTH_DISABLED=1` skips all authentication — for local development and the e2e
  harness. No auth machinery is initialised at all in this mode. Toggle with
  `beatctl auth web-token disable` / `enable`; this is also the way back in if
  GitHub sign-in ever misbehaves.
- `LEGACY_TOKEN_AUTH=1` additionally accepts a pre-better-auth shared secret in
  `AUTH_SECRET`, so a rolling upgrade does not break agents mid-flight. Remove it
  once every component holds a key.

The dashboard Ingress is plain HTTP by default, so the session cookie cannot be
marked `Secure`. Terminate TLS in front of it for anything reachable beyond a
trusted network.

## Secure Defaults

### SSH Host Key Verification

Runner pods that use git over SSH default to no host key verification (backward compatible default). Three modes are available:

| Mode | Behavior |
|------|----------|
| `strict` | Full host key verification against known_hosts; reject unknown hosts |
| `accept-new` | Accept and cache unknown host keys on first connect; reject changed keys |
| `no` (default) | No verification (equivalent to `StrictHostKeyChecking=no`); not recommended for production |

## Data Protection

### Secrets

Sensitive data is stored in Kubernetes Secrets:
- `web-auth` — Web API token
- Provider API keys — Stored as Secrets, mounted as environment variables

### ConfigMaps

Non-sensitive configuration is stored in ConfigMaps. Session data is truncated to fit ConfigMap size limits. Finding snippets (submitted via `report_unrelated_issue`) are capped at 2048 characters and stored in `{project}-findings` ConfigMaps — they are not encrypted at rest.

## Network Topology

```
┌─────────────────────────────────────────┐
│  Cluster                                 │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │ Web Pod  │  │ Manager  │             │
│  │ :8080    │  │ :4097 ◄── MCP (internal)│
│  │          │  │ :4098    │             │
│  └────┬─────┘  └──────────┘             │
│       │                                  │
│  ┌────▼─────────────────────────────┐   │
│  │  Ingress                         │   │
│  │  (HTTPS only)                    │   │
│  └──────────────────────────────────┘   │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │ Runner   │  │ Memory   │             │
│  │ :4097    │  │ :4100    │             │
│  │ (MCP)    │  │ (REST)   │             │
│  └──────────┘  └──────────┘             │
│                                          │
│  ┌──────────┐                            │
│  │ Ollama   │                            │
│  │ :11434   │                            │
│  └──────────┘                            │
└─────────────────────────────────────────┘
```

### Recommended NetworkPolicies

- Allow ingress to web pod only from ingress controller
- Allow runner pods to reach manager MCP server
- Allow manager to reach memory service pods
- Deny all other inter-pod traffic by default

## Known Considerations

| Item | Status |
|------|--------|
| MCP server has no auth layer | Cluster-internal access only |
| Web auth is optional | Enable in production |
| Manager is single-replica | No leader election race conditions |
| Session data in ConfigMaps | Truncated to fit; not encrypted at rest |
| Finding snippets in ConfigMaps | Capped at 2048 chars; not encrypted at rest |
