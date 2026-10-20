# Self-hosted PocketBase

PocketBase built from the **official pinned release binary** (`Dockerfile`), run
by [`../pocketbase.yml`](../pocketbase.yml) and bootstrapped by
[`../setup-pocketbase.sh`](../setup-pocketbase.sh) — schema import, service
accounts, and app settings (name/URL, SMTP, R2 backups), all from env, no
admin-UI clicks.

## Build

`PB_VERSION` (and optionally `PB_SHA256`) pin the release the image is built from:

```bash
PB_VERSION=0.40.5 docker compose -f deploy/pocketbase.yml build
```

## Upgrading — `upgrade.sh`

Bumping `PB_VERSION` and redeploying works, but PocketBase **auto-migrates
`pb_data` when it starts on a newer binary**, and once migrated you can't just
downgrade the binary. So upgrades go through a script that snapshots first and
rolls back automatically on failure. Run it **on the PocketBase host**:

```bash
./deploy/pocketbase/upgrade.sh 0.29.0
```

What it does:

1. **Stops** the container and takes a **consistent snapshot** of `pb_data`
   (SQLite + WAL means a live copy isn't consistent — the brief downtime is the
   price of a snapshot you can actually restore). The local snapshot under
   `/var/backups/nabz-pocketbase` is the rollback source; rollback never depends
   on a download. An optional `PB_SNAPSHOT_UPLOAD_CMD` copies it offsite (e.g. to
   R2) asynchronously and never gates the upgrade.

   The snapshot source is resolved from the running container's mounts, handling
   **both** shapes: a named volume on a plain `compose up` (`.Name`) and the bind
   mount onto the attached Hetzner Volume on prod (`.Source`, since a bind mount
   leaves `.Name` empty). It then **asserts the snapshot contains `data.db` and
   is not implausibly small** before going anywhere near the upgrade — `tar`
   exits 0 on an empty directory, so a successful exit is not on its own evidence
   that anything was captured. A snapshot that tars the wrong source and reports
   success is worse than no snapshot at all. Override the size floor with
   `PB_SNAPSHOT_MIN_BYTES` on a genuinely tiny instance.
2. Starts the **new version** (`up -d --build`), which auto-migrates.
3. **Verifies** with a real read: superuser auth + a `monitors` collection query,
   retried with a timeout — not just a port check.
4. On failure, **rolls back both** the previous image **and** the `pb_data`
   snapshot (an old binary on a migrated schema would be broken), and exits
   non-zero.
5. On success, pins `PB_VERSION` in the host env file and **retains the last 3**
   snapshots. Every step is logged.

> After a successful upgrade, also bump `PB_VERSION` in `deploy/environments/<env>.vars` on your
> laptop — otherwise the next `remote-deploy.sh prod` pushes the old version back.

Overridable env: `SNAP_DIR`, `RETAIN`, `HEALTH_RETRIES`, `PB_PORT`, `ENV_FILE`,
`APP_DIR`, `PB_SNAPSHOT_UPLOAD_CMD`.

The mechanism is `container.sh upgrade`, the `upgrade` module of
[LytronHQ/ops](https://github.com/LytronHQ/ops). It is not in this repo: it is
fetched into `deploy/.ops/` from the release pinned in [`../ops.lock`](../ops.lock)
and shipped to the node by `remote-deploy.sh`. Do not edit the fetched copy —
`deploy/ops-fetch.sh` replaces anything whose hash does not match. `upgrade.sh` in
this folder is the nabz half: where the compose file, the env file and the snapshots
live.

`--build`, not a pull: `pocketbase.yml` builds from `pocketbase/Dockerfile` with
`PB_VERSION` as a build argument and tags `nabz-pocketbase:${PB_VERSION}`. There is
no published image to fetch.

**If `PB_SHA256` is pinned**, it pins the *current* version's zip, and an upgrade
changes only `PB_VERSION` — so the build fails `sha256sum -c` until you update the
hash too. Deliberate: a pinned hash that silently stopped matching would be worse.

## Maintenance and backups (#322)

`db.sh maintain` runs nightly on the PocketBase host via the
`nabz-pb-maintenance` systemd timer, installed by `setup-pocketbase.sh`. It is
the `database` module of [LytronHQ/ops](https://github.com/LytronHQ/ops), fetched
into `deploy/.ops/` from the release pinned in [`../ops.lock`](../ops.lock) rather
than committed here, and shipped to the node by `remote-deploy.sh`. Do not edit the
fetched copy — `deploy/ops-fetch.sh` replaces anything whose hash does not match.
The flags live in the unit the setup script writes. Four steps, and the order matters:

1. `PRAGMA wal_checkpoint(TRUNCATE)` — fold the WAL into the main file so the
   backup does not depend on WAL state and the WAL cannot grow unbounded.
2. `PRAGMA incremental_vacuum(N)` — reclaim free pages, **bounded**
   (`--vacuum-pages`, default 20,000 ≈ 80 MiB) so each run is short and predictable.
3. Trigger PocketBase's own backup via its API, so the archive restores through
   the normal path.
4. Which uploads straight to R2, because `backups.s3` is configured.

**Vacuum before backup.** Reversed, the archive captures dead pages: bigger
upload, slower restore, and the bloat returns on restore.

### Where the credentials and the heartbeat come from

The module takes both as **files**, read as data:

| | |
|---|---|
| `--credentials-file` | `/etc/monitors/pocketbase.env`, for `PB_SUPERUSER_EMAIL` / `_PASSWORD` |
| `--heartbeat-url-file` | `/etc/monitors/pb-heartbeat.url`, mode 0600, written by `setup-pocketbase.sh` from `PB_MAINTENANCE_PING_URL` |

That is not cosmetic. The script this replaced **sourced** the env file, which made
every value in it shell code, built the auth JSON with `printf` — so a password
containing `"` misauthenticated — and passed the password in `curl`'s arguments,
where every user on the host can read it through `ps`. The heartbeat URL is a
credential too: anyone holding it can keep the dead-man's switch quiet.

If `PB_MAINTENANCE_PING_URL` is unset, the setup script **removes** the file rather
than leaving it. A stale one would keep pinging after the heartbeat was deleted,
which is worse than no heartbeat — the monitor stays green over a host doing nothing.

**There is no recurring full `VACUUM`, deliberately.** It holds an exclusive lock
for its whole duration, rewrites the entire file, and needs free disk equal to the
database size — a multi-minute write stall at the 5,000-monitor projection, with
every probe result and alert blocked behind it.

### The one-time conversion

`incremental_vacuum` does nothing unless `auto_vacuum` is `INCREMENTAL`, and
switching modes requires a full `VACUUM`. `setup-pocketbase.sh` does this
automatically **only while the database is still small** (`PB_CONVERT_MAX_BYTES`,
50 MiB): free on a fresh instance, a write stall on a populated one.

A database that missed the window keeps working — `db.sh maintain` reads the mode
and skips the vacuum with an explanation rather than silently doing nothing. To
convert later, pick a maintenance window and run it with **PocketBase stopped** —
never with `docker exec` into the running container:

```bash
cd /opt/monitors
docker compose -f deploy/pocketbase.yml stop pocketbase
docker compose -f deploy/pocketbase.yml run --rm --no-deps --entrypoint sqlite3 pocketbase \
  /pb_data/data.db 'PRAGMA auto_vacuum = INCREMENTAL; VACUUM;'
docker compose -f deploy/pocketbase.yml start pocketbase
```

### Never open the live database from outside

No `sqlite3`, no `pocketbase … --dir /pb_data`, nothing that opens `pb_data`
while PocketBase is running. A PocketBase backup closes descriptors to
`data.db-shm`/`-wal`, which releases the server's POSIX locks on them; the next
outside process to open the database then believes it is the last connection
and **deletes the WAL and `-shm` the server is still using**. Writes that were
only in the WAL are lost on the next restart, and every query starts failing.
That took production down on 2026-10-10
([#520](https://github.com/LytronHQ/nabz-internal/issues/520)) — a deploy's
`superuser upsert`, hours after a backup.

So the deploy reads the vacuum mode from the file header and logs the superuser
in through the API (`deploy/pb-db-steps.sh`), and only stops PocketBase when it
genuinely has to touch the files; `db.sh maintain` folds the WAL in through
PocketBase's own `__pbDBOptimize__` job. `deploy/pb_live_db_test.sh` checks all of
it against a real PocketBase, after a backup.

If it happens anyway — PocketBase answering every read with *"Something went
wrong"* — check `ls -l /proc/$(docker inspect -f '{{.State.Pid}}' <pb>)/fd` for
`(deleted)` database files. **Do not restart first**: copy the deleted WAL out
through `/proc/<pid>/fd/<n>` before anything else, then merge it into a copy of
`data.db` and check `PRAGMA integrity_check` there. A restart throws the only copy
away.

### Retention lives in exactly one place

R2 lifecycle expiry on `nabz-pocketbase-backup`. PocketBase's own backup cron and
`cronMaxKeep` are **off** (`PB_BACKUP_CRON=""`, `PB_BACKUP_MAX_KEEP=0`) — the timer
drives backups so they land after the vacuum, and two retention policies against
one bucket is how backups get deleted early.

### Failure is visible

The run pings a Better Stack heartbeat (`nabz-pb-maintenance (<env>)`, 24h period
/ 6h grace) **only on success**, so the alert is on silence. A failure
notification sent from the host that just failed is not a mechanism you can rely
on. `infra-watch` creates the heartbeat; `remote-deploy.sh` resolves its URL from
Better Stack, so nothing is stored.

Read the last run with `journalctl -u nabz-pb-maintenance`, or
`systemctl list-timers nabz-pb-maintenance.timer` for the next one.

### Restore

Verified end to end against PocketBase 0.40.5 and the real R2 bucket: a marker row
was written, backed up to R2, dropped, and restored from the R2 archive intact.

```bash
# what is in the bucket
curl -s $PB/api/backups -H "Authorization: $TOKEN"
# restore one (PB restarts itself)
curl -s -X POST "$PB/api/backups/<key>/restore" -H "Authorization: $TOKEN"
```
