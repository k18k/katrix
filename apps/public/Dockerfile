# The public server. Built from the repository root (npm workspaces share one lockfile):
#   docker build -f apps/public/Dockerfile .
FROM node:26.12.0-slim AS build
WORKDIR /app
# Every workspace's manifest, so npm ci sees all the workspaces the lockfile lists.
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
# --include-workspace-root: the build needs the shared tools of the root (typescript, @types/node).
RUN npm ci --ignore-scripts --no-audit --no-fund -w @katrix/server --include-workspace-root
# Fix (https://github.com/k18k/katrix/issues/113): the build is tsc with tsconfig.build.json; the
# tsdown config this copied was gone, and the image failed to build.
COPY packages/server/tsconfig.json packages/server/tsconfig.build.json ./packages/server/
COPY packages/server/src ./packages/server/src
RUN npm run build -w @katrix/server

FROM node:26.12.0-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
# Runtime dependencies only (pg); the library itself has none.
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev -w @katrix/public \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY apps/public/src ./apps/public/src
USER node
ENV DATA_DIR=/data PORT=8008
EXPOSE 8008
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:8008/_matrix/client/versions').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/public/src/main.ts"]
