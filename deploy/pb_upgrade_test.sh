#!/usr/bin/env bash
# pb_upgrade_test.sh — what deploy/pocketbase/upgrade.sh hands the ops module (#620).
#
#   ./deploy/pb_upgrade_test.sh
#
# Production binds PocketBase to its private address (PB_BIND_IP), so a health
# check on 127.0.0.1 is refused and the module would roll a good upgrade back.
# It checks, with a stub module that records its arguments:
#   1. with PB_BIND_IP in the env file (quoted, as remote-deploy writes it), the
#      URL and the health URL use that address
#   2. without it, they fall back to loopback
#   3. the health check reads a real collection (monitors), and the version
#      argument is passed through without its leading "v"
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ran=0

mkdir -p "$WORK/app/deploy/.ops"
cat > "$WORK/app/deploy/.ops/container.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$ARGS"
STUB
chmod +x "$WORK/app/deploy/.ops/container.sh"

arg() { # file flag -> the value after flag
  awk -v f="$2" 'p {print; exit} $0 == f {p=1}' "$1"
}
run() { # env-file-contents version
  printf '%s\n' "$1" > "$WORK/pb.env"
  APP_DIR="$WORK/app" ENV_FILE="$WORK/pb.env" ARGS="$WORK/args" \
    bash "$HERE/pocketbase/upgrade.sh" "$2" >/dev/null
}

# 1
run "PB_BIND_IP='10.0.0.2'" 0.40.5
[ "$(arg "$WORK/args" --url)" = http://10.0.0.2:8090 ] || fail "--url is $(arg "$WORK/args" --url), want the bind address"
[ "$(arg "$WORK/args" --health-url)" = http://10.0.0.2:8090/api/health ] || fail "--health-url is $(arg "$WORK/args" --health-url)"
ran=$((ran + 1))

# 2
run "PB_VERSION='0.28.4'" 0.40.5
[ "$(arg "$WORK/args" --url)" = http://127.0.0.1:8090 ] || fail "without PB_BIND_IP --url is $(arg "$WORK/args" --url)"
ran=$((ran + 1))

# 3
run "PB_BIND_IP='10.0.0.2'" v0.40.5
[ "$(arg "$WORK/args" --health-collection)" = monitors ] || fail "the health check does not read a collection"
[ "$(arg "$WORK/args" --to)" = 0.40.5 ] || fail "--to is $(arg "$WORK/args" --to)"
ran=$((ran + 1))

[ "$ran" = 3 ] || fail "only $ran of 3 checks ran"
echo "pb_upgrade_test: all $ran checks passed"
