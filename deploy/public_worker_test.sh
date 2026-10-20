#!/usr/bin/env bash
# public_worker_test.sh — remote-deploy.sh's `worker <ip> <zone> public` lines (#498).
#
#   ./deploy/public_worker_test.sh
#
# A worker outside the Hetzner private network (the Singapore one) has no route to
# PocketBase's private address. Getting its env file wrong does not fail a deploy:
# the worker retries auth forever and looks healthy from the outside. So this
# pins down, without a fleet:
#   1. a public worker gets the tunnel URL, its Access token and NO private subnet
#   2. a private worker is unchanged, and never picks up the public token
#   3. a public worker with its token missing stops the deploy before its env
#      file is pushed — a failed ${VAR:?} inside $(…) would not
#   4. a 4th field that is not `public` is rejected rather than ignored
#   5. the readiness gate checks EVERY node, the public one through Access — even
#      though each check runs ssh, which reads stdin (#508)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The functions under test, out of the real script. Running all of
# remote-deploy.sh would need a fleet.
FUNCS="$WORK/funcs.sh"
for f in public_worker_config_ok public_pb_url worker_env deploy_node check_node_routes; do
  body="$(sed -n "/^${f}() {/,/^}/p" "$HERE/remote-deploy.sh")"
  [ -n "$body" ] || fail "function $f not found in remote-deploy.sh"
  printf '%s\n' "$body" >> "$FUNCS"
done

# Fakes for what deploy_node calls: push_env records the env file it was given.
run() { # extra-env-assignments… -- script
  env "$@" bash -c '
    set -euo pipefail
    ENV_FILE="(test)"
    PB_URL="http://10.0.0.2:8090"
    PB_AUTH_COLLECTION="service_accounts"
    PRIVATE_SUBNET="10.0.0.0/16"
    WORKER_PB_USERNAME="worker@svc.local"
    WORKER_PB_PASSWORD="pw"
    BUILD_VERSION="1.2.3"; BUILD_COMMIT="abc1234"
    push_env() { printf "%s\n" "$3" > "$PUSHED"; }
    push_code() { :; }
    run_setup() { :; }
    . "'"$FUNCS"'"
    eval "$SCRIPT"
  '
}

export PUSHED="$WORK/pushed.env"

echo "== a public worker goes through the tunnel =="
rm -f "$PUSHED"
SCRIPT='deploy_node worker 192.0.2.10 ap-southeast public' run \
  PUSHED="$PUSHED" PB_HOSTNAME=pb.test.local \
  WORKER_CF_ACCESS_CLIENT_ID=cf-id WORKER_CF_ACCESS_CLIENT_SECRET=cf-secret \
  >/dev/null || fail "deploy_node failed for a public worker"
envf="$(cat "$PUSHED")"
grep -qx 'PB_URL=https://pb.test.local' <<<"$envf"        || fail "public worker PB_URL is not the tunnel URL:
$envf"
grep -qx 'CF_ACCESS_CLIENT_ID=cf-id' <<<"$envf"           || fail "public worker has no Access client id"
grep -qx 'CF_ACCESS_CLIENT_SECRET=cf-secret' <<<"$envf"   || fail "public worker has no Access secret"
grep -qx 'PRIVATE_SUBNET=' <<<"$envf"                     || fail "public worker still has a private subnet (ensure-private-net.sh would fail it)"
grep -qx 'REGION_NAME=ap-southeast' <<<"$envf"            || fail "zone not passed"

echo "== a private worker is unchanged =="
rm -f "$PUSHED"
SCRIPT='deploy_node worker 192.0.2.11 eu-central' run \
  PUSHED="$PUSHED" PB_HOSTNAME=pb.test.local \
  WORKER_CF_ACCESS_CLIENT_ID=cf-id WORKER_CF_ACCESS_CLIENT_SECRET=cf-secret \
  >/dev/null || fail "deploy_node failed for a private worker"
envf="$(cat "$PUSHED")"
grep -qx 'PB_URL=http://10.0.0.2:8090' <<<"$envf"   || fail "private worker lost the private PB_URL"
grep -qx 'CF_ACCESS_CLIENT_ID=' <<<"$envf"          || fail "private worker picked up the public worker's token"
grep -qx 'PRIVATE_SUBNET=10.0.0.0/16' <<<"$envf"    || fail "private worker lost its private subnet"

echo "== a public worker without its token stops before pushing =="
rm -f "$PUSHED"
if SCRIPT='deploy_node worker 192.0.2.10 ap-southeast public' run \
     PUSHED="$PUSHED" PB_HOSTNAME=pb.test.local >"$WORK/out" 2>&1; then
  fail "deploy_node succeeded with no WORKER_CF_ACCESS_* set"
fi
[ ! -e "$PUSHED" ] || fail "an env file was pushed for a public worker with no token:
$(cat "$PUSHED")"
grep -q 'WORKER_CF_ACCESS_CLIENT_ID' "$WORK/out" || fail "the error does not name the missing token: $(cat "$WORK/out")"

echo "== an unknown 4th field is rejected =="
rm -f "$PUSHED"
if SCRIPT='deploy_node worker 192.0.2.10 ap-southeast pubic' run PUSHED="$PUSHED" >/dev/null 2>&1; then
  fail "a misspelt marker was accepted (the worker would silently get the private URL)"
fi
[ ! -e "$PUSHED" ] || fail "an env file was pushed for a malformed NODES line"

echo "== the gate checks every node, however many ssh calls it makes =="
# The fakes read their stdin to the end, as ssh does. If the loop shares stdin
# with them, the first one swallows the rest of NODES and only one node is
# checked — which is what happened on production.
CHECKED="$WORK/checked"; : > "$CHECKED"
SCRIPT='
pb_route_ok() { cat >/dev/null; echo "route $2" >> "$CHECKED"; }
pb_public_ready() { cat >/dev/null; echo "public $1" >> "$CHECKED"; }
NODES="pocketbase 10.9.9.1
evaluator 192.0.2.20
worker 192.0.2.21 eu-central
worker 192.0.2.22 ap-southeast public
fly nabz-worker-eu-fly eu ams"
check_node_routes' run CHECKED="$CHECKED" PUSHED="$PUSHED" </dev/null >/dev/null \
  || fail "check_node_routes failed with every check passing"
checked="$(sort "$CHECKED")"
want="$(printf '%s\n' 'public 192.0.2.22' 'route 192.0.2.20' 'route 192.0.2.21' | sort)"
[ "$checked" = "$want" ] || fail "the gate did not check every node the right way.
want:
$want
got:
$checked"

echo "== ...and a failing node fails the gate, after the rest are checked =="
: > "$CHECKED"
if SCRIPT='
pb_route_ok() { cat >/dev/null; echo "route $2" >> "$CHECKED"; [ "$2" != 192.0.2.20 ]; }
pb_public_ready() { cat >/dev/null; echo "public $1" >> "$CHECKED"; }
NODES="evaluator 192.0.2.20
worker 192.0.2.22 ap-southeast public"
check_node_routes' run CHECKED="$CHECKED" PUSHED="$PUSHED" </dev/null >/dev/null; then
  fail "a node whose route check failed did not fail the gate"
fi
grep -qx 'public 192.0.2.22' "$CHECKED" || fail "the gate stopped at the first failing node instead of checking the rest"

echo "PASS: public_worker_test.sh"
