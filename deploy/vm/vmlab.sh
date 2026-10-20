#!/usr/bin/env bash
#
# vmlab.sh — a throwaway libvirt/KVM lab on your own machine.
#
#   deploy/vm/vmlab.sh create | status | ips | start | stop | destroy --all
#
# The lab itself is the `vmlab` script of LytronHQ/ops, which is NOT committed
# here: it is fetched into deploy/.ops/ from the release pinned in
# deploy/ops.lock. This wrapper exists so the command above keeps working from a
# fresh clone, and so the fetch is not something you have to remember.
#
# Every option is the module's — see `deploy/vm/vmlab.sh --help`.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")/.." && pwd)"

# --check first: it costs a few sha256sums, where the fetch costs a download.
"$DEPLOY/ops-fetch.sh" --check >/dev/null 2>&1 || "$DEPLOY/ops-fetch.sh" >/dev/null

exec "$DEPLOY/.ops/vmlab.sh" "$@"
