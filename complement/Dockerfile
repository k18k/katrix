FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY complement ./complement

ENV SERVER_NAME=localhost
# Set to 1 to print debug logs (shown by Complement on test failure).
ENV MATRIX_DEBUG=
EXPOSE 8008 8448

HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=30 \
  CMD node -e "fetch('http://localhost:8008/_matrix/client/versions').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/app/complement/entrypoint.sh"]
