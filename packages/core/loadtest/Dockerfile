# Load-test homeserver image: the sources run directly (type stripping), with the locked
# dependencies and pg, the optional Postgres driver.
FROM node:26.12.0-slim
WORKDIR /app
# Built from the repository root (a workspace; see complement/Dockerfile).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
COPY packages/auditbot/package.json ./packages/auditbot/
RUN npm ci --ignore-scripts --no-audit --no-fund -w matrix-nodejs-homeserver && npm install --no-save --ignore-scripts --no-audit --no-fund pg@8
COPY packages/core/src ./packages/core/src
COPY packages/core/loadtest/server.ts ./packages/core/loadtest/server.ts
EXPOSE 8008
CMD ["node", "packages/core/loadtest/server.ts"]
