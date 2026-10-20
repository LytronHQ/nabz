#!/usr/bin/env bash
# ops-fetch.sh — put the ops scripts named in deploy/ops.lock into deploy/.ops/.
#
#   ./deploy/ops-fetch.sh            # fetch what is missing or wrong
#   ./deploy/ops-fetch.sh --check    # verify only; fetch nothing, exit 1 if short
#
# Idempotent and cheap: a script already present with the pinned hash is left
# alone, so every caller can run this first without thinking about it. Only a
# missing or mismatched file costs a download.
#
# It verifies against the hash in ops.lock, not just against the release's own
# SHA256SUMS that ops-get checks. Those are different guarantees: ops-get proves
# the download matches what the release says today, and this proves it matches
# what we tested. A re-cut release passes the first and fails the second.
#
# Nothing here runs on a node. remote-deploy.sh ships deploy/.ops/ with the
# tracked files, so a node never needs GitHub.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/ops.lock"
DEST="${OPS_DIR:-$HERE/.ops}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

die() { echo "ops-fetch: $*" >&2; exit 1; }

sha_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

mkdir -p "$DEST"
missing=0 fetched=0 ok=0

while read -r name asset want; do
  [ -n "${name:-}" ] || continue
  target="$DEST/$name"

  if [ "$(sha_of "$target")" = "$want" ]; then
    ok=$((ok + 1))
    continue
  fi

  if [ "$CHECK" = 1 ]; then
    if [ -e "$target" ]; then
      echo "ops-fetch: $name does not match $OPS_VERSION (expected $want, got $(sha_of "$target"))" >&2
    else
      echo "ops-fetch: $name is not fetched" >&2
    fi
    missing=$((missing + 1))
    continue
  fi

  echo "==> fetching $asset $OPS_VERSION" >&2
  # A partial download must never be left where a caller would run it, so it
  # lands beside the target and is moved into place only once the hash matches.
  tmp="$(mktemp "$DEST/.$name.XXXXXX")"
  if ! "$HERE/ops-get" "$asset" "$OPS_VERSION" "$tmp" >/dev/null; then
    rm -f "$tmp"
    die "could not fetch $asset from $OPS_VERSION. ops-get fails closed, so nothing was written.
  Check the network, and that the release still exists:
    gh release view $OPS_VERSION -R LytronHQ/ops"
  fi

  got="$(sha_of "$tmp")"
  [ "$got" = "$want" ] || {
    rm -f "$tmp"
    die "$asset from $OPS_VERSION hashes $got, but ops.lock pins $want.
  The release was re-cut, or the lock is wrong. Nothing was written. This is the
  check ops-get cannot make for you: it proves the download matches what the
  release says NOW, not what we tested."
  }

  chmod +x "$tmp"
  mv "$tmp" "$target"
  fetched=$((fetched + 1))
done <<<"$OPS_VENDORED"

if [ "$CHECK" = 1 ]; then
  [ "$missing" = 0 ] || die "$missing script(s) missing or wrong — run deploy/ops-fetch.sh"
  echo "ops-fetch: all $ok script(s) present and match $OPS_VERSION" >&2
  exit 0
fi

[ "$fetched" = 0 ] \
  && echo "ops-fetch: $ok script(s) already at $OPS_VERSION" >&2 \
  || echo "ops-fetch: fetched $fetched, $ok already current ($OPS_VERSION)" >&2
