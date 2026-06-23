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

Manage OpenCode provider credentials.

```bash
beatctl auth import                           # copy auth.json to cluster Secret
beatctl auth web-token show                   # print web UI auth token
beatctl auth web-token set <token>            # set web UI token
beatctl auth web-token rotate                 # generate random token
beatctl auth web-token disable                # bypass auth
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
