#!/bin/sh
# How many users does this machine safely support? Runs the load scenario with NODES homeserver
# instances (default 5) on one Postgres, doubling the users until k6's thresholds fail (send p95
# < 1 s, delivery p95 < 3 s, < 1% errors), narrows down between the last pass and the first fail,
# and prints the largest load that passed. The workload grows with the users: one message per
# second per 10 users online, 40 users per room.
#
#   packages/server/loadtest/capacity.sh            # START=100 NODES=5 RAMP=30s DURATION=1m
set -e
cd "$(dirname "$0")"
NODES=${NODES:-5}
compose="docker compose -p matrix-capacity -f docker-compose.yml"
log=$(mktemp)

# Runs one step; 0 = passed, 1 = thresholds crossed. Any other failure stops the script.
step() {
  rate=$(( $1 / 10 )); [ "$rate" -ge 1 ] || rate=1
  printf '%6d users, %4d messages/s ... ' "$1" "$rate"
  code=0
  ONLINE_USERS=$1 MESSAGES_PER_SECOND=$rate ROOMS=$(( ($1 + 39) / 40 )) RAMP=${RAMP:-30s} DURATION=${DURATION:-1m} CLUSTER=1 \
    $compose up --scale "homeserver=$NODES" --abort-on-container-exit --exit-code-from k6 k6 > "$log" 2>&1 || code=$?
  $compose down -v > /dev/null 2>&1
  case $code in
    0) echo "ok"; return 0 ;;
    99) echo "over the limit"; return 1 ;;
    *) echo "the run failed (exit $code):"; grep -v "^homeserver" "$log" | tail -20; exit 1 ;;
  esac
}

$compose build -q
lo=0; hi=${START:-100}
while step "$hi"; do lo=$hi; hi=$(( hi * 2 )); done
# Narrow down to within a tenth of the result.
while [ "$lo" -gt 0 ] && [ $(( hi - lo )) -gt $(( lo / 10 )) ]; do
  mid=$(( (lo + hi) / 2 ))
  if step "$mid"; then lo=$mid; else hi=$mid; fi
done

echo
if [ "$lo" -eq 0 ]; then
  echo "This machine did not pass even ${START:-100} users with $NODES instances on Postgres; try START=20."
else
  echo "This machine safely supports ~$lo users online with $NODES instances on one Postgres database"
  echo "($(( lo / 10 > 0 ? lo / 10 : 1 )) messages/s, 40 users per room; failed at $hi). k6 ran on the same machine."
fi
