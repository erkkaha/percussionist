# Required Secrets for Self-Development

The `percussionist-dev` project requires these secrets in the `percussionist` namespace.

## 1. Git SSH Key

Used by agents to push branches to GitHub.

```bash
# Generate a dedicated key for agents
ssh-keygen -t ed25519 -C "agent@percussionist.dev" -f ~/.ssh/percussionist_agent -N ""

# Print the public key — add this to GitHub
cat ~/.ssh/percussionist_agent.pub
```

Add the public key as a Deploy Key with **write access**:
https://github.com/erkkaha/percussionist/settings/keys/new

Then create the K8s secret:
```bash
kubectl create secret generic git-ssh-key \
  --type=kubernetes.io/ssh-auth \
  --from-file=ssh-privatekey=$HOME/.ssh/percussionist_agent \
  -n percussionist
```

## 2. GitHub Token

Used by agents for `gh` CLI operations (creating PRs, checking CI status).

Create a token at https://github.com/settings/tokens/new with scopes: `repo`, `workflow`.

```bash
beatctl github-token create --token ghp_xxxxx -n percussionist
# Creates secret named: git-github-token
```

## 3. LLM Provider Auth

```bash
# Already done for the main cluster — verify it exists
kubectl get secret opencode-auth -n percussionist
```

If missing:
```bash
opencode auth login github-copilot
beatctl auth import
```

## Verify All Secrets

```bash
kubectl get secrets -n percussionist \
  | grep -E 'git-ssh-key|git-github-token|opencode-auth'
```

Expected output:
```
git-github-token   Opaque   1      ...
git-ssh-key        kubernetes.io/ssh-auth   1   ...
opencode-auth      Opaque   1      ...
```
