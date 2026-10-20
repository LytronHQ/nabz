#!/usr/bin/env bash
#
# upgrade.sh — upgrade this host's PocketBase to a new version, with a consistent
# pre-upgrade snapshot and automatic rollback. Run ON the PocketBase host (like
# setup-pocketbase.sh).
#
#   ./deploy/pocketbase/upgrade.sh 0.29.0       # or v0.29.0
#
# The mechanism belongs to the `upgrade` module of LytronHQ/ops, vendored at
# deploy/.ops/container.sh, fetched from the release pinned in deploy/ops.lock.
# This is the nabz half: where
# the compose file, the env file and the snapshots live. Do not edit the module
# here — deploy/ops_vendor_test.sh fails if you do.
#
# Why a stop-then-snapshot (brief downtime): PocketBase is embedded SQLite with a
# WAL, so a live copy of pb_data is not a consistent snapshot. Stopping the
# container is the only way to get a copy we can actually roll back to. And
# PocketBase auto-migrates pb_data when it starts on a newer binary — once
# migrated, the old binary cannot read it — so rollback restores BOTH the previous
# image AND the pre-upgrade snapshot. The local snapshot is the rollback source;
# rollback never depends on a download.
#
# --build, not a pull: deploy/pocketbase.yml builds from deploy/pocketbase/
# Dockerfile with PB_VERSION as a build argument and tags
# nabz-pocketbase:${PB_VERSION}. There is no published image to fetch.
#
# If PB_SHA256 is pinned in the env file it pins the CURRENT version's zip, and
# this changes only PB_VERSION — so the build will fail `sha256sum -c` until you
# update the hash too. That is deliberate: a pinned hash that silently stopped
# matching would be worse.
#
# Env overrides: APP_DIR (/opt/monitors), ENV_FILE (/etc/monitors/pocketbase.env),
# PB_PORT (8090), SNAP_DIR (/var/backups/nabz-pocketbase), RETAIN (3),
# HEALTH_RETRIES (30), PB_SNAPSHOT_UPLOAD_CMD (offsite hook — receives the path).
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <target-version>   e.g. $0 0.29.0"; exit 1; }
TARGET="${TARGET#v}"   # accept v0.29.0 or 0.29.0

APP_DIR="${APP_DIR:-/opt/monitors}"
ENV_FILE="${ENV_FILE:-/etc/monitors/pocketbase.env}"
PB_PORT="${PB_PORT:-8090}"
SNAP_DIR="${SNAP_DIR:-/var/backups/nabz-pocketbase}"
RETAIN="${RETAIN:-3}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

MODULE="$APP_DIR/deploy/.ops/container.sh"
[ -x "$MODULE" ] || { echo "error: $MODULE is missing or not executable" >&2; exit 1; }

# An array, so an unset PB_SNAPSHOT_UPLOAD_CMD passes nothing rather than an
# empty argument the module would reject. An if, not `[ … ] && hook=(…)`: under
# set -e that one-liner returns 1 on the common path and kills the script.
# Where PocketBase answers on this host. Production binds it to the private
# address only (PB_BIND_IP, e.g. 10.0.0.2), so 127.0.0.1 gets connection refused:
# the post-upgrade health check would fail every time and roll a good upgrade
# back (#620). Read the bind address from the env file the container runs with,
# as the module does, and fall back to loopback where nothing is set.
PB_HOST="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PB_BIND_IP=//p" "$ENV_FILE" 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']$//")"
PB_URL_LOCAL="http://${PB_HOST:-127.0.0.1}:${PB_PORT}"

hook=()
if [ -n "${PB_SNAPSHOT_UPLOAD_CMD:-}" ]; then
  hook=(--after-snapshot "$PB_SNAPSHOT_UPLOAD_CMD")
fi

exec "$MODULE" upgrade \
  --app pocketbase \
  --compose "$APP_DIR/deploy/pocketbase.yml" \
  --service pocketbase \
  --to "$TARGET" \
  --env-file "$ENV_FILE" \
  --credentials-file "$ENV_FILE" \
  --url "$PB_URL_LOCAL" \
  --health-url "$PB_URL_LOCAL/api/health" \
  --health-collection monitors \
  --health-retries "$HEALTH_RETRIES" \
  --snapshots "$SNAP_DIR" \
  --keep "$RETAIN" \
  --build \
  "${hook[@]}"
