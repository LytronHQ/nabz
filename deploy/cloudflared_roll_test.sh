#!/usr/bin/env bash
# cloudflared_roll_test.sh — setup-pocketbase.sh's roll_cloudflared against real
# Docker, with a stand-in for cloudflared.
#
#   ./deploy/cloudflared_roll_test.sh
#
# A plain `docker compose up` recreates both tunnel connectors at once when their
# image changes, which takes pb.nabz.sh down (#663). The roll must keep at least
# two connectors running at every moment, end on the new image with no extra
# replicas, and leave the old pair serving when a new connector never registers.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PROJECT="cfroll$$"
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  [ -z "${WATCH:-}" ] || kill "$WATCH" 2>/dev/null || echo "watcher $WATCH already gone"
  docker compose -p "$PROJECT" -f "$WORK/deploy/pocketbase.yml" --profile tunnel down -t 1 >/dev/null 2>&1 \
    || echo "cleanup: compose down failed for $PROJECT" >&2
  rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker is missing: cannot test the roll"; exit 2; }

# Two image tags stand in for the old and new cloudflared. MSG is what the
# stand-in prints once "connected"; an unregistered connector prints nothing.
mkdir -p "$WORK/deploy"
cat > "$WORK/deploy/pocketbase.yml" <<'YML'
services:
  cloudflared:
    image: ${CF_IMAGE}
    profiles: ['tunnel']
    command: ["sh", "-c", "sleep 1; echo \"$$MSG\"; trap 'hostname >> /stops/log; exit 0' TERM; while true; do sleep 1; done"]
    volumes:
      - ${STOPS}:/stops
    environment:
      - MSG=${MSG:-Registered tunnel connection connIndex=0}
    deploy:
      replicas: 2
YML
# Each stand-in records a SIGTERM here: a graceful stop lets cloudflared drain,
# a kill leaves the edge routing to a dead connector (#665).
export STOPS="$WORK/stops"; mkdir -p "$STOPS"; : > "$STOPS/log"; chmod 777 "$STOPS"
docker pull -q busybox:1.36 >/dev/null
docker pull -q busybox:1.37 >/dev/null

# The function under test, taken from the script itself so the test cannot drift.
fn="$(sed -n '/^roll_cloudflared() {/,/^}/p' "$HERE/setup-pocketbase.sh")"
[ -n "$fn" ] || fail "roll_cloudflared not found in setup-pocketbase.sh"

run() { # CF_IMAGE MSG — one roll in a subshell, as setup-pocketbase.sh runs it
  (cd "$WORK" && export COMPOSE_PROJECT_NAME="$PROJECT" CF_IMAGE="$1" MSG="$2" \
    && eval "$fn" && roll_cloudflared)
}
running() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l; }
images() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Image}}' | sort | uniq -c | xargs
}

export COMPOSE_PROJECT_NAME="$PROJECT"
(cd "$WORK" && CF_IMAGE=busybox:1.36 docker compose -f deploy/pocketbase.yml --profile tunnel up -d >/dev/null 2>&1) \
  || fail "could not start the old pair"
sleep 2
[ "$(running)" -eq 2 ] || fail "old pair not running: $(images)"

# 1. Same image: nothing to do.
run busybox:1.36 "Registered tunnel connection" >/dev/null || fail "a no-op roll failed"
[ "$(images)" = "2 busybox:1.36" ] || fail "no-op roll changed the connectors: $(images)"
echo "ok: same image leaves the connectors alone"

# 2. A new connector that never registers: the old pair keeps serving.
if run busybox:1.37 "still connecting" >/dev/null 2>&1; then fail "a roll whose connectors never registered succeeded"; fi
[ "$(images)" = "2 busybox:1.36" ] || fail "a failed roll did not leave the old pair alone: $(images)"
echo "ok: unregistered new connectors are removed and the old pair stays"

# 3. A real roll: never fewer than two running, ending on two new ones.
min="$WORK/min"; echo 99 > "$min"
( while true; do n="$(running)"; [ "$n" -lt "$(cat "$min")" ] && echo "$n" > "$min"; sleep 0.2; done ) &
WATCH=$!
run busybox:1.37 "Registered tunnel connection connIndex=0" >/dev/null || fail "the roll failed"
(cd "$WORK" && CF_IMAGE=busybox:1.37 docker compose -f deploy/pocketbase.yml --profile tunnel up -d >/dev/null 2>&1)
sleep 1
kill "$WATCH"; WATCH=""
[ "$(wc -l < "$STOPS/log")" -eq 2 ] \
  || fail "the old pair was not stopped with SIGTERM ($(wc -l < "$STOPS/log") of 2 got it)"
[ "$(images)" = "2 busybox:1.37" ] || fail "after the roll and up: $(images), want 2 busybox:1.37"
[ "$(cat "$min")" -ge 2 ] || fail "only $(cat "$min") connector(s) ran at one point during the roll"
echo "ok: roll kept >= $(cat "$min") connectors up and the following up kept the new pair"
