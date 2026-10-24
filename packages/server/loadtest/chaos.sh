#!/bin/sh
# Soak and failure injection (https://github.com/k18k/katrix/issues/63), local only.
# Runs the k6 scenario against NODES homeserver nodes on Postgres, and meanwhile (FAULTS=1, default):
#   at 1/5 of DURATION  restarts Postgres;
#   at 2/5              kills one homeserver node (SIGKILL), and starts it again at 3/5.
# FAULTS=0 is a plain soak run (DURATION=1h, 6h…). Afterwards it prints, per node, the server's
# 10-second reports at the start and at the end (memory, event-loop delay, 5xx), and k6's summary.
#
#   ONLINE_USERS=1000 MESSAGES_PER_SECOND=20 ROOMS=25 RAMP=30s DURATION=5m NODES=3 loadtest/chaos.sh
#
# What has to hold (see README, "Soak and failure injection"): errors only while a fault lasts, every
# node serving again within seconds after it ends, memory flat over a soak, no 5xx outside faults.
set -e
cd "$(dirname "$0")"
: "${DURATION:=5m}" "${NODES:=3}" "${FAULTS:=1}"
export DURATION SUMMARY="${SUMMARY:-chaos}" CLUSTER=1
compose="docker compose -p matrix-chaos -f docker-compose.yml"
seconds=$(echo "$DURATION" | sed -E 's/^([0-9]+)m$/\1*60/; s/^([0-9]+)h$/\1*3600/; s/^([0-9]+)s$/\1/' | bc)
ramp=$(echo "${RAMP:-2m}" | sed -E 's/^([0-9]+)m$/\1*60/; s/^([0-9]+)s$/\1/' | bc)
log() { echo "[chaos $(date +%T)] $*"; }

$compose build -q
$compose up -d --scale "homeserver=$NODES" postgres homeserver lb
k6log=$(mktemp)
$compose up --no-deps --exit-code-from k6 k6 > "$k6log" 2>&1 &
k6=$!

if [ "$FAULTS" = 1 ]; then
  step=$((seconds / 5))
  sleep $((ramp + step))
  log "restarting Postgres"; $compose restart postgres
  sleep "$step"
  victim=$($compose ps -q homeserver | head -1)
  log "killing node ${victim%"${victim#????????????}"}"; docker kill "$victim" > /dev/null
  sleep "$step"
  log "starting it again"; docker start "$victim" > /dev/null
fi

code=0; wait "$k6" || code=$?
log "k6 exited with $code"
for c in $($compose ps -aq homeserver); do
  name=$(docker inspect -f '{{.Name}}' "$c")
  echo "--- $name: first and last reports"
  docker logs "$c" 2>&1 | grep "req/s" | sed -n '2p;$p'
  echo "    5xx in total: $(docker logs "$c" 2>&1 | grep -o '[0-9]* 5xx' | awk '{s += $1} END {print s + 0}')"
done
grep -E "http_req_failed|messages_(sent|received)|message_delivery|dropped_iterations|checks" "$k6log" || true
$compose down -v > /dev/null 2>&1
exit "$code"
