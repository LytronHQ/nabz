#!/usr/bin/env bash
# fly_deploy_test.sh — check remote-deploy.sh's `fly` role without touching Fly.
#
#   ./deploy/fly_deploy_test.sh
#
# A stub `fly` on PATH records what it was called with, so this asserts the parts
# that are expensive to get wrong and invisible until a real deploy:
#   1. secrets are staged BEFORE the release, and carry the zone, a stable worker
#      id and the Access token
#   2. the build uses the repo root as context and worker/dockerfile, or corelib/
#      is missing from the image
#   3. the app is scaled to exactly one machine
#   4. a missing fly CLI fails loudly instead of skipping a worker silently
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/fly" <<'STUB'
#!/usr/bin/env bash
echo "$@" >> "$FLY_LOG"
echo "pwd=$PWD" >> "$FLY_LOG"
exit 0
STUB
chmod +x "$WORK/bin/fly"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Source just the function under test, with the surrounding script's variables
# faked. Running the whole of remote-deploy.sh would need a fleet.
run_deploy_fly() {
  FLY_LOG="$WORK/fly.log" PATH="$WORK/bin:$PATH" bash -c '
    set -euo pipefail
    REPO_ROOT="'"$ROOT"'"
    ENV_FILE="(test)"
    PB_URL="https://pb.test.local"
    WORKER_PB_USERNAME="worker@svc.local"
    WORKER_PB_PASSWORD="pw"
    WORKER_CONCURRENCY="16"
    HEALTH_DEBUG_TOKEN="tok"
    FLY_CF_ACCESS_CLIENT_ID="cf-id"
    FLY_CF_ACCESS_CLIENT_SECRET="cf-secret"
    BUILD_VERSION="1.2.3"
    BUILD_COMMIT="abc1234"
    '"$(sed -n '/^deploy_fly() {/,/^}/p' "$HERE/remote-deploy.sh")"'
    deploy_fly "nabz-worker-eu" "eu" "ams"
  '
}

echo "== deploys =="
run_deploy_fly >/dev/null || fail "deploy_fly exited non-zero"
log="$(cat "$WORK/fly.log")"

grep -q -- "--stage" <<<"$log" || fail "secrets were not staged (a release before the secrets land crash-loops)"
grep -q "REGION_NAME=eu" <<<"$log" || fail "zone not passed as REGION_NAME"
grep -q "WORKER_ID=eu-fly-ams" <<<"$log" || fail "no stable worker id"
grep -q "CF_ACCESS_CLIENT_ID=cf-id" <<<"$log" || fail "Access client id not set"
grep -q "CF_ACCESS_CLIENT_SECRET=cf-secret" <<<"$log" || fail "Access secret not set"
grep -q "PB_URL=https://pb.test.local" <<<"$log" || fail "PB_URL not set"

grep -q -- "--dockerfile worker/dockerfile" <<<"$log" || fail "not built from worker/dockerfile"
grep -q -- "--config fly/fly.toml" <<<"$log" || fail "fly.toml not used"
grep -q "BUILD_COMMIT=abc1234" <<<"$log" || fail "build metadata not passed"
grep -q "pwd=$ROOT" <<<"$log" || fail "build context is not the repo root (corelib/ would be missing)"

# secrets must be staged before the deploy releases anything
secrets_line="$(grep -n "^secrets set" <<<"$log" | head -1 | cut -d: -f1)"
deploy_line="$(grep -n "^deploy \." <<<"$log" | head -1 | cut -d: -f1)"
[ -n "$secrets_line" ] && [ -n "$deploy_line" ] || fail "expected both a secrets and a deploy call"
[ "$secrets_line" -lt "$deploy_line" ] || fail "secrets were set AFTER the deploy"

grep -q "scale count 1" <<<"$log" || fail "app not pinned to one machine"

echo "== a missing fly CLI is fatal =="
if FLY_LOG="$WORK/none.log" PATH="/usr/bin:/bin" bash -c '
    set -euo pipefail
    REPO_ROOT="'"$ROOT"'"; ENV_FILE="(test)"; PB_URL="x"
    WORKER_PB_USERNAME=u; WORKER_PB_PASSWORD=p
    FLY_CF_ACCESS_CLIENT_ID=i; FLY_CF_ACCESS_CLIENT_SECRET=s
    BUILD_VERSION=v; BUILD_COMMIT=c
    '"$(sed -n '/^deploy_fly() {/,/^}/p' "$HERE/remote-deploy.sh")"'
    deploy_fly "app" "eu" "ams"
  ' >/dev/null 2>&1; then
  fail "a missing fly CLI was ignored — a worker would silently not be deployed"
fi

echo "PASS"
