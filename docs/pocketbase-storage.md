# PocketBase storage — measured, and how the volume is sized

Companion to [pocketbase-capacity.md](pocketbase-capacity.md), which measures *throughput*
(inserts/s, latency, CPU). This one measures **bytes**: what a row actually costs on disk, what
steady state looks like at a given fleet size, and why the data volume is 20 GB.

## Where pb_data lives

On production, `pb_data` is on a **separate Hetzner Volume**, never the server's boot disk. A
Hetzner disk resize is **one-way and permanently locks the server plan** — once resized, that server
can never change type, so CPU and RAM stop being independently scalable. A Volume grows on its own
schedule and detaches/reattaches, leaving the server type free to move.

`deploy/hetzner/provision.sh` creates and attaches it; `deploy/setup-pocketbase.sh` mounts it at
`/mnt/pb-data` (fstab, `nofail`) and bind-mounts it into the container at `/pb_data`.

## Measured

Dev instance, **2026-08-16**, `dbstat` over a `docker cp` copy of `/pb_data/data.db`
(78,071 `checks` rows, 11 monitors, 3 zones):

| Table | On-disk bytes | Rows | B/row |
|---|---:|---:|---:|
| `checks` (table) | 28,237,824 | 78,071 | 361.7 |
| `checks` indexes¹ | 9,957,376 | — | 127.5 |
| **`checks` total** | **38,195,200** | **78,071** | **489.2** |
| `rollups` (+ index) | 692,224 | 2,607 | 265.5 |
| `incident_events` (+ index) | 40,960 | 136 | 301.2 |
| `channel_events` (+ index) | 36,864 | 154 | 239.4 |
| `incidents` | 12,288 | 23 | 534.3 |

¹ `idx_checks_monitor_zone_at` 4,554,752 + `idx_checks_checked_at` 2,973,696 +
`sqlite_autoindex_checks_1` 2,428,928.

`data.db` total 46,723,072 B (11,407 pages × 4096; 1,805 free pages ≈ 7.4 MB reclaimable — that
slack is what #322's bounded `incremental_vacuum` recovers).

**Indexes are 26% of the `checks` footprint.** Any sizing that counts only row payload is a quarter
low.

## Projection

Steady state is set by the retention compiled into `evaluator/rollups.go`: **7 days** of raw
`checks`, 45 days of hourly rollups, 90 days of channel events, 90 days of incident events.

`incidents` themselves are **never purged**, deliberately (#323): the monitor availability table
computes "Last 365 days" and "All time" downtime straight from them, so any finite retention would
silently truncate two columns of a table that looks complete. Those rows are small and grow with
incident rate rather than monitor count — roughly 190 MiB/year at 5,000 monitors, which is noise
next to the figures below. The events timeline is the bulky half, and nothing computes statistics
from it, so that is what ages out.

At **60 s across 2 zones** each
monitor writes 2,880 check rows/day, so 20,160 rows are retained at any time:

| Fleet | Retained `checks` rows | `checks` on disk | + hourly rollups | **Steady state** |
|---|---:|---:|---:|---:|
| 100 monitors | 2.0 M | 0.99 GB | 0.06 GB | **≈ 1.1 GB** |
| 1,000 monitors | 20.2 M | 9.9 GB | 0.6 GB | **≈ 10.5 GB** |
| 5,000 monitors | 100.8 M | 49.3 GB | 2.9 GB | **≈ 52 GB** |

Two things move these numbers:

- **#325 takes roughly a third off.** 12.67 MiB of the measured `checks` payload is `final_url`,
  11.76 MiB of that redirect query strings from two Cloudflare Access monitors. Dropping them takes
  the row cost from 489 B to ≈331 B.
- **A 30 s interval doubles a monitor's contribution.** 30 s is the floor (#319), not the default;
  the table above assumes the 60 s default.

## Why 20 GB

20 GB covers **~1,500 monitors** at 60 s / 2 zones, with headroom for rollups, the WAL, local
snapshots under `/pb_data/backups/`, and vacuum slack.

It is deliberately **not** a 5,000-monitor size — that needs ~52 GB. Buying 52 GB now for a fleet
that does not exist is the wrong trade when growing the volume is a live operation. That is the
whole argument for a Volume over a boot disk: this number is revisable, and the boot-disk decision
would not have been.

## The request log is excluded — and that is load-bearing

`auxiliary.db` (PocketBase's own request log) is **not** in the projection, because production runs
with `logs.minLevel = 4` (warn), applied by `setup-pocketbase.sh` at provisioning.

That setting is not optional. At the default `0` (info) PocketBase writes a row per API request. On
dev, that grew `auxiliary.db` to **999,661,568 B (~953 MB) plus a 162 MB WAL** against **46.7 MB**
of real data — the request log was **21× the database it was logging**. Provision with `minLevel: 0`
and the volume fills with request logs and every number on this page becomes meaningless.

## Re-measuring

The numbers above are one snapshot of one instance. To redo them:

```sh
CID=$(docker ps --format '{{.ID}} {{.Image}}' | grep -i pocketbase | awk '{print $1}')
docker cp "$CID:/pb_data/data.db" /tmp/pbsize.db
python3 - <<'PY'
import sqlite3
c = sqlite3.connect('/tmp/pbsize.db')
for name, b in c.execute('select name, sum(pgsize) b from dbstat group by name order by b desc'):
    print('%12d  %s' % (b, name))
PY
rm -f /tmp/pbsize.db
```

Copy the file rather than querying it in place — PocketBase is mid-write and a live read gives an
inconsistent picture. `dbstat` reports the main database only; check `auxiliary.db` separately with
`ls -la /pb_data/`.
