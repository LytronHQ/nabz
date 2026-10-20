#!/usr/bin/env bash
# pb_maintenance_unit_test.sh — the maintenance unit setup-pocketbase.sh writes.
#
#   ./deploy/pb_maintenance_unit_test.sh
#
# The nightly backup logs in to PocketBase at the URL baked into this unit. On a
# fleet node PocketBase is published on the PRIVATE address only, so a unit that
# says 127.0.0.1 fails every login and takes no backup — silently, at 03:17, on a
# host nobody reads (#512). This runs the real block out of the script and checks:
#   1. the unit logs in at PB_ADDR (the private address), not 127.0.0.1
#   2. without PB_BIND_IP (dev) it still uses 127.0.0.1
#   3. if PocketBase does not answer at that URL, no unit is written and the
#      setup fails, instead of installing a timer that cannot take a backup
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# From the "maintenance target" line through the end of the service unit: the
# part that decides where the job logs in, with the unit written to $WORK.
BLOCK="$WORK/block.sh"
sed -n '/^echo "   maintenance target: /,/^UNIT$/p' "$HERE/setup-pocketbase.sh" \
  | sed "s#/etc/systemd/system/nabz-pb-maintenance.service#\$UNIT_OUT#" > "$BLOCK"
grep -q 'nabz-pb-maintenance maintain' "$BLOCK" || fail "could not find the unit block in setup-pocketbase.sh"

mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CURL_LOG"
[ "${CURL_OK:-1}" = 1 ]
STUB
chmod +x "$WORK/bin/curl"

run() { # extra env…
  env PATH="$WORK/bin:$PATH" CURL_LOG="$WORK/curl.log" UNIT_OUT="$WORK/unit" "$@" bash -c '
    set -euo pipefail
    APP_DIR=/opt/monitors ENV_FILE=/etc/monitors/pocketbase.env
    PB_CONTAINER_RESOLVED=monitors-pocketbase-pocketbase-1 hb_arg=""
    PB_ADDR="${PB_BIND_IP:-127.0.0.1}"
    . "'"$BLOCK"'"
  '
}

echo "== a fleet node: the unit logs in at the private address =="
rm -f "$WORK/unit"
run PB_BIND_IP=10.0.0.2 >/dev/null || fail "the block failed with PocketBase answering"
grep -q -- '--url http://10.0.0.2:8090' "$WORK/unit" || fail "unit does not log in at the bind address:
$(grep -- '--url' "$WORK/unit")"

echo "== dev (no PB_BIND_IP): localhost =="
rm -f "$WORK/unit"
run >/dev/null || fail "the block failed in the dev case"
grep -q -- '--url http://127.0.0.1:8090' "$WORK/unit" || fail "dev unit does not use 127.0.0.1"

echo "== PocketBase not answering at that URL: no timer =="
rm -f "$WORK/unit"
if run PB_BIND_IP=10.0.0.2 CURL_OK=0 >/dev/null 2>&1; then
  fail "installed a maintenance unit whose URL does not answer"
fi
[ ! -e "$WORK/unit" ] || fail "a unit was written although its URL does not answer"

echo "PASS: pb_maintenance_unit_test.sh"
