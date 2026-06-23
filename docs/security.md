# Security

Percussionist's security model spans authentication, authorization, network isolation, and secure defaults.

## Authentication & Authorization

### Web API

The web dashboard API is secured with token-based authentication:

```bash
kubectl create secret generic web-auth -n percussionist \
  --from-literal=token=<your-secure-token>
```

If the `web-auth` secret is absent, authentication is disabled.

### Manager MCP Server

The manager's MCP server (port 4097) is cluster-internal only. No external authentication layer is needed — it relies on Kubernetes network policy for access control.

### Admin Routes

Certain web API routes require admin privileges, enforced via `adminAuth()` middleware.

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

Non-sensitive configuration is stored in ConfigMaps. Session data is truncated to fit ConfigMap size limits. Finding snippets (submitted via `report_finding`) are capped at 2048 characters and stored in `{project}-findings` ConfigMaps — they are not encrypted at rest.

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
