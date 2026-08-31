# percussionist runner-claude image
#
# Serves the same runner HTTP contract as the opencode runner (port 4096), but
# backed by the Claude Agent SDK via packages/runner-claude.
#
# Build (from the repo root, needs the workspace as context):
#   docker build -t percussionist/runner-claude:dev -f images/runner-claude/Dockerfile .
#
# Unlike images/runner, this image needs no opencode base, no gnu_stub.so and no
# LD_PRELOAD: those exist to satisfy glibc symbols for opencode's Bun FFI
# providers, and nothing here uses Bun FFI.

ARG NODE_VERSION=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=11.1.2

# --- deps: install the runner-claude workspace package -----------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/runner-claude/package.json packages/runner-claude/package.json
RUN pnpm install --frozen-lockfile --filter @percussionist/runner-claude \
      --config.strict-dep-builds=false

# --- build: compile TS -------------------------------------------------------
FROM deps AS build
COPY packages/runner-claude/src            packages/runner-claude/src
COPY packages/runner-claude/tsconfig.json  packages/runner-claude/tsconfig.json
RUN rm -rf packages/runner-claude/dist \
 && pnpm --config.strict-dep-builds=false -C packages/runner-claude run build

# --- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production

# Tooling the agent needs at runtime, mirroring images/runner minus the
# opencode-specific pieces:
#  - git, openssh-client: clone repos, push branches, SSH auth
#  - github-cli: create PRs and manage issues from Bash
#  - tini: clean PID 1 / signal forwarding
#  - tmux: optional terminal multiplexer for the debug attach path
#  - ripgrep: what the Grep tool shells out to
#  - bash, curl, unzip: required by common repo scripts
#  - icu-data-full: full ICU locale data so Intl formatting matches the host
RUN apk add --no-cache \
  git \
  openssh-client \
  ca-certificates \
  tini \
  tmux \
  bash \
  curl \
  unzip \
  github-cli \
  ripgrep \
  icu-data-full \
  libc6-compat \
  && mkdir -p /workspace /root/.ssh /root/.claude \
  && chmod 700 /root/.ssh

ENV LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  LC_NUMERIC=C.UTF-8

# Install Bun and pnpm (via Corepack), matching images/runner. Only the deps and
# build stages had pnpm, and both are discarded — so agents and, crucially,
# `spec.initScript` ran with node/npm alone.
#
# initScript is evaluated in the workspace-init container, which uses this same
# image (pod-builder.ts resolves it from the run's engine). percussionist-dev's
# script pre-warms the pnpm store and ends in `|| echo "pnpm install skipped"`,
# so on the claude engine it logged "skipped" forever and warmed nothing. Agents
# fared worse: a builder on this repo could run neither `pnpm typecheck` nor any
# bun test, and resorted to committing with --no-verify.
ARG BUN_VERSION
ARG PNPM_VERSION
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && npm install -g corepack \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && bun --version \
  && pnpm --version

# Install the Claude Code CLI explicitly and point the SDK at it.
#
# The Agent SDK ships a bundled binary in an *optional* per-platform package.
# When that tarball fails to download, pnpm leaves a dangling symlink, install
# still reports success, and the failure only surfaces as "Native CLI binary
# for linux-x64 not found" at the first query — i.e. as a broken run rather
# than a broken build. Installing the CLI directly makes the dependency
# explicit and pins its version where it can be seen.
ARG CLAUDE_CODE_VERSION=2.1.241
RUN npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && claude --version
ENV CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude

# Claude Code refuses --dangerously-skip-permissions (what permissionMode
# 'bypassPermissions' maps to) when running as root, and run pods do run as
# root: the workspace-init container clones the repo as root, so a non-root
# runner could not modify the checked-out files.
#
# IS_SANDBOX is the supported escape hatch for exactly this case, and the claim
# is true here — the run pod drops ALL capabilities, forbids privilege
# escalation, and is confined by the cluster network policy. Without it the run
# fails at the first query with "cannot be used with root/sudo privileges".
ENV IS_SANDBOX=1

WORKDIR /app
COPY --from=build /repo/node_modules                          /app/node_modules
COPY --from=build /repo/packages/runner-claude/dist           /app/packages/runner-claude/dist
COPY --from=build /repo/packages/runner-claude/package.json   /app/packages/runner-claude/package.json
COPY --from=build /repo/packages/runner-claude/node_modules   /app/packages/runner-claude/node_modules

# Small diagnostics helper, matching images/runner's runner-doctor.
#
# pnpm and bun are listed deliberately: they were absent from the image for as
# long as they were absent from this list, and nothing reported it. A tool the
# doctor does not name is a tool whose absence surfaces as a failing agent run.
RUN cat > /usr/local/bin/runner-doctor <<'EOF'
#!/bin/sh
set -eu
missing=0
for cmd in node npm pnpm bun claude bash curl git gh rg tmux; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd: $("$cmd" --version 2>/dev/null | head -n 1 || echo present)"
  else
    echo "missing: $cmd" >&2
    missing=1
  fi
done
echo "token present: ${CLAUDE_CODE_OAUTH_TOKEN:+yes}"
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes — WARNING, this overrides subscription auth}"
exit "$missing"
EOF
RUN chmod +x /usr/local/bin/runner-doctor

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/packages/runner-claude/dist/index.js"]
