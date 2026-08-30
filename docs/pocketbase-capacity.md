# PocketBase capacity — measured

Real measurements of PocketBase write/read capacity under nabz's actual access
pattern (worker service account for writes, a user for reads, through the normal
HTTP API — same auth path and API rules as prod; nothing written to SQLite
directly). Harness: [`benchmarks/pbbench`](../benchmarks/pbbench). Re-run it on
the real prod VM before trusting the fleet numbers — see the caveat below.

## ⚠️ Hardware caveat — read first

These numbers were measured on a **development workstation, not a Hetzner prod
VM**, so treat them as an **upper bound**:

| | Bench host (measured) | Intended prod (cx22) |
|---|---|---|
| CPU | AMD Ryzen 7 8845HS, **16 threads** | **2 shared vCPU** |
| RAM | 27 GB | 4 GB |
| Disk | NVMe SSD (ext4) | NVMe (shared) |

At the write ceiling the PocketBase process used **~2 cores average (peak 4.8)**.
A 2‑vCPU cx22 cannot supply that, so its write ceiling will be **materially lower**
— roughly CPU‑proportional. **Re-run `pbbench` on the actual VM for prod numbers.**
PB 0.28.4 (the pinned prod release), run as the host binary over loopback.

## Deliverable — the table

Sustained single‑insert ceiling **≈ 4,500 checks/s** on the bench host.

| Interval | Zones | Fleet insert rate / monitor | Implied max fleet (raw write ceiling) |
|---|---|---|---|
| 60 s | 2 | 2 / 60 = 0.033 ins/s | **≈ 135,000 monitors** |
| 30 s | 2 | 2 / 30 = 0.067 ins/s | **≈ 67,500 monitors** |

`max monitors = ceiling(ins/s) × interval(s) ÷ zones`. **This is the raw write
ceiling and NOT the real limit** — reads bind first (Test B) and prod CPU is far
smaller (caveat above). The practical fleet limit on the bench host, gated by the
dashboard staying usable, is **~50k monitors @60s**, and lower on a cx22.

**Identified limiter: SQLite's single‑writer serialization + PocketBase
per‑request CPU overhead.** Not disk bandwidth (peak write ~97 MB/s, far under
NVMe capacity), not total CPU (2 of 16 cores). Evidence: throughput plateaus from
conc≥8 while latency grows with concurrency (a serialized resource — the WAL write
lock), and batching makes it *worse* (Test C).

---

## Test A — write ceiling (single insert per request)

N concurrent writers `POST /api/collections/checks/records` as the worker service
account, into a ~150k‑row table. 6 s per level.

| conc | inserts/s | p50 (ms) | p99 (ms) |
|---|---|---|---|
| 1 | 1,704 | 0.5 | 1.4 |
| 8 | 3,495 | 1.3 | 24 |
| 16 | 3,602 | 2.2 | 30 |
| 64 | 4,427 | 9.0 | 64 |
| 96 | **4,534** | 14.3 | 96 |
| 128 | 4,496 | 20.3 | 132 |
| 256 | 4,392 | 41.0 | 266 |

Throughput **plateaus ~3,500–4,500/s from conc≥8**; adding writers past that only
grows latency (queuing on the single WAL writer), not throughput. **p99 never
crossed 500 ms** even at 256 writers — the ceiling is throughput saturation, not a
latency cliff. Limiter as above (CPU/disk profile sampled during this phase: PB
~2 cores avg / 4.8 peak; disk ≤97 MB/s).

## Test B — reads under write load

Writes held at 60% of the Test A ceiling; the dashboard and monitor‑detail
queries (the exact ones those pages issue) run concurrently as a user.

| Read page | p50 (ms) | p99 (ms) |
|---|---|---|
| Dashboard (7 queries) | **3,285** | **3,714** |
| Monitor detail | 300 | 474 |

**Reads degrade catastrophically before writes do.** Under load the dashboard
took **~3.3 s**. (Writes meanwhile stayed healthy, ~1.8k/s.)

The cause is **not** a missing index. `checked_at` is indexed, twice —
`idx_checks_checked_at` and `idx_checks_monitor_zone_at` are both in
[`pb_schema.json`](../infrastructure/pb_schema.json) and both real on the live
instance, where `dbstat` shows the former occupying 2.9 MB against 78k rows. An
earlier revision of this doc called it an "unindexed `COUNT(*)`"; that was wrong,
and it matters, because it makes #324 look like the wrong fix — if a missing
index were the problem you would just add one.

What actually costs: `getFleetUptime24h` / `getChecksLastMinute` match a large
row set (a day of checks) and pay PocketBase's per-request overhead plus the
`checks` list rule's `monitor.user.id = auth.id` join over every matched row,
while contending with the write lock. An index finds the range quickly; it does
not make the range smaller.

**Fixed in #324.** Fleet uptime now comes from the hour rollup tier, weighted by
`check_count` so it is arithmetically identical rather than an approximation, with
only the in-flight hour read from raw `checks` — 2,880 rows per monitor per day
down to 48 plus a bounded partial hour. Checks-per-minute no longer reads `checks`
at all: it is derived from monitor intervals, and suppressed when a zone heartbeat
is stale so a configuration figure can never read as healthy throughput during an
outage. The numbers above predate that change and have not been re-measured.

Cost still scales with monitor count (24 buckets × zones × monitors), so a
fleet- or user-tier rollup will be needed somewhere north of ~5k monitors.

## Test C — batching

The worker writes one check per request today. Same ceiling with batched inserts
via `/api/batch`, sweeping batch size at conc=8:

| batch size | inserts/s | p99 (ms) |
|---|---|---|
| 1 | 2,219 | 16 |
| 50 | 2,977 | 474 |
| 200 | 3,409 | 1,648 |
| 500 | 3,480 | 5,149 |

**Batch ceiling 3,480/s = 0.77× the single‑insert ceiling — batching is *slower*,
and p99 explodes.** So the write cost is dominated by *per‑row* work (rule eval,
validation, the insert) that a batch can't amortize, and a big batch just holds
the single write lock longer. **Do not batch worker check writes.**

## Test D — SQLite settings

| Pragma | Value | Source |
|---|---|---|
| `journal_mode` | **WAL** | confirmed (persisted in the DB header) |
| `synchronous` | **NORMAL** | PocketBase's per‑connection default for WAL |
| `wal_autocheckpoint` | 1000 pages | DB header |
| `page_size` | 4096 | DB header |

`journal_mode=WAL` is confirmed. `synchronous` is a **per‑connection** setting, so
a second read‑only connection reports its own default (FULL) rather than
PocketBase's — PB sets **NORMAL** (the standard WAL pairing) in its own connection
config. Crucially, **PocketBase hardcodes these; they are not exposed as tunable
settings.** So the "alternatives available to us" for the write ceiling are
effectively **none without patching PocketBase** — measuring `DELETE`/`FULL`
alternatives would require either patching PB or writing to SQLite directly
(excluded by the brief). WAL + NORMAL is already the throughput‑favourable
pairing, consistent with the observation that fsync/disk was not the limiter.

---

## Bottom line

- Raw single‑insert ceiling **≈4,500/s** on 16‑core/NVMe → a huge *write*‑only
  fleet, but that is not the binding constraint.
- **Reads bind first**: the dashboard's raw‑`checks` count queries hit ~3.3 s
  under load. Move them to `rollups` before chasing write scale.
- **Batching doesn't help** (0.77×) — leave the one‑insert‑per‑request worker
  path alone.
- **Limiter is SQLite single‑writer + PB per‑request CPU**, not disk. On a 2‑vCPU
  cx22 this becomes CPU‑bound and the ceiling drops — **re-run `pbbench` there**
  for the number that actually gates prod.
