# Load-test homeserver image: the sources run directly (type stripping), with the locked
# dependencies and pg, the optional Postgres driver.
FROM node:26.12.0-slim
WORKDIR /app
# Built from the repository root (a workspace; see complement/Dockerfile).
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
RUN npm ci --ignore-scripts --no-audit --no-fund -w @katrix/server && npm install --no-save --ignore-scripts --no-audit --no-fund pg@8
COPY packages/server/src ./packages/server/src
COPY packages/server/loadtest/server.ts ./packages/server/loadtest/server.ts
# The sources run directly: #-imports resolve to src/ under this condition (package.json "imports").
ENV NODE_OPTIONS=--conditions=matrix-src
EXPOSE 8008
CMD ["node", "packages/server/loadtest/server.ts"]
