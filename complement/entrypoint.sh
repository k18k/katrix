#!/bin/sh
# Complement may run this entrypoint several times against the same container.
set -e
mkdir -p /data/tls
if [ -f /complement/ca/ca.crt ] && [ ! -f /data/tls/server.crt ]; then
  cp /complement/ca/ca.crt /usr/local/share/ca-certificates/complement.crt
  update-ca-certificates >/dev/null 2>&1 || true
  openssl genrsa -out /data/tls/server.key 2048 2>/dev/null
  openssl req -new -sha256 -key /data/tls/server.key -subj "/CN=${SERVER_NAME}" \
    -addext "subjectAltName=DNS:${SERVER_NAME}" -out /data/tls/server.csr
  printf "subjectAltName=DNS:%s\n" "${SERVER_NAME}" > /data/tls/ext.cnf
  openssl x509 -req -in /data/tls/server.csr -CA /complement/ca/ca.crt -CAkey /complement/ca/ca.key \
    -CAcreateserial -out /data/tls/server.crt -days 1 -sha256 -extfile /data/tls/ext.cnf 2>/dev/null
fi
# When Complement itself runs in a container on the Docker host's network (scripts/complement.sh),
# it is reachable at this container's gateway, which host-gateway does not always point to
# (Docker Desktop maps it to the desktop machine).
if [ "$COMPLEMENT_HOST_VIA_GATEWAY" = "1" ]; then
  gateway=$(node -e '
    const row = require("fs").readFileSync("/proc/net/route", "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[1] === "00000000");
    if (row) console.log(Buffer.from(row[2], "hex").reverse().join("."));')
  if [ -n "$gateway" ]; then
    { grep -v "host.docker.internal" /etc/hosts; echo "$gateway host.docker.internal"; } > /tmp/hosts
    cat /tmp/hosts > /etc/hosts
  fi
fi
export NODE_EXTRA_CA_CERTS=/complement/ca/ca.crt
exec node /app/complement/server.ts
