#!/usr/bin/env bash
# ops_vendor_test.sh — what is in deploy/.ops/ is what ops.lock says, and what
# ops.lock says is what that release published.
#
#   ./deploy/ops_vendor_test.sh
#
# The scripts are fetched, not committed, which moves the risk: instead of a file
# drifting in git it is a file drifting on disk, or a lock that pins hashes the
# release never published. This catches both, and also that deploy/ops-get — the
# one committed file, the thing that does the fetching — has not been edited.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/ops.lock"
OPS="${OPS_DIR:-$HERE/.ops}"

fail() { echo "FAIL: $*" >&2; exit 1; }

got="$(sha256sum "$HERE/ops-get" | awk '{print $1}')"
[ "$got" = "$OPS_SHA256_OPS_GET" ] || fail "deploy/ops-get does not match $OPS_VERSION.
  expected $OPS_SHA256_OPS_GET
  got      $got
  It is the one ops file committed here, because something has to bootstrap the
  fetch. Edit it in LytronHQ/ops, not here."
echo "ops-get matches $OPS_VERSION"

# Everything fetched is present and matches the lock. ops-fetch --check is the
# code that decides this, so the test asks it rather than reimplementing it — a
# second copy of the rule is a second thing to get wrong.
"$HERE/ops-fetch.sh" --check >/dev/null 2>&1 \
  || fail "deploy/.ops does not match ops.lock. Run deploy/ops-fetch.sh.
$("$HERE/ops-fetch.sh" --check 2>&1 || true)"
echo "deploy/.ops matches $OPS_VERSION"

# Only with a network and a logged-in gh: the hashes the lock pins are the ones
# that release actually published, not ones copied from the wrong place. Without
# it the checks above still run — they need nothing but the files.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  url="$(gh release view "$OPS_VERSION" -R LytronHQ/ops --json assets \
    -q '.assets[] | select(.name=="SHA256SUMS") | .url' 2>/dev/null || true)"
  published=""
  [ -z "$url" ] || published="$(curl -fsSL "$url" 2>/dev/null || true)"
  if [ -n "$published" ]; then
    while read -r name asset want; do
      [ -n "${name:-}" ] || continue
      theirs="$(printf '%s\n' "$published" | awk -v a="$asset" '$2 == a {print $1}' | head -1)"
      [ -n "$theirs" ] || fail "$OPS_VERSION publishes no asset named $asset"
      [ "$theirs" = "$want" ] \
        || fail "ops.lock pins $want for $asset but $OPS_VERSION published $theirs"
    done <<<"$OPS_VENDORED"
    theirs="$(printf '%s\n' "$published" | awk '$2 == "ops-get" {print $1}' | head -1)"
    [ -z "$theirs" ] || [ "$theirs" = "$OPS_SHA256_OPS_GET" ] \
      || fail "ops.lock pins $OPS_SHA256_OPS_GET for ops-get but $OPS_VERSION published $theirs"
    echo "every pinned hash matches what $OPS_VERSION published"
  fi
fi
