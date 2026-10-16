FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# https://github.com/k18k/matrix-nodejs-homeserver/issues/18: the image had no node_modules, so the
# server could not import zod and never started; every Complement run then hung until the job
# timeout. It installs the locked dependencies (before copying src/, so the layer stays cached);
# --ignore-scripts skips `prepare`, which would build dist/ that the tests do not use.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY complement ./complement

ENV SERVER_NAME=localhost
# Set to 1 to print debug logs (shown by Complement on test failure).
ENV MATRIX_DEBUG=
EXPOSE 8008 8448

HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=30 \
  CMD node -e "fetch('http://localhost:8008/_matrix/client/versions').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/app/complement/entrypoint.sh"]
