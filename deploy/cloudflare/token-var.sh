#!/usr/bin/env bash
# token-var.sh — print the variable-name suffix access.sh uses for a token.
#
#   deploy/cloudflare/token-var.sh nabz-pocketbase-worker   # NABZ_POCKETBASE_WORKER
#
# access.sh prints CF_ACCESS_CLIENT_ID_<SUFFIX> per --token, where <SUFFIX> is
# the token name upper-cased with everything outside A-Z0-9 turned into _. Both
# callers — the infra-access workflow and fly-token.sh — have to reproduce that
# to read the output back, and two copies of one rule drift. This is the copy.
set -euo pipefail
[ $# -eq 1 ] && [ -n "$1" ] || { echo "usage: token-var.sh <token-name>" >&2; exit 2; }
printf '%s\n' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g'
