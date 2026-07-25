# CLI Reference (beatctl)

`beatctl` is the Percussionist command-line interface. It talks directly to the Kubernetes API.

## Run Commands

### submit

Create a new Run (ad-hoc, outside the board workflow).

```bash
beatctl submit --project <name> [--task "<prompt>"] [--agent <name>] [--model <name>]
beatctl submit -f run.yaml
beatctl submit --interactive                  # no prompt; keep runner alive for attach
```

### ls

List Runs in a namespace.

```bash
beatctl ls [-n <namespace>]
beatctl list                                   # alias
```

### get

Show details for a single Run.

```bash
beatctl get <run-name> [-o yaml|json]
```

### attach

Port-forward to a run and launch `opencode attach`.

```bash
beatctl attach <run-name> [--continue]
```

### logs

Stream logs from a run's pod.

```bash
beatctl logs <run-name> [--container opencode] [--tail <lines>] [--follow]
```

### wait

Block until a run reaches a terminal phase (exit 0 on Succeeded).

```bash
beatctl wait <run-name> [--timeout <seconds>] [--for <phase>]
```

### cancel

Delete a run (cascades to its pod/service/secret).

```bash
beatctl cancel <run-name>
```

### chat

Interactive chat with the manager agent.

```bash
beatctl chat [--namespace <ns>]
```

### deploy

Install or remove Percussionist CRDs and deployments.

```bash
beatctl deploy                                # install
beatctl deploy --down                         # remove
```

### web

Open the dashboard in your browser via localhost port-forward.

```bash
beatctl web [--port <port>] [--no-browser]
```

## Management Commands

### project

Manage Project templates (reusable run defaults).

```bash
beatctl project list                          # list all projects
beatctl project get <name>                    # show project spec
beatctl project create --name <name> ...      # create a project
beatctl project delete <name>                 # delete a project
```

### agent

Manage ClusterAgent resources.

```bash
beatctl agent list
beatctl agent get <name> [-o yaml|json]
beatctl agent create --name <name> -f agent.md
beatctl agent delete <name>
```

### board

Manage the kanban board embedded in a Project.

```bash
beatctl board get <project>                   # show board state
beatctl board task add <project> --title "..." --agent <name>
beatctl board task move <project> --task-name <name> --to <column>
beatctl board task remove <project> --task-name <name>
```

### auth

Manage OpenCode provider credentials, dashboard sign-in, and agent API keys.

```bash
beatctl auth import                           # copy auth.json to cluster Secret
```

Signing in. The CLI uses the OAuth 2.0 device grant: it prints a code, you
approve it in an already-signed-in browser, and the CLI receives a session.

```bash
beatctl auth login                            # device-code sign-in
beatctl auth login --no-browser                # print the URL instead of opening it
beatctl auth whoami                           # show the signed-in identity
beatctl auth logout                           # discard the local session
```

Dashboard sign-in is GitHub-only. Register a GitHub App with callback
`http://<your-host>/api/auth/callback/github` (add
`http://127.0.0.1/api/auth/callback/github` as well so `beatctl web`'s
port-forward works — GitHub exempts loopback from port matching), and enable
Account Permissions → Email Addresses → Read-Only.

```bash
beatctl auth github set-app <clientId> <clientSecret>
beatctl auth github allow <login...>          # replace the sign-in allowlist
beatctl auth session-secret                   # rotate session signing secret
beatctl auth mcp-token                        # rotate the manager MCP token
```

Agent API keys. Each agent holds a key scoped to what it actually needs; run pods
get a `stats:write` key that expires with the run.

```bash
beatctl auth key list                         # scopes, usage, expiry
beatctl auth key rotate operator              # re-mint a standing component key
beatctl auth key rotate manager
```

Legacy shared-token commands, kept for the migration window (see SECURITY.md §1):

```bash
beatctl auth web-token show                   # print the legacy shared token
beatctl auth web-token set <token>            # set it
beatctl auth web-token rotate                 # generate a random one
beatctl auth web-token disable                # bypass auth entirely (dev)
beatctl auth web-token enable                 # enforce auth
```

### ssh-key

Manage SSH key Secrets for private git repos.

```bash
beatctl ssh-key create [--key ~/.ssh/id_ed25519]
```

### github-token

Manage GitHub token Secrets for gh CLI auth in runners.

```bash
beatctl github-token create [--token <token>]
```

## Global Flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--namespace` | `-n` | Override namespace (default: `percussionist`) |
| `--output` | `-o` | Output format (`yaml`, `json`) |
