# Load-test homeserver image: the sources run directly (type stripping), with the locked
# dependencies and pg, the optional Postgres driver.
FROM node:26.12.0-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm install --no-save --no-audit --no-fund pg@8
COPY src ./src
COPY loadtest/server.ts ./loadtest/server.ts
EXPOSE 8008
CMD ["node", "loadtest/server.ts"]
