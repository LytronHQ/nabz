# Scaling workers

How to add probing capacity, and what is load-bearing when you do (#311).

Three things are deliberately separate:

| | What it is | Changing it |
|---|---|---|
| **Zone** (`REGION_NAME`) | The shard key. Written to `checks.zone`, names the queue `due:<zone>`, and decides which monitors a worker probes. | **Treat as immutable.** It is stamped on every historical check row, so renaming one is a data migration, not a config edit. |
| **Worker id** (`WORKER_ID`) | Ops identity only — logs, health payload, heartbeat. Defaults to the container hostname. | Free. It never reaches a check row. |
| **Display name** | What users see for a zone. | Free — it is presentation, and lives in the database, not in worker config. |

The rule behind the table: **anything stamped into history is immutable; anything
rendered for a human is not.**

## Scaling on one node

```bash
docker compose --env-file /etc/monitors/worker.env -f deploy/worker.yml \
  --profile local-cache up -d --scale worker=3
```

Or set `WORKER_REPLICAS=3` in `/etc/monitors/worker.env` and re-run
`setup-worker.sh`.

Replicas need no individual configuration. They share the node's Valkey, so they
share one due-set, and each check is handed to exactly one worker by an atomic
reserve — adding replicas adds throughput, not duplicate probes.

Two details in `worker.yml` exist purely so this works: the worker has **no
`container_name`** (two containers cannot share a name) and publishes a **port
range** rather than a fixed one (`HEALTH_PORT_RANGE`, default `8080-8099`), since
a single host port allows exactly one replica.

## Spreading one zone across VMs

Every worker in a zone must reach **one shared Valkey**:

```bash
# on the Valkey host, on a private/tailnet address
CACHE_PASSWORD=… BIND_ADDR=100.x.y.z \
  docker compose -f deploy/valkey-zone.yml up -d

# on each worker node, in /etc/monitors/worker.env
CACHE_HOST=100.x.y.z
CACHE_PASSWORD=…
```

`setup-worker.sh` sees a non-default `CACHE_HOST` and leaves the local sidecar
off, so the node does not quietly run a second queue.

> **Two Valkeys in one zone is the one genuinely broken configuration.** Each gets its own
> due-set and its own seed leader, so every monitor in the zone is probed twice:
> double load on the target, double the check rows, and uptime maths over
> duplicated samples. Nothing errors — it just silently does everything twice.

**Transport is the private network, not the password.** `requirepass` over a
public interface is a password on a cleartext wire. Bind to Tailscale/WireGuard or
a cloud private network and let that carry the encryption; `BIND_ADDR` defaults to
loopback so an unconfigured deployment fails closed rather than listening to the
world.

The shared Valkey runs **without persistence** on purpose. The due-set is fully
rebuildable — the seeder re-adds every enabled monitor within `seedInterval` — so
a restart costs one seeding pass instead of an AOF to maintain. It does run
`--maxmemory-policy noeviction`, because the due-set *is* the schedule: evicting
keys would silently unschedule monitors, which looks exactly like everything being
fine.

## What one worker does that the others don't

Exactly one worker per zone holds `seed:lock:<zone>` (30s TTL, renewed every 10s)
and it alone:

- runs **`seedLoop`** — the full PocketBase scan of enabled monitors. N workers
  each doing this is N times the PocketBase read load for identical results, and
  PocketBase is the system's scaling limiter.
- publishes **`zone_stats`** — one row *per zone*. Every worker writing it would
  overwrite the others, and the `worker` field would flap between whichever
  container wrote last.

This is an **optimisation, not a correctness mechanism**. Seeding uses
`ScheduleNX`, so if two workers briefly both believe they lead during a handover,
the loser's pass only re-affirms monitors that are already scheduled. That is why
a plain TTL lock is sufficient and no fencing token is needed. Failover takes up
to the 30s TTL, during which the zone keeps probing normally — only reseeding and
stats reporting pause.

Every worker, leader or not, beats into `workers:<zone>` every 10s. The leader
counts the set and publishes it as `zone_stats.workers`, so the dashboard shows a
**count** rather than a list of container names.

## Zones and their names

The `zones` collection holds `code`, `group_code`, `group_name`, `display_name`,
`enabled`, `sort_order`. `code` is unique and is the only load-bearing column —
it is the `due:<zone>` queue key and is stamped into every `checks.zone` row.
Everything else is presentation.

**Renaming a zone is one `UPDATE` of `display_name`.** The code does not move, so
no queue key changes and no historical check row is touched. Writes are
superuser-only: nothing holding a service-account token should be able to edit a
value that appears in millions of history rows.

The table names zones; it does **not** decide which zones exist. The monitor
picker and the dashboard still list only zones with a live `zone_stats`
heartbeat (#328) — a row here means "this code has a name", not "a worker is
running there". Seeding a zone nobody runs is how you get a picker offering a
region that will never probe anything.

A zone that reports but has no row still renders, labelled by its bare code.
An unlabelled zone is a cosmetic gap; hiding it would silently drop a region a
user may already have monitors pinned to.

### Adding a zone

1. Deploy a worker with `REGION_NAME=<code>`.
2. Insert a row in `zones` with that code, so it reads as a name rather than a
   slug.

In that order — the row is the label, the worker is what makes the zone real.
Monitors listing no zones run everywhere; monitors listing zones run only where
`REGION_NAME` matches.

Seed a zone row only once a worker actually serves that zone. A row without a
worker advertises a region nothing will ever check, which is the dead-zone case
the picker deliberately avoids.

## Verified behaviour

Measured on the e2e stack with `--scale worker=3` against one Valkey:

- exactly one worker acquired the lock; the other two ran no seed pass at all
- `zone_stats` showed `workers=3` from a single row
- killing the leader handed the lock to another worker within the 30s TTL, with
  no interval where two held it
- a 30s-interval monitor produced **3 checks in 105 seconds, spaced 30s apart** —
  no duplicate probing from the extra workers
