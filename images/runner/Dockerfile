# percussionist runner image
# Extends the official opencode image with tooling required to run agents
# inside a Kubernetes pod: git, ssh, and a workspace directory.
#
# Build:
#   docker build -t percussionist/runner:dev images/runner
#
# Override the base runner image (e.g. for a custom LLM runtime):
#   docker build --build-arg RUNNER_BASE=myregistry/my-runner:v1 -t percussionist/runner:dev images/runner
#
# For k3s (no registry), import directly:
#   docker save percussionist/runner:dev | sudo k3s ctr images import -

ARG RUNNER_BASE=ghcr.io/anomalyco/opencode:1.17.9
FROM ${RUNNER_BASE}

ARG BUN_VERSION=1.3.14
ARG PNPM_VERSION=11.1.2

# Pin locale-related env for deterministic number/date formatting in tests
# and agent runs (avoid host-dependent snapshot drift).
ENV LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  LC_NUMERIC=C.UTF-8

# Tools the agent will need at runtime.
#  - git, openssh-client: clone repos, push branches, SSH auth
#  - ca-certificates: HTTPS to LLM providers and git hosts
#  - tini: clean PID 1 / signal forwarding for the tmux wrapper
#  - tmux: persistent PTY for the opencode TUI; enables concurrent
#          CLI + web attach via `tmux attach`
#  - nodejs, npm: agents that need node/npm at runtime (24.x from Alpine repos)
#  - bash, curl, unzip: required by common repo scripts and runtime installers
#  - github-cli: create PRs, manage issues from the CLI
#  - gcompat: glibc ABI compatibility layer so glibc-linked .so files in the
#             opencode binary (bun FFI) can load on musl/Alpine
#  - gcc + musl-dev: compile the gnu_stub.so (removed after build)
#  - icu-data-full: full ICU locale data so Intl number/date formatting supports
#                   non-English locales (e.g. fi-FI decimal comma)
RUN apk add --no-cache \
  git \
  openssh-client \
  ca-certificates \
  tini \
  tmux \
  nodejs \
  npm \
  bash \
  curl \
  unzip \
  github-cli \
  ripgrep \
  icu-data-full \
  gcompat \
  gcc \
  musl-dev \
  && mkdir -p /workspace /root/.ssh \
  && chmod 700 /root/.ssh

# Compile and install the glibc symbol stub, then remove the compiler.
# gnu_get_libc_version is referenced by glibc-linked .so files that Bun FFI
# extracts at runtime for certain providers (e.g. lmstudio).  gcompat does
# not expose this symbol; the stub satisfies the dynamic linker.
COPY gnu_stub.c /tmp/gnu_stub.c
RUN gcc -shared -fPIC -o /usr/local/lib/libgnustub.so /tmp/gnu_stub.c \
  && rm /tmp/gnu_stub.c \
  && apk del gcc musl-dev

# Preload the stub so every dlopen() call in the process can resolve the symbol.
ENV LD_PRELOAD=/usr/local/lib/libgnustub.so

# Install Bun and pnpm (via Corepack) so workspace agents can run test/build
# workflows in modern monorepos without ad-hoc bootstrapping.
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && npm install -g corepack \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate

# Small diagnostics helper for fast runtime preflight checks in agent sessions.
RUN cat > /usr/local/bin/runner-doctor <<'EOF'
#!/bin/sh
set -eu

check_cmd() {
  cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing: $cmd" >&2
    return 1
  fi
  version="$($cmd --version 2>/dev/null | head -n 1 || true)"
  if [ -n "$version" ]; then
    echo "$cmd: $version"
  else
    echo "$cmd: present"
  fi
}

check_cmd node
check_cmd npm
check_cmd pnpm
check_cmd bun
check_cmd bash
check_cmd curl
check_cmd git
check_cmd gh
EOF
RUN chmod +x /usr/local/bin/runner-doctor

# Cluster-wide OpenCode agents and skills. Empty by default; populate
# content/agents/<name>.md and content/skills/<name>/SKILL.md to ship them
# in every run pod. Per-repo overrides via <workspace>/.opencode/ still work.
# See content/README.md for details.
COPY content/ /root/.config/opencode/

WORKDIR /workspace

# The opencode HTTP API is available on 0.0.0.0:4096 (overridable via
# OPENCODE_PORT). The wrapper script runs `opencode serve` (headless
# HTTP API server, same API as `opencode web` but without the web UI).
# Interactive attach is a shell (via `beatctl attach` or the web dashboard
# Terminal tab); run `opencode attach http://127.0.0.1:<port>` from the
# shell to open the opencode TUI.
EXPOSE 4096

# Default tmux config — mouse on, 256-color, large scrollback.
COPY .tmux.conf /root/.tmux.conf

# Wrapper script: runs `opencode serve` (headless HTTP API server).
COPY opencode-tmux.sh /usr/local/bin/opencode-tmux.sh
RUN chmod +x /usr/local/bin/opencode-tmux.sh

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/opencode-tmux.sh"]
