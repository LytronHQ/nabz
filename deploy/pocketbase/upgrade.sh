#!/usr/bin/env bash
#
# upgrade.sh — safely upgrade the self-hosted PocketBase to a new version, with a
# consistent pre-upgrade snapshot and automatic rollback on failure. Run ON the
# PocketBase host (like setup-pocketbase.sh).
#
#   ./deploy/pocketbase/upgrade.sh 0.29.0       # or v0.29.0
#
# Why a stop-then-snapshot (brief downtime): PocketBase is embedded SQLite with a
# WAL, so a live copy of pb_data is not a consistent snapshot. Stopping the
# container is the only way to get a copy we can actually roll back to. PocketBase
# auto-migrates pb_data when it starts on a newer binary, and once migrated you
# can't just downgrade the binary — so rollback restores BOTH the previous image
# AND the pre-upgrade pb_data snapshot.
#
# The local snapshot is the rollback source and rollback NEVER depends on a
# download. Offsite copy to R2 is an optional, async, best-effort step
# (PB_SNAPSHOT_UPLOAD_CMD) that never gates the upgrade or rollback.
#
# Env overrides: APP_DIR (/opt/monitors), ENV_FILE (/etc/monitors/pocketbase.env),
# PB_PORT (8090), SNAP_DIR (/var/backups/nabz-pocketbase), RETAIN (3),
# HEALTH_RETRIES (30), PB_SNAPSHOT_UPLOAD_CMD (offsite hook — receives the path).
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <target-version>   e.g. $0 0.29.0"; exit 1; }
TARGET="${TARGET#v}"   # accept v0.29.0 or 0.29.0

APP_DIR="${APP_DIR:-/opt/monitors}"
COMPOSE="$APP_DIR/deploy/pocketbase.yml"
ENV_FILE="${ENV_FILE:-/etc/monitors/pocketbase.env}"
PB_PORT="${PB_PORT:-8090}"
SNAP_DIR="${SNAP_DIR:-/var/backups/nabz-pocketbase}"
RETAIN="${RETAIN:-3}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

ts() { date -u +%FT%TZ; }
log() { echo "[upgrade $(ts)] $*"; }
die() { echo "[upgrade $(ts)] ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
command -v jq     >/dev/null 2>&1 || die "jq not found"
command -v curl   >/dev/null 2>&1 || die "curl not found"
[ -f "$COMPOSE" ]  || die "missing $COMPOSE (run on the PocketBase host)"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"

set -a; . "$ENV_FILE"; set +a
: "${PB_SUPERUSER_EMAIL:?set PB_SUPERUSER_EMAIL in $ENV_FILE}"
: "${PB_SUPERUSER_PASSWORD:?set PB_SUPERUSER_PASSWORD in $ENV_FILE}"
CURRENT="${PB_VERSION:-}"
[ -n "$CURRENT" ] || die "PB_VERSION not set in $ENV_FILE — can't determine the rollback version"

log "current=v$CURRENT  target=v$TARGET"
[ "$CURRENT" != "$TARGET" ] || { log "already on v$TARGET — nothing to do"; exit 0; }

cd "$APP_DIR"

# Real health check: PocketBase answers /api/health, AND a superuser can read a
# real collection (proves the DB migrated and is queryable — not just that the
# port is open).
health_ok() {
  curl -fsS "http://127.0.0.1:${PB_PORT}/api/health" >/dev/null 2>&1 || return 1
  local token
  token="$(curl -fsS "http://127.0.0.1:${PB_PORT}/api/collections/_superusers/auth-with-password" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg i "$PB_SUPERUSER_EMAIL" --arg p "$PB_SUPERUSER_PASSWORD" '{identity:$i,password:$p}')" \
    2>/dev/null | jq -r '.token // empty')"
  [ -n "$token" ] || return 1
  curl -fsS -o /dev/null \
    "http://127.0.0.1:${PB_PORT}/api/collections/monitors/records?perPage=1&skipTotal=true" \
    -H "Authorization: $token"
}
wait_healthy() {
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}

# Resolve what /pb_data is actually backed by, from the running container and
# before we stop it. It is a NAMED VOLUME on a plain `compose up` and a BIND
# MOUNT on prod, where it lives on the attached Hetzner Volume (#331).
#
# `.Name` is populated only for named volumes; a bind mount populates `.Source`
# and leaves `.Name` empty. Reading `.Name` alone would silently fall through to
# the compose default below and snapshot a stale — or freshly auto-created and
# EMPTY — volume, while every step downstream reported success.
mount_source() { # what the running container has at /pb_data (volume name or bind path)
  docker compose -f "$COMPOSE" ps -q pocketbase 2>/dev/null | xargs -r docker inspect \
    -f '{{ range .Mounts }}{{ if eq .Destination "/pb_data" }}{{ if .Name }}{{ .Name }}{{ else }}{{ .Source }}{{ end }}{{ end }}{{ end }}' 2>/dev/null || true
}
VOL="$(mount_source)"
VOL="${VOL:-monitors-pocketbase_pb_data}"
log "pb_data backed by: $VOL"

# After every `compose up` below, prove the container came back on the SAME
# storage we snapshotted. If deploy/.env is missing, ${PB_DATA_PATH:-pb_data}
# silently falls back to the named volume, and PocketBase starts on an EMPTY
# database that passes its liveness probe — the data is still on the volume,
# but the running system cannot see it.
assert_same_storage() { # context
  local now; now="$(mount_source)"
  [ "$now" = "$VOL" ] || die "pb_data moved during $1: was '$VOL', now '$now'. PocketBase is running against the WRONG storage — almost certainly a missing PB_DATA_PATH in $(dirname "$COMPOSE")/.env (setup-pocketbase.sh writes it). Your data is intact at '$VOL'; stop this container before it takes writes."
}

mkdir -p "$SNAP_DIR"
SNAP="$SNAP_DIR/pb_data-$(date -u +%Y%m%dT%H%M%SZ)-v${CURRENT}.tar.gz"

# --- 1. stop for a consistent snapshot (brief downtime, on purpose) ----------
log "stopping pocketbase for a consistent snapshot"
docker compose -f "$COMPOSE" stop pocketbase

# --- 2. snapshot pb_data (the rollback source) -------------------------------
log "snapshotting pb_data -> $SNAP"
docker run --rm -v "$VOL":/data:ro -v "$SNAP_DIR":/backup alpine \
  tar czf "/backup/$(basename "$SNAP")" -C /data . \
  || die "snapshot failed — aborting BEFORE any upgrade (pocketbase still on v$CURRENT; start it with: docker compose -f $COMPOSE up -d)"

# `tar` exits 0 on an empty directory, so a successful exit is NOT evidence the
# snapshot contains anything. If the mount source resolved wrongly we would tar
# nothing, print a small size, and carry on into an upgrade with no rollback
# source. Assert the snapshot actually holds a database before trusting it.
SNAP_BYTES="$(stat -c %s "$SNAP" 2>/dev/null || echo 0)"
# Read the listing into a variable rather than piping into `grep -q`: grep exits
# on the first match, tar gets SIGPIPE for the entries it hasn't written yet, and
# `set -o pipefail` turns that into exit 141 — so the assertion would fail on a
# perfectly good snapshot whenever data.db isn't the LAST entry in the archive.
# Caught on a throwaway Hetzner host, where the order is …/types.d.ts/data.db/lost+found.
SNAP_LIST="$(tar tzf "$SNAP" 2>/dev/null || true)"
case "$SNAP_LIST" in
  *data.db*) : ;;
  *)
    rm -f "$SNAP"
    die "snapshot contains no data.db (source '$VOL' looks wrong or empty) — aborting BEFORE any upgrade. pocketbase is still on v$CURRENT; start it with: docker compose -f $COMPOSE up -d"
    ;;
esac
if [ "$SNAP_BYTES" -lt "${PB_SNAPSHOT_MIN_BYTES:-65536}" ]; then
  rm -f "$SNAP"
  die "snapshot is implausibly small (${SNAP_BYTES}B from '$VOL') — aborting BEFORE any upgrade. Override with PB_SNAPSHOT_MIN_BYTES if this is genuinely a tiny instance."
fi
log "snapshot done ($(du -h "$SNAP" | cut -f1), contains data.db)"

# 2b. optional offsite copy — async, best-effort, NEVER gates rollback.
if [ -n "${PB_SNAPSHOT_UPLOAD_CMD:-}" ]; then
  log "offsite upload (async): $PB_SNAPSHOT_UPLOAD_CMD $SNAP"
  ( eval "$PB_SNAPSHOT_UPLOAD_CMD \"$SNAP\"" >/dev/null 2>&1 \
      && echo "[upgrade $(ts)] offsite upload done" \
      || echo "[upgrade $(ts)] offsite upload failed (local snapshot is intact)" ) &
fi

rollback() {
  log "ROLLBACK -> v$CURRENT (restoring previous image + pb_data snapshot)"
  docker compose -f "$COMPOSE" stop pocketbase || true
  # Wipe the volume and restore the snapshot into it.
  docker run --rm -v "$VOL":/data -v "$SNAP_DIR":/backup alpine \
    sh -c 'rm -rf /data/* /data/..?* 2>/dev/null; tar xzf "/backup/'"$(basename "$SNAP")"'" -C /data' \
    || die "RESTORE FAILED — snapshot is at $SNAP; restore it manually before restarting"
  PB_VERSION="$CURRENT" docker compose -f "$COMPOSE" up -d --build pocketbase
  assert_same_storage "rollback"
  if wait_healthy; then
    log "rollback healthy on v$CURRENT"
  else
    die "ROLLBACK started v$CURRENT but health did not recover — MANUAL INTERVENTION NEEDED (snapshot: $SNAP)"
  fi
}

# --- 3. start the new version (PocketBase auto-migrates on start) ------------
log "starting pocketbase v$TARGET (auto-migrating pb_data)"
if ! PB_VERSION="$TARGET" docker compose -f "$COMPOSE" up -d --build pocketbase; then
  log "compose up failed for v$TARGET"
  rollback
  exit 1
fi
assert_same_storage "the upgrade to v$TARGET"

# --- 4. verify: real read against a collection, with retries -----------------
if wait_healthy; then
  log "v$TARGET healthy (collection read OK)"
else
  log "v$TARGET failed the health check after $HEALTH_RETRIES tries"
  rollback
  exit 1
fi

# --- 5. persist the new version so future (re)deploys use it -----------------
if grep -q '^PB_VERSION=' "$ENV_FILE"; then
  sed -i "s/^PB_VERSION=.*/PB_VERSION=${TARGET}/" "$ENV_FILE"
else
  echo "PB_VERSION=${TARGET}" >> "$ENV_FILE"
fi
log "pinned PB_VERSION=$TARGET in $ENV_FILE"
log "REMINDER: also bump PB_VERSION to $TARGET in deploy/environments/<env>.vars,"
log "          or the next 'remote-deploy.sh prod' will push v$CURRENT back."

# --- 6. retain the last N snapshots -----------------------------------------
# shellcheck disable=SC2012
ls -1t "$SNAP_DIR"/pb_data-*.tar.gz 2>/dev/null | tail -n +$((RETAIN + 1)) | xargs -r rm -f
log "retained the last $RETAIN snapshot(s) in $SNAP_DIR"
log "upgrade complete: v$CURRENT -> v$TARGET"
