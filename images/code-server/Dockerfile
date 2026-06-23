# percussionist code-server image
#
# Extends the upstream code-server with tools needed for interactive
# workspace access: bun, pnpm, ripgrep, jq.
#
# Build:
#   docker build -t percussionist/code-server:dev images/code-server

FROM codercom/code-server:4.96.4

USER root

# Install system tools, bun, and pnpm
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        ripgrep \
        jq \
    && rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | bash && \
    npm install -g pnpm

# Ensure bun is on PATH for non-login shells
ENV PATH="/root/.bun/bin:${PATH}"

# Switch back to the default code-server user
USER 1000
