#!/bin/sh
# Authenticate gh CLI, then start opencode web.
# If GITHUB_TOKEN is set (injected by the operator from a githubTokenSecret),
# use it. Otherwise fall back to SSH-based auth (which typically no-ops in
# cluster pods without a forwarded agent, but is kept for local dev convenience).
if [ -n "$GITHUB_TOKEN" ]; then
  # With GH_TOKEN/GITHUB_TOKEN set, gh uses env-token auth automatically.
  # Avoid interactive login to keep entrypoint non-blocking in run pods.
  gh auth status >/dev/null 2>&1 || true
else
  gh auth login --git-protocol ssh 2>/dev/null || true
fi
exec "$@"
