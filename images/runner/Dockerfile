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

# Tools the agent will need at runtime.
#  - git, openssh-client: clone repos, push branches, SSH auth
#  - ca-certificates: HTTPS to LLM providers and git hosts
#  - tini: clean PID 1 / signal forwarding for `opencode serve`
RUN apk add --no-cache \
      git \
      openssh-client \
      ca-certificates \
      tini \
    && mkdir -p /workspace /root/.ssh \
    && chmod 700 /root/.ssh

# Cluster-wide OpenCode agents and skills. Empty by default; populate
# content/agents/<name>.md and content/skills/<name>/SKILL.md to ship them
# in every run pod. Per-repo overrides via <workspace>/.opencode/ still work.
# See content/README.md for details.
COPY content/ /root/.config/opencode/

WORKDIR /workspace

# Default opencode serve listens on 127.0.0.1:4096 which is unreachable from
# outside the pod. The manifest overrides the command with explicit
# --hostname 0.0.0.0, but we expose the port here for documentation.
EXPOSE 4096

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
