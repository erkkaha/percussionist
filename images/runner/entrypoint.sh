#!/bin/sh
# Authenticate gh CLI, then start opencode web.
# If GITHUB_TOKEN is set (injected by the operator from a githubTokenSecret),
# use it. Otherwise fall back to SSH-based auth (which typically no-ops in
# cluster pods without a forwarded agent, but is kept for local dev convenience).
if [ -n "$GITHUB_TOKEN" ]; then
  printf '%s' "$GITHUB_TOKEN" | gh auth login --with-token
else
  gh auth login --git-protocol ssh 2>/dev/null || true
fi
exec "$@"
