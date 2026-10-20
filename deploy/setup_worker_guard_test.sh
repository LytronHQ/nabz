#!/usr/bin/env bash
# setup_worker_guard_test.sh — the WORKER_REPLICAS / WORKER_ID guard in
# setup-worker.sh.
#
#   ./deploy/setup_worker_guard_test.sh
#
# Why this is worth a test of its own: a replica whose id changes on every deploy
# leaves the zone believing the dead worker is still there for a whole roster
# TTL, so the monitors hashing to its index are checked by nobody. The guard is
# the only thing making a stable id non-optional, and it is a shell conditional
# nobody runs on purpose.
#
# It extracts the guard from setup-worker.sh rather than re-stating it, so the
# test fails if the real block drifts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The guard reads $ENV_FILE and either exits 1 or falls through.
guard="$(sed -n '/^REPLICAS="\$(grep -E/,/^fi$/p' "$HERE/setup-worker.sh")"
[ -n "$guard" ] || fail "could not extract the guard from setup-worker.sh — has it been rewritten?"

run_guard() { # env-file-contents
  printf '%s\n' "$1" > "$WORK/worker.env"
  ENV_FILE="$WORK/worker.env" bash -c "set -euo pipefail; $guard" 2>"$WORK/err"
}

echo "== one replica needs no id (it falls back to the container id, harmlessly) =="
run_guard 'WORKER_REPLICAS=1' || fail "a single replica without WORKER_ID was rejected"

echo "== one replica with a stable id is fine =="
run_guard 'WORKER_REPLICAS=1
WORKER_ID=eu-10-0-0-5' || fail "the normal single-worker deployment was rejected"

echo "== several replicas with a stable id is fine =="
run_guard 'WORKER_REPLICAS=3
WORKER_ID=eu-10-0-0-5' || fail "replicas with a stable id were rejected — that is how remote-deploy writes it"

echo "== several replicas with NO id is refused =="
if run_guard 'WORKER_REPLICAS=2
WORKER_ID='; then
  fail "replicas without a stable id were accepted — every deploy would leave the zone half-unchecked"
fi
grep -q 'WORKER_REPLICAS=2' "$WORK/err" || fail "the refusal should quote the offending value"
grep -q 'unchecked' "$WORK/err" || fail "the refusal should say what goes wrong, not just that it is invalid"

echo "== more replicas than the compose file declares is refused =="
if run_guard 'WORKER_REPLICAS=9
WORKER_ID=eu-10-0-0-5'; then
  fail "asked for 9 replicas and got no complaint, though worker.yml declares 4"
fi

echo "== a non-numeric replica count falls back to one rather than aborting =="
run_guard 'WORKER_REPLICAS=two
WORKER_ID=eu-10-0-0-5' || fail "a typo in WORKER_REPLICAS aborted the deploy"

echo "PASS"
