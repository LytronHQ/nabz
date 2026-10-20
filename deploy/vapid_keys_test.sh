#!/usr/bin/env bash
# vapid_keys_test.sh — keys from vapid-keys.sh are a matching P-256 pair that
# the evaluator's push sender signs with (#602).
#
#   ./deploy/vapid_keys_test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

out="$("$HERE/vapid-keys.sh")"
pub="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' <<<"$out")"
priv="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' <<<"$out")"
[ "${#pub}" -eq 87 ] || fail "public key is ${#pub} characters, want 87"
[ "${#priv}" -eq 43 ] || fail "private key is ${#priv} characters, want 43"

# Two runs must not repeat a key.
[ "$("$HERE/vapid-keys.sh" | sed -n 's/^VAPID_PRIVATE_KEY=//p')" != "$priv" ] || fail "two runs minted the same key"

# Captured, not piped into grep -q: under pipefail, grep exiting at the first
# match SIGPIPEs go test and fails a passing run.
res="$(cd "$HERE/../evaluator" && SCRIPT_VAPID_PUBLIC_KEY="$pub" SCRIPT_VAPID_PRIVATE_KEY="$priv" \
  go test -count=1 -run '^TestVAPIDKeysFromScript$' -v . 2>&1)" || { echo "$res" >&2; fail "go test failed"; }
grep -q -- '--- PASS: TestVAPIDKeysFromScript' <<<"$res" || { echo "$res" >&2; fail "the evaluator rejected the minted keys"; }
echo "ok: vapid-keys.sh mints a matching pair the evaluator signs with"
