# The development identity provider (local compose only). Built from the repository root:
#   docker build -f apps/dev-idp/Dockerfile .
FROM node:26.12.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/public/package.json ./apps/public/
COPY apps/dev-idp/package.json ./apps/dev-idp/
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev -w @matrix-nodejs-homeserver/dev-idp
COPY apps/dev-idp/src ./apps/dev-idp/src
USER node
EXPOSE 3001
CMD ["node", "apps/dev-idp/src/main.ts"]
