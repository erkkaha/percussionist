# percussionist runner-opencode image
#
# Serves the same runner HTTP contract as the opencode runner (port 4096), but
# backed by OpenCode 2 embedded in-process (`@opencode/sdk`) via
# packages/runner-opencode — no `opencode serve` binary.
#
# Build (from the repo root, needs the workspace as context):
#   docker build -t percussionist/runner-opencode:dev -f images/runner-opencode/Dockerfile .
#
# Drop-in for the default engine: the image installs an `opencode` shim that
# accepts the operator's default command (`opencode serve --hostname … --port …`)
# and execs the facade, so a Run can opt in with `spec.image` alone and the
# operator, dispatcher and ClusterSettings need no change. Unlike images/runner
# there is no opencode base image, no gnu_stub.so and no LD_PRELOAD: those
# existed for the Bun-FFI providers in the v1 binary.

ARG NODE_VERSION=24
ARG BUN_VERSION=1.4.0
ARG PNPM_VERSION=11.1.2

# --- deps: install the runner-opencode workspace package ---------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/runner-opencode/package.json packages/runner-opencode/package.json
# --ignore-scripts: the SDK's transitive native deps (@parcel/watcher,
# tree-sitter-*, msgpackr-extract) ship prebuilt binaries; their install
# scripts only try to build from source when those are missing, and building
# needs a toolchain this stage deliberately does not have.
RUN pnpm install --frozen-lockfile --filter @percussionist/runner-opencode \
      --ignore-scripts --config.strict-dep-builds=false

# --- build: compile TS -------------------------------------------------------
FROM deps AS build
COPY packages/runner-opencode/src            packages/runner-opencode/src
COPY packages/runner-opencode/tsconfig.json  packages/runner-opencode/tsconfig.json
RUN rm -rf packages/runner-opencode/dist \
 && pnpm --config.strict-dep-builds=false -C packages/runner-opencode run build

# --- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production

# Tooling the agent needs at runtime, mirroring images/runner minus the
# opencode-specific pieces:
#  - git, openssh-client: clone repos, push branches, SSH auth
#  - github-cli: create PRs and manage issues from Bash
#  - tini: clean PID 1 / signal forwarding
#  - tmux: optional terminal multiplexer for the debug attach path
#  - ripgrep: what the grep tool shells out to
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
  && mkdir -p /workspace /root/.ssh /root/.config/opencode \
  && chmod 700 /root/.ssh

ENV LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  LC_NUMERIC=C.UTF-8

# Bun and pnpm (via Corepack), matching images/runner: the workspace-init
# container uses this same image, so `spec.initScript` and the agents' own
# `pnpm install` / `bun test` must work here too.
ARG BUN_VERSION
ARG PNPM_VERSION
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && npm install -g corepack \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && bun --version \
  && pnpm --version

WORKDIR /app
COPY --from=build /repo/node_modules                            /app/node_modules
COPY --from=build /repo/packages/runner-opencode/dist           /app/packages/runner-opencode/dist
COPY --from=build /repo/packages/runner-opencode/package.json   /app/packages/runner-opencode/package.json
COPY --from=build /repo/packages/runner-opencode/node_modules   /app/packages/runner-opencode/node_modules

# `opencode` shim. pod-builder's default runner command is
# `opencode serve --hostname 0.0.0.0 --port <port>`; honour exactly that and
# refuse anything else loudly, so a misuse shows up as a failed exec rather than
# a silently different runtime.
COPY images/runner-opencode/opencode /usr/local/bin/opencode
RUN chmod +x /usr/local/bin/opencode

# Small diagnostics helper, matching images/runner's runner-doctor.
RUN cat > /usr/local/bin/runner-doctor <<'EOF2'
#!/bin/sh
set -eu
missing=0
for cmd in node npm pnpm bun bash curl git gh rg tmux opencode; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd: $("$cmd" --version 2>/dev/null | head -n 1 || echo present)"
  else
    echo "missing: $cmd" >&2
    missing=1
  fi
done
echo "auth blob present: ${OPENCODE_AUTH_CONTENT:+yes}"
echo "config blob present: ${OPENCODE_CONFIG_CONTENT:+yes}"
exit "$missing"
EOF2
RUN chmod +x /usr/local/bin/runner-doctor

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/packages/runner-opencode/dist/index.js"]
