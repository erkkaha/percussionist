# percussionist manager controller image
#
# Build:
#   docker build -t percussionist/manager:dev images/manager
#
# For k3s (no registry), import directly:
#   docker save percussionist/manager:dev | sudo k3s ctr images import -

FROM node:24-alpine AS builder

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/
COPY packages/kube/package.json packages/kube/tsconfig.json ./packages/kube/
COPY packages/manager-controller/package.json packages/manager-controller/tsconfig.json ./packages/manager-controller/

RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

COPY packages/api/src/ packages/api/src/
COPY packages/kube/src/ packages/kube/src/
COPY packages/manager-controller/src/ packages/manager-controller/src/

RUN cd packages/api && pnpm build
RUN cd packages/kube && pnpm build
RUN cd packages/manager-controller && pnpm build

FROM node:24-alpine

WORKDIR /app

# Copy only the built manager controller + its dependencies
COPY --from=builder /app/packages/manager-controller/dist ./packages/manager-controller/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/kube/dist ./packages/kube/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=builder /app/packages/kube/node_modules ./packages/kube/node_modules
COPY --from=builder /app/packages/manager-controller/node_modules ./packages/manager-controller/node_modules

# Copy package.json files for workspace dependency resolution (symlinks need them)
COPY --from=builder /app/packages/api/package.json ./packages/api/package.json
COPY --from=builder /app/packages/kube/package.json ./packages/kube/package.json

# Copy pnpm store for workspace dependencies resolution
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm

ENV NODE_ENV=production

CMD ["node", "packages/manager-controller/dist/index.js"]
