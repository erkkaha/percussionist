# percussionist code-server image
#
# Extends the upstream code-server with tools needed for interactive
# workspace access: bun, pnpm, nodejs, npm, ripgrep, jq.
#
# Build:
#   docker build -t percussionist/code-server:dev images/code-server

FROM codercom/code-server:4.96.4

USER root

# Install system tools and bun
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        curl \
        unzip \
        libatomic1 \
        nodejs \
        npm \
        ripgrep \
        jq \
    && rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install pnpm standalone binary (bundles its own Node.js runtime).
# Using the self-contained @pnpm/exe binary to avoid version conflicts
# with the Debian-packaged Node.js.
RUN npm install -g @pnpm/exe@9.15.4 --ignore-engines

# Switch back to the default code-server user
USER 1000
