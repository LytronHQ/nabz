#!/usr/bin/env bash
# setup-pocketbase.sh reaches the host as `ssh … 'bash -s' < script`, so the rest
# of the script is bash's stdin. pb_run_offline's `docker compose run` read that
# stdin and swallowed every line after it; bash hit EOF, ssh exited 0, and the
# deploy went on against a half-set-up PocketBase (#586). This runs the real
# function the same way, with a docker stub that reads stdin like the real one.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

fn="$(sed -n '/^pb_run_offline() {/,/^}/p' "$HERE/setup-pocketbase.sh")"
[ -n "$fn" ] || { echo "FAIL: pb_run_offline not found in setup-pocketbase.sh"; exit 1; }

out="$(bash -s <<SCRIPT
docker() { cat >/dev/null; echo "docker \$*"; }
$fn
pb_run_offline /usr/local/bin/pocketbase migrate
echo AFTER-THE-OFFLINE-STEP
SCRIPT
)"

grep -q 'AFTER-THE-OFFLINE-STEP' <<<"$out" || {
  echo "FAIL: the line after pb_run_offline never ran — docker read the rest of the script"
  echo "$out"
  exit 1
}
grep -q -- 'run -T' <<<"$out" || { echo "FAIL: docker compose run without -T: $out"; exit 1; }
echo "PASS: pb_run_offline_stdin_test.sh"
