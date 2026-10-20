#!/usr/bin/env bash
# external_watch_test.sh — external-watch.sh against a stub Better Stack, checking
# that a run leaves every monitor and heartbeat switched ON.
#
#   ./deploy/external_watch_test.sh
#
# The production health and PocketBase monitors were paused before launch, while
# production did not exist and they could only fail. The upsert set every other
# attribute but never `paused`, so the launch-day run printed "updated" and left
# them paused: Better Stack saw neither #520 nor #588 (#593).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

FIX="$WORK/deploy"; mkdir -p "$FIX" "$WORK/bin"
ln -s "$HERE/external-watch.sh" "$FIX/external-watch.sh"
# The configuration comes from Bitwarden; the stub hands over a fixed one.
cat > "$FIX/bws-env.sh" <<'EOF'
#!/usr/bin/env bash
echo "WEB_URL='https://nabz.example'"
echo "BETTERSTACK_API_TOKEN='bs-token'"
EOF
chmod +x "$FIX/bws-env.sh"

# Better Stack as it was on launch day: all three monitors and both heartbeats
# exist, and two of the monitors are paused. Every write is logged as one line,
# "METHOD URL BODY".
LOG="$WORK/calls.log"; : > "$LOG"
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
method=GET url= body=
while [ \$# -gt 0 ]; do
  case "\$1" in
    -X) method="\$2"; shift 2 ;;
    -d) body="\$2"; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
[ "\$method" = GET ] || echo "\$method \$url \$body" >> "$LOG"
case "\$method \$url" in
  "GET https://uptime.betterstack.com/api/v2/monitors?per_page=50")
    echo '{"data":[
      {"id":"1","attributes":{"url":"https://nabz.example","paused":false}},
      {"id":"2","attributes":{"url":"https://nabz.example/api/health","paused":true}},
      {"id":"3","attributes":{"url":"https://nabz.example/api/health?probe=pocketbase","paused":true}}]}' ;;
  "GET https://uptime.betterstack.com/api/v2/heartbeats")
    echo '{"data":[
      {"id":"7","attributes":{"name":"nabz-evaluator (testenv)"}},
      {"id":"8","attributes":{"name":"nabz-pb-maintenance (testenv)"}}]}' ;;
  *heartbeats*) echo '{"data":{"id":"7","attributes":{"url":"https://hb.example/x"}}}' ;;
  *) echo '{"data":{"id":"1","attributes":{}}}' ;;
esac
EOF
chmod +x "$WORK/bin/curl"

PATH="$WORK/bin:$PATH" HEALTH_DEBUG_TOKEN=debug-token \
  bash "$FIX/external-watch.sh" testenv > "$WORK/out.log" 2>&1 \
  || { cat "$WORK/out.log" >&2; fail "external-watch.sh exited non-zero"; }

checked=0
for target in monitors/1 monitors/2 monitors/3 heartbeats/7 heartbeats/8; do
  line="$(grep -E "^PATCH https://uptime.betterstack.com/api/v2/${target} " "$LOG" || true)"
  [ -n "$line" ] || fail "no PATCH to $target"
  body="${line#* * }"
  [ "$(jq -r '.paused' <<<"$body")" = false ] || fail "PATCH $target leaves paused unset: $body"
  checked=$((checked+1))
done
[ "$checked" -eq 5 ] || fail "checked $checked of 5 resources"
echo "ok: external-watch.sh switches on all $checked monitors and heartbeats"
