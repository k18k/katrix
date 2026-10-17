# The public server. Built from the repository root (npm workspaces share one lockfile):
#   docker build -f apps/public/Dockerfile .
FROM node:26.12.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
RUN npm ci --ignore-scripts --no-audit --no-fund -w matrix-nodejs-homeserver
COPY packages/core/tsconfig.json packages/core/tsdown.config.ts ./packages/core/
COPY packages/core/src ./packages/core/src
RUN npm run build -w matrix-nodejs-homeserver

FROM node:26.12.0-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
# Runtime dependencies only (pg); the library itself has none (zod is bundled into dist/).
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev -w @matrix-nodejs-homeserver/public \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY apps/public/src ./apps/public/src
USER node
ENV DATA_DIR=/data PORT=8008
EXPOSE 8008
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:8008/_matrix/client/versions').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/public/src/main.ts"]
