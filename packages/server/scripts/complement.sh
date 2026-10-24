#!/bin/sh
# Run Complement against this homeserver. Only Docker is needed: Complement itself runs in a
# Go container (pinned to COMPLEMENT_REF) and starts the homeserver containers through the
# host's Docker socket.
#
#   scripts/complement.sh                       # whole suite
#   scripts/complement.sh ./tests/msc3902/      # one package
#   scripts/complement.sh ./tests/ -run 'TestFoo|TestBar'
#
# The homeserver image is rebuilt from this checkout on every run (layer caching keeps it quick).
# Complement's sources and Go caches live in the Docker volume $CACHE_VOLUME, so they are
# downloaded once. Results are written as `go test -json` to $OUT (default
# complement-results.json); feed them to `node complement/status.ts` to update the README.
#
# Environment: COMPLEMENT_REF, OUT, TIMEOUT (default 90m), PARALLEL (default 2),
# MATRIX_DEBUG=1 (print server debug logs of failing tests), CACHE_VOLUME, GO_IMAGE.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
# The image is built from the repository root (npm workspaces share one lockfile).
repo=$(cd "$root/../.." && pwd)
image=complement-katrix:latest
ref=${COMPLEMENT_REF:-e2ada0745de192f930afe015e8cd8d87dd0e1a7c}
go_image=${GO_IMAGE:-golang:1.26-bookworm}
cache=${CACHE_VOLUME:-katrix-complement}
out=${OUT:-$root/complement-results.json}
[ $# -gt 0 ] || set -- ./tests/...

docker build -q -t "$image" -f "$root/complement/Dockerfile" "$repo" >/dev/null

# https://github.com/k18k/katrix/issues/18: a server that cannot even load its
# modules made Complement wait for every container until the timeout. Check that first, and stop
# with the error in seconds.
docker run --rm --entrypoint node "$image" -e 'import("/app/packages/server/src/index.ts").catch((e) => { console.error("The homeserver does not load:", e.message); process.exit(1); })'

# Variables prefixed PASS_ reach the homeserver containers (without the prefix). The homeservers
# reach Complement through their gateway (see complement/entrypoint.sh). MATRIX_DEBUG=1 prints
# server debug logs (shown by Complement for failing tests).
debug_env="-e COMPLEMENT_SHARE_ENV_PREFIX=PASS_ -e PASS_COMPLEMENT_HOST_VIA_GATEWAY=1"
if [ -n "$MATRIX_DEBUG" ]; then
  debug_env="$debug_env -e PASS_MATRIX_DEBUG=1 -e COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS=1"
fi

status=0
# Host networking lets the tests reach the homeserver containers' published ports, and those
# containers reach Complement's own test servers (through host.docker.internal).
# shellcheck disable=SC2086
docker run --rm --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$cache:/cache" \
  -e GOPATH=/cache/go -e GOCACHE=/cache/go-build -e GOFLAGS=-buildvcs=false \
  -e COMPLEMENT_BASE_IMAGE="$image" \
  -e COMPLEMENT_SPAWN_HS_TIMEOUT_SECS="${COMPLEMENT_SPAWN_HS_TIMEOUT_SECS:-60}" \
  $debug_env \
  "$go_image" sh -c '
    set -e
    src=/cache/complement-$1
    if [ ! -f "$src/go.mod" ]; then
      rm -rf "$src.tmp" && mkdir -p "$src.tmp" && cd "$src.tmp"
      git init -q && git fetch -q --depth 1 https://github.com/matrix-org/complement.git "$1" && git checkout -q FETCH_HEAD
      cd / && mv "$src.tmp" "$src"
    fi
    cd "$src"
    timeout=$2; parallel=$3; shift 3
    exec go test -count=1 -json -timeout "$timeout" -p "$parallel" "$@"
  ' complement "$ref" "${TIMEOUT:-90m}" "${PARALLEL:-2}" "$@" > "$out" || status=$?

node "$root/complement/summarize.ts" "$out" | sed -n '1,8p'
exit $status
