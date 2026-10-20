#!/usr/bin/env bash
# pb_live_db_test.sh — the deploy's database steps and the nightly maintenance,
# against a REAL PocketBase (nabz's own image), after a backup.
#
#   ./deploy/pb_live_db_test.sh            (needs docker; downloads PocketBase once)
#
# The 2026-10-10 production outage (#520): a PocketBase backup releases the
# server's POSIX locks on data.db-shm/-wal, and the next process that opens the
# database from outside deletes the WAL and -shm the server still has open.
# Every read then failed. Stubs cannot reproduce that — it is the kernel's lock
# semantics — so this runs the real thing and asserts, through /proc, that the
# server never ends up holding a deleted database file:
#   0. the detector works: after a backup, a deliberate outside sqlite3 DOES
#      leave the server holding deleted files (otherwise every check below
#      would pass vacuously). On PocketBase 0.28.4, the last version known to
#      show it: 0.40.5 no longer does (its backups changed in 0.38), so the
#      detector is proven where the hazard exists (#620)
#   0b. on the version this repo runs, the same deliberate sequence leaves
#      nothing deleted. If a later PocketBase brings the hazard back, this says
#      so; the rule against outside processes stands either way
#   1. a fresh instance: the superuser is created and auto_vacuum converted,
#      both with the server stopped
#   2. after a backup: the deploy's steps change nothing on disk, and the
#      server holds no deleted file
#   3. after a backup: the nightly maintenance, twice, leaves no deleted file,
#      folds the WAL in, and takes its backups
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo "needs docker" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "needs jq" >&2; exit 2; }

IMG="${PB_TEST_IMAGE:-nabz-pocketbase-test:latest}"
NAME="pblive-$$"
W="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" "$NAME-probe" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

docker build -q -t "$IMG" "$HERE/pocketbase" >/dev/null
# The last PocketBase known to drop its locks on a backup (#520), for step 0 only.
DETECTOR_PB_VERSION=0.28.4
DETECTOR_IMG="nabz-pocketbase-test:$DETECTOR_PB_VERSION"
docker build -q --build-arg PB_VERSION="$DETECTOR_PB_VERSION" -t "$DETECTOR_IMG" "$HERE/pocketbase" >/dev/null

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
export PB_BASE="http://127.0.0.1:${PORT}"
export PB_SUPERUSER_EMAIL="admin@pblive.test"
export PB_SUPERUSER_PASSWORD='p"ss \ w0rd-123456'

start_pb() { # name [image]
	docker run -d --name "$1" -p "127.0.0.1:${PORT}:8090" "${2:-$IMG}" >/dev/null
	wait_pb
}
wait_pb() {
	local _
	for _ in $(seq 1 60); do curl -fsS -o /dev/null "$PB_BASE/api/health" 2>/dev/null && return 0; sleep 1; done
	fail "PocketBase did not answer on $PB_BASE"
}
# Database files the server process holds open but that are gone from disk.
deleted_fds() { docker exec "$CUR" sh -c 'ls -l /proc/1/fd 2>/dev/null' | grep pb_data | grep -c '(deleted)' || true; }
token() {
	curl -fsS "$PB_BASE/api/collections/_superusers/auth-with-password" -H 'Content-Type: application/json' \
		-d "$(jq -nc --arg i "$PB_SUPERUSER_EMAIL" --arg p "$PB_SUPERUSER_PASSWORD" '{identity:$i,password:$p}')" | jq -r .token
}
backup() { # name
	local code
	code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: $(token)" \
		-H 'Content-Type: application/json' -d "{\"name\":\"$1\"}" "$PB_BASE/api/backups")"
	[ "$code" = 204 ] || fail "backup $1 returned HTTP $code"
}
# Some traffic, so the server's pool holds connections the way production does.
load() { (for _ in $(seq 1 40); do curl -s -o /dev/null "$PB_BASE/api/collections/_superusers/records?perPage=1" -H "Authorization: $1"; sleep 0.1; done) & }

# The hooks pb-db-steps.sh expects, for a plain container instead of compose.
pb_exec() { docker exec "$CUR" "$@"; }
pb_stop() { docker stop -t 20 "$CUR" >/dev/null; }
pb_start() { docker start "$CUR" >/dev/null; wait_pb; }
# Every offline run is recorded: a routine deploy must not need one.
OFFLINE_RUNS="$W/offline"; : > "$OFFLINE_RUNS"
pb_run_offline() {
	echo "$*" >> "$OFFLINE_RUNS"
	local e="$1"; shift
	docker run --rm --volumes-from "$CUR" --entrypoint "$e" "$IMG" "$@"
}
# shellcheck source=pb-db-steps.sh
. "$HERE/pb-db-steps.sh"

# A backup, then a deliberate outside sqlite3: the #520 sequence.
outside_sqlite_after_backup() { # image
	CUR="$NAME-probe"; start_pb "$CUR" "$1"
	docker exec "$CUR" /usr/local/bin/pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb_data >/dev/null
	T="$(token)"; load "$T"; sleep 1
	backup probe.zip; sleep 1
	docker exec "$CUR" sqlite3 /pb_data/data.db 'PRAGMA user_version;' >/dev/null
	sleep 1
}

echo "== 0. the detector: an outside sqlite3 after a backup leaves deleted files (PocketBase $DETECTOR_PB_VERSION) =="
outside_sqlite_after_backup "$DETECTOR_IMG"
[ "$(deleted_fds)" -gt 0 ] || fail "the detector saw nothing: on $DETECTOR_PB_VERSION an outside sqlite3 after a backup should leave the server holding deleted files"
wait; docker rm -f "$CUR" >/dev/null

echo "== 0b. the version this repo runs: the same sequence leaves nothing deleted =="
outside_sqlite_after_backup "$IMG"
[ "$(deleted_fds)" = 0 ] || fail "this PocketBase still drops its locks on a backup (#520): an outside sqlite3 left deleted files"
wait; docker rm -f "$CUR" >/dev/null

echo "== 1. a fresh instance: superuser and auto_vacuum, with the server stopped =="
CUR="$NAME"; start_pb "$CUR"
out="$(pb_ensure_incremental_vacuum 52428800)"; echo "$out" | sed 's/^/   /'
[ "$(pb_vacuum_mode)" = 2 ] || fail "auto_vacuum was not converted to INCREMENTAL: $out"
out="$(pb_ensure_superuser)"; echo "$out" | sed 's/^/   /'
pb_superuser_ok || fail "the superuser cannot log in after pb_ensure_superuser"
grep -q 'superuser upsert' "$OFFLINE_RUNS" || fail "a fresh instance should create the superuser offline"
[ "$(deleted_fds)" = 0 ] || fail "deleted files after the fresh-instance steps"

echo "== 2. after a backup: the deploy's steps open nothing =="
T="$(token)"; load "$T"; sleep 1
backup after-1.zip; sleep 1
: > "$OFFLINE_RUNS"
mode="$(pb_vacuum_mode)"; [ "$mode" = 2 ] || fail "pb_vacuum_mode read '$mode', want 2"
pb_ensure_incremental_vacuum 52428800 | sed 's/^/   /'
pb_ensure_superuser | sed 's/^/   /'
[ ! -s "$OFFLINE_RUNS" ] || fail "a routine deploy stopped PocketBase to run: $(cat "$OFFLINE_RUNS")"
sleep 1
[ "$(deleted_fds)" = 0 ] || fail "after a backup, the deploy's steps left the server holding $(deleted_fds) deleted file(s)"

echo "== 3. after a backup: the nightly maintenance, twice =="
printf 'PB_SUPERUSER_EMAIL=%s\nPB_SUPERUSER_PASSWORD=%s\n' "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" > "$W/creds"
"$HERE/ops-fetch.sh" --check >/dev/null 2>&1 || "$HERE/ops-fetch.sh" >/dev/null
for night in 1 2; do
	load "$T"
	bash "$HERE/.ops/db.sh" maintain --app pocketbase --url "$PB_BASE" --credentials-file "$W/creds" \
		--backup-prefix "night$night" > "$W/maint.log" 2>&1 || fail "maintenance night $night failed: $(cat "$W/maint.log")"
	sleep 1
	[ "$(deleted_fds)" = 0 ] || fail "after maintenance night $night the server holds $(deleted_fds) deleted file(s): $(cat "$W/maint.log")"
done
n="$(curl -fsS -H "Authorization: $(token)" "$PB_BASE/api/backups" | jq '[.[] | select(.key | startswith("night"))] | length')"
[ "$n" = 2 ] || fail "want 2 maintenance backups, found $n"
curl -fsS -o /dev/null -H "Authorization: $(token)" "$PB_BASE/api/collections/_superusers/records?perPage=1" \
	|| fail "PocketBase no longer answers a read after the maintenance runs"

echo "PASS: pb_live_db_test.sh"
