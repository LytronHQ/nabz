# shellcheck shell=bash
# pb-db-steps.sh — the deploy's steps that touch PocketBase's database files,
# done without ever opening them alongside the running server. Sourced by
# setup-pocketbase.sh; deploy/pb_live_db_test.sh drives these against a real
# PocketBase.
#
# Why this file exists (#520): a PocketBase backup closes descriptors to
# data.db-shm/-wal, which releases the server's POSIX locks on them. Any other
# process that opens the database after that — `sqlite3`, or a second
# `pocketbase superuser upsert --dir /pb_data` — believes it is the last
# connection and, on exit, DELETES the WAL and -shm the server still has open.
# On 2026-10-10 a deploy did exactly that hours after a backup, and every
# production read failed until PocketBase was restarted on a repaired file.
#
# So: read what can be read without SQLite (the file header), do what can be
# done through the API (superuser login), and do the rest only with the server
# STOPPED.
#
# The caller provides, as functions:
#   pb_stop                 stop the PocketBase server
#   pb_start                start it again and wait until it answers
#   pb_run_offline ENTRY ARGS…  run ENTRY (pocketbase | sqlite3) against /pb_data
#                           in a throwaway container while the server is stopped
#   pb_exec ARGS…           run a command in the running server's container
# and the variables PB_BASE (http://addr:port), PB_SUPERUSER_EMAIL/_PASSWORD.

# pb_vacuum_mode -> 0 none, 1 full, 2 incremental; empty when unreadable.
# Straight from the SQLite header: bytes 52-55 are the largest root b-tree page,
# non-zero only with auto-vacuum on; bytes 64-67 are non-zero for incremental.
# `od` reads the file without SQLite, so it takes no lock and deletes nothing.
pb_vacuum_mode() {
	local b
	b="$(pb_exec od -An -tu1 -j52 -N16 /pb_data/data.db 2>/dev/null | tr -s ' \n' ' ')" || return 0
	# shellcheck disable=SC2086
	set -- $b
	[ "$#" -ge 16 ] || return 0
	if [ $(($1 + $2 + $3 + $4)) -eq 0 ]; then echo 0
	elif [ $((${13} + ${14} + ${15} + ${16})) -ne 0 ]; then echo 2
	else echo 1
	fi
}

# pb_superuser_ok — can the configured superuser log in? Through the API, so it
# opens nothing.
pb_superuser_ok() {
	local token
	token="$(curl -fsS --max-time 15 "${PB_BASE%/}/api/collections/_superusers/auth-with-password" \
		-H 'Content-Type: application/json' \
		-d "$(jq -nc --arg i "$PB_SUPERUSER_EMAIL" --arg p "$PB_SUPERUSER_PASSWORD" '{identity:$i,password:$p}')" \
		2>/dev/null | jq -r '.token // empty')" || return 1
	[ -n "$token" ]
}

# pb_ensure_superuser — the superuser exists with the configured password.
# The normal deploy finds it already does and touches nothing. Only a fresh
# instance, or a changed password, needs the CLI — and the CLI opens the
# database, so it runs with the server stopped.
pb_ensure_superuser() {
	if pb_superuser_ok; then
		echo "· superuser ($PB_SUPERUSER_EMAIL) already logs in"
		return 0
	fi
	echo "==> setting superuser ($PB_SUPERUSER_EMAIL) — PocketBase stopped meanwhile"
	pb_stop
	local rc=0
	pb_run_offline pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb_data || rc=$?
	pb_start
	[ "$rc" = 0 ] || { echo "   superuser upsert failed (exit $rc)"; return "$rc"; }
	pb_superuser_ok || { echo "   the superuser still cannot log in after the upsert"; return 1; }
}

# pb_ensure_incremental_vacuum MAX_BYTES — one-time conversion of a small
# database to incremental auto-vacuum (#322). The conversion is a full VACUUM,
# so it runs with the server stopped; a database that is already incremental,
# or too big to rewrite on a deploy, is left alone.
pb_ensure_incremental_vacuum() {
	local max="$1" mode bytes
	mode="$(pb_vacuum_mode)"
	case "$mode" in
		2) echo "· auto_vacuum already INCREMENTAL"; return 0 ;;
		"") echo "· skipping auto_vacuum conversion (could not read the database header)"; return 0 ;;
	esac
	bytes="$(pb_exec sh -c 'wc -c < /pb_data/data.db' 2>/dev/null | tr -d ' ')"
	if [ "${bytes:-0}" -gt "$max" ]; then
		echo "!! auto_vacuum is '$mode', not INCREMENTAL, and this database is ${bytes}B."
		echo "   NOT converting: the full VACUUM that needs would stop PocketBase for the whole"
		echo "   rewrite. Do it in a maintenance window."
		return 0
	fi
	echo "==> converting to auto_vacuum=INCREMENTAL (one-time full VACUUM, db is ${bytes}B) — PocketBase stopped meanwhile"
	pb_stop
	local rc=0
	pb_run_offline sqlite3 /pb_data/data.db 'PRAGMA auto_vacuum = INCREMENTAL; VACUUM;' || rc=$?
	pb_start
	[ "$rc" = 0 ] && echo "   converted (mode now $(pb_vacuum_mode))" \
		|| echo "   WARN: conversion failed (exit $rc) — maintenance will skip the vacuum and say so"
	return 0
}
