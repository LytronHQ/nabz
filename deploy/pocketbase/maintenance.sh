#!/usr/bin/env bash
#
# maintenance.sh — the recurring PocketBase maintenance run (#322). Installed on
# the PocketBase host by setup-pocketbase.sh and fired by a systemd timer.
#
#   ./maintenance.sh            # checkpoint, bounded vacuum, backup
#   ./maintenance.sh --no-backup   # the SQLite half only
#
# Four steps, and the ORDER is load-bearing:
#
#   1. PRAGMA wal_checkpoint(TRUNCATE) — fold the WAL back into the main file and
#      reset it, so the backup does not depend on WAL state and the WAL cannot
#      grow without bound.
#   2. PRAGMA incremental_vacuum(N)    — reclaim free pages, bounded by an explicit
#      page count so every run is short and predictable.
#   3. Trigger PocketBase's own backup   — its API, so the snapshot is consistent
#      and restorable through the normal restore path.
#   4. …which uploads straight to R2, because backups.s3 is configured.
#
# Vacuum BEFORE backup. Reversed, the archive captures dead pages: bigger upload,
# slower restore, and the bloat comes straight back in. The checkpoint has to come
# first so the pages the vacuum reclaims are actually in the main file.
#
# There is deliberately NO recurring full VACUUM. It takes an exclusive lock for
# its whole duration, rewrites the entire file, and needs free disk equal to the
# database size — at the 5,000-monitor projection that is a multi-minute write
# stall with every probe result and alert blocked behind it. The full VACUUM
# happens exactly once, at provisioning, and never again.
#
# There is also deliberately NO retention here. R2 lifecycle expiry already prunes
# the bucket; a second policy against the same bucket is how backups get deleted
# early.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/monitors/pocketbase.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

CONTAINER="${PB_CONTAINER:-pocketbase}"
DB="${PB_DB_PATH:-/pb_data/data.db}"
PB_PORT="${PB_PORT:-8090}"
# One run reclaims at most this many pages. 20k 4KiB pages ≈ 80 MiB, which is
# seconds of work; the next run picks up where this one stopped.
VACUUM_PAGES="${PB_VACUUM_PAGES:-20000}"
# Wait rather than failing instantly when PocketBase holds a write lock — under
# WAL the checkpoint only needs a quiet moment, not an idle database.
BUSY_MS="${PB_SQLITE_BUSY_MS:-15000}"
DO_BACKUP=1
[ "${1:-}" = "--no-backup" ] && DO_BACKUP=0

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || die "container '$CONTAINER' is not running"

sql() { docker exec "$CONTAINER" sqlite3 -cmd ".timeout $BUSY_MS" "$DB" "$1"; }

# --- 1. checkpoint -----------------------------------------------------------
# Returns "busy blocked checkpointed"; a non-zero first column means it could not
# fully reset the WAL because a reader was mid-transaction. Not fatal — the next
# run gets it — but say so, because a WAL that never truncates is worth noticing.
log "checkpoint: folding the WAL into $DB"
ck="$(sql 'PRAGMA wal_checkpoint(TRUNCATE);' || true)"
log "  wal_checkpoint(TRUNCATE) -> ${ck:-<no result>} (busy blocked checkpointed)"
case "$ck" in
  0\|*) : ;;
  "")   log "  WARN: no result from the checkpoint" ;;
  *)    log "  WARN: checkpoint was blocked — the WAL was not truncated this run" ;;
esac

# --- 2. bounded incremental vacuum -------------------------------------------
mode="$(sql 'PRAGMA auto_vacuum;' || echo '')"
case "$mode" in
  2) freelist_before="$(sql 'PRAGMA freelist_count;' || echo '?')"
     log "vacuum: reclaiming up to $VACUUM_PAGES page(s) (freelist $freelist_before)"
     sql "PRAGMA incremental_vacuum($VACUUM_PAGES);" >/dev/null || die "incremental_vacuum failed"
     log "  freelist now $(sql 'PRAGMA freelist_count;' || echo '?')" ;;
  *) # Mode 0 = none, 1 = full. incremental_vacuum is a no-op in either, silently.
     log "vacuum: SKIPPED — auto_vacuum is '${mode:-unknown}', not INCREMENTAL(2)."
     log "  This database was not converted at provisioning. Converting needs a full"
     log "  VACUUM, which rewrites the whole file — do it during a maintenance"
     log "  window, not from this timer. See deploy/pocketbase/README.md." ;;
esac

# --- 3+4. backup, straight to R2 ---------------------------------------------
if [ "$DO_BACKUP" = 1 ]; then
  [ -n "${PB_SUPERUSER_EMAIL:-}" ] && [ -n "${PB_SUPERUSER_PASSWORD:-}" ] \
    || die "PB_SUPERUSER_EMAIL/PASSWORD missing from $ENV_FILE — cannot trigger a backup"
  base="http://127.0.0.1:${PB_PORT}"
  token="$(curl -fsS "$base/api/collections/_superusers/auth-with-password" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"identity":"%s","password":"%s"}' "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD")" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || die "superuser auth failed"

  name="nabz-$(date -u +%Y%m%d-%H%M%S).zip"
  log "backup: requesting $name"
  code="$(curl -sS -o /tmp/pb_backup.out -w '%{http_code}' -X POST "$base/api/backups" \
    -H "Authorization: $token" -H 'Content-Type: application/json' \
    -d "$(printf '{"name":"%s"}' "$name")")"
  case "$code" in
    200|204) log "  backup created (uploaded to R2 when backups.s3 is enabled)" ;;
    *) die "backup request returned HTTP $code: $(cat /tmp/pb_backup.out)" ;;
  esac
fi

# --- make failure visible ----------------------------------------------------
# A silent backup failure is indistinguishable from no backup, and this runs
# unattended on a host nobody watches. The ping only happens on the success path,
# so the external monitor alerts on SILENCE — the same dead-man shape the
# evaluator uses, rather than a notification that itself has to be delivered.
if [ -n "${PB_MAINTENANCE_PING_URL:-}" ]; then
  curl -fsS --max-time 10 "$PB_MAINTENANCE_PING_URL" >/dev/null 2>&1 \
    && log "pinged the maintenance heartbeat" \
    || log "WARN: maintenance heartbeat ping failed"
fi

log "maintenance complete"
