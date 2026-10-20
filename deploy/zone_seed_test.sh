#!/usr/bin/env bash
# zone_seed_test.sh — setup-pocketbase.sh's seed_zone, against a stub PocketBase.
#
#   ./deploy/zone_seed_test.sh
#
# The zone picker's labels are zones.display_name. seed_zone used to skip a zone
# that already existed, so renaming one in the script ("EU" -> "Europe") never
# reached a running environment (#516). It checks:
#   1. a missing zone is created with the seeded labels
#   2. an existing zone with different labels is PATCHed to the seeded ones,
#      and its code is never touched (it is the queue key)
#   3. an existing zone that already matches is left alone
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

FN="$WORK/seed_zone.sh"
sed -n '/^seed_zone() {/,/^}/p' "$HERE/setup-pocketbase.sh" > "$FN"
grep -q 'seed_zone()' "$FN" || fail "seed_zone not found in setup-pocketbase.sh"

# The stub answers the list query with $ROW (empty = no such zone) and records
# every write as "METHOD url body".
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
method=GET url="" body="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -w|-H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ "$method" = GET ]; then
  if [ -n "${ROW:-}" ]; then printf '{"items":[%s]}' "$ROW"; else printf '{"items":[]}'; fi
  exit 0
fi
echo "$method $url $body" >> "$WRITES"
[ -n "$out" ] && echo '{}' > "$out"
printf 200
STUB
chmod +x "$WORK/bin/curl"

run() { # ROW-json-or-empty
  : > "$WORK/writes"
  env PATH="$WORK/bin:$PATH" ROW="$1" WRITES="$WORK/writes" bash -c '
    set -euo pipefail
    PB_ADDR=127.0.0.1 PB_PORT=8090 TOKEN=t
    . "'"$FN"'"
    seed_zone eu-central eu Europe "Europe" 10
  ' >/dev/null
}

echo "== a missing zone is created =="
run ""
grep -q '^POST .*/collections/zones/records {' "$WORK/writes" || fail "no POST for a missing zone: $(cat "$WORK/writes")"
grep -q '"display_name":"Europe"' "$WORK/writes" || fail "created with the wrong label"

echo "== an existing zone with old labels is relabelled =="
run '{"id":"z1","code":"eu-central","group_name":"Europe","display_name":"EU"}'
grep -q '^PATCH .*/collections/zones/records/z1 ' "$WORK/writes" || fail "an existing zone with an old label was not updated: $(cat "$WORK/writes")"
grep -q '"display_name":"Europe"' "$WORK/writes" || fail "PATCH does not carry the new label"
grep -q '"code"' "$WORK/writes" && fail "the PATCH touches code, the queue key"
grep -q '^POST' "$WORK/writes" && fail "an existing zone was created again"

echo "== an existing zone that matches is left alone =="
run '{"id":"z1","code":"eu-central","group_name":"Europe","display_name":"Europe"}'
[ ! -s "$WORK/writes" ] || fail "wrote to a zone that already matches: $(cat "$WORK/writes")"

echo "PASS: zone_seed_test.sh"
