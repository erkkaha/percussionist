# Dockerfile for the percussionist memory/embedding service.
#
# The service uses the PostgreSQL Drizzle driver and pgvector; no native SQLite
# extension is required at runtime.
#
#   docker build -t percussionist/memory:dev -f images/memory/Dockerfile .

ARG NODE_VERSION=24
ARG BUN_VERSION=1.4.0

# --- deps stage ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/memory-service/package.json packages/memory-service/package.json
RUN pnpm install --frozen-lockfile --config.strict-dep-builds=false

# --- build stage --------------------------------------------------------------
FROM deps AS build
COPY packages/api/src           packages/api/src
COPY packages/api/tsconfig.json packages/api/tsconfig.json
COPY packages/memory-service/src           packages/memory-service/src
COPY packages/memory-service/migrations   packages/memory-service/migrations
COPY packages/memory-service/tsconfig.json packages/memory-service/tsconfig.json
RUN ./node_modules/.bin/tsc -p packages/api/tsconfig.json \
 && ./node_modules/.bin/tsc -p packages/memory-service/tsconfig.json

# --- runtime (Bun) ------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

WORKDIR /app

# Copy compiled output + dependencies from the build stage.
COPY --from=build /repo/node_modules                    /app/node_modules
COPY --from=build /repo/packages/api/dist               /app/packages/api/dist
COPY --from=build /repo/packages/api/package.json       /app/packages/api/package.json
COPY --from=build /repo/packages/api/node_modules       /app/packages/api/node_modules
COPY --from=build /repo/packages/memory-service/dist    /app/packages/memory-service/dist
COPY --from=build /repo/packages/memory-service/migrations /app/packages/memory-service/migrations
COPY --from=build /repo/packages/memory-service/package.json /app/packages/memory-service/package.json
COPY --from=build /repo/packages/memory-service/node_modules /app/packages/memory-service/node_modules

EXPOSE 4100
ENV MEMORY_SERVICE_PORT=4100

# Bun runs the compiled JS directly.
CMD ["bun", "/app/packages/memory-service/dist/index.js"]
