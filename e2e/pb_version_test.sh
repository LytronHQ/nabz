#!/usr/bin/env bash
# pb_version_test.sh — e2e runs the PocketBase production runs (#613).
#
#   ./e2e/pb_version_test.sh
#
# e2e ran ghcr.io/muchobien/pocketbase:latest (0.40.4) while production ran
# 0.28.4, so it tested a PocketBase that behaved differently and moved without a
# commit. It checks:
#   1. the compose file builds PocketBase from deploy/pocketbase (production's
#      Dockerfile), with no third-party or :latest image
#   2. `setup.sh pb-version` is production's PB_VERSION (production.vars)
#   3. E2E_PB_VERSION overrides it, to try an upgrade on e2e first
#   4. Playwright's global setup exports it, for specs that run compose themselves
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
ran=0

# 1
pb_block="$(awk '/^  pocketbase:/{on=1; print; next} on && /^  [a-z]/{exit} on' "$HERE/docker-compose.e2e.yml")"
[ -n "$pb_block" ] || fail "no pocketbase service in docker-compose.e2e.yml"
grep -q 'context: ../deploy/pocketbase$' <<<"$pb_block" || fail "pocketbase is not built from deploy/pocketbase"
grep -q 'PB_VERSION: ${E2E_PB_VERSION' <<<"$pb_block" || fail "the build does not take E2E_PB_VERSION"
! grep -qE 'image: .*(muchobien|:latest)' <<<"$pb_block" || fail "pocketbase still uses a third-party or :latest image"
ran=$((ran + 1))

# 2
want="$(sed -n 's/^PB_VERSION=//p' "$ROOT/deploy/environments/production.vars")"
[ -n "$want" ] || fail "no PB_VERSION in production.vars"
got="$(env -u E2E_PB_VERSION bash "$HERE/setup.sh" pb-version)"
[ "$got" = "$want" ] || fail "setup.sh pb-version says $got, production runs $want"
ran=$((ran + 1))

# 3
[ "$(E2E_PB_VERSION=9.9.9 bash "$HERE/setup.sh" pb-version)" = 9.9.9 ] || fail "E2E_PB_VERSION is not honoured"
ran=$((ran + 1))

# 4
grep -q "E2E_PB_VERSION ||=" "$HERE/global-setup.ts" || fail "global-setup.ts does not export E2E_PB_VERSION"
ran=$((ran + 1))

[ "$ran" = 4 ] || fail "only $ran of 4 checks ran"
echo "pb_version_test: all $ran checks passed (e2e PocketBase $want)"
