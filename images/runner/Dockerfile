# percussionist runner image
# Extends the official opencode image with tooling required to run agents
# inside a Kubernetes pod: git, ssh, and a workspace directory.
#
# Build:
#   docker build -t percussionist/runner:dev images/runner
#
# For k3s (no registry), import directly:
#   docker save percussionist/runner:dev | sudo k3s ctr images import -

FROM ghcr.io/anomalyco/opencode:latest

# Pin locale-related env for deterministic number/date formatting in tests
# and agent runs (avoid host-dependent snapshot drift).
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    LC_NUMERIC=C.UTF-8

# Tools the agent will need at runtime.
#  - git, openssh-client: clone repos, push branches, SSH auth
#  - ca-certificates: HTTPS to LLM providers and git hosts
#  - tini: clean PID 1 / signal forwarding for `opencode web`
#  - nodejs, npm: agents that need node/npm at runtime (24.x from Alpine repos)
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
      nodejs \
      npm \
      github-cli \
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

# Cluster-wide OpenCode agents and skills. Empty by default; populate
# content/agents/<name>.md and content/skills/<name>/SKILL.md to ship them
# in every run pod. Per-repo overrides via <workspace>/.opencode/ still work.
# See content/README.md for details.
COPY content/ /root/.config/opencode/

WORKDIR /workspace

# Default opencode web listens on 127.0.0.1:4096 which is unreachable from
# outside the pod. The manifest overrides the command with explicit
# --hostname 0.0.0.0, but we expose the port here for documentation.
EXPOSE 4096

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["opencode", "web", "--hostname", "0.0.0.0", "--port", "4096"]
