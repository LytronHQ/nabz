# Scaling workers

How to add probing capacity, and what is load-bearing when you do.

Three things are deliberately separate:

| | What it is | Changing it |
|---|---|---|
| **Zone** (`REGION_NAME`) | The shard key. Written to `checks.zone` and decides which monitors a worker probes. | **Treat as immutable.** It is stamped on every historical check row, so renaming one is a data migration, not a config edit. |
| **Worker id** (`WORKER_ID`) | This worker's place in its zone's roster, and therefore **which monitors it checks**. Also its ops identity in logs and `zone_stats.worker`. | Keep it STABLE. It never reaches a check row, but changing it re-shards the zone. |
| **Display name** | What users see for a zone. | Free — it is presentation, and lives in the database, not in worker config. |

The rule behind the table: **anything stamped into history is immutable; anything
rendered for a human is not.**

## A zone is a set of workers

A zone may hold **any number of workers, on any number of hosts** — a Hetzner VM,
a Fly.io machine, a container on your laptop. Each one keeps the zone's schedule
in memory and checks only its own share of it.

Which share is **derived, not assigned**. Every worker:

1. upserts its own row in `worker_heartbeats` every 10s,
2. reads every row for its zone, drops the stale ones, sorts what is left by
   worker id — that is the **roster**,
3. finds itself in that roster, and owns the monitors where
   `hash(monitor.id) % len(roster) == myIndex`.

No coordinator, no queue, no claim to write, nothing to release when a worker
dies. It holds together because every worker computes the same roster from the
same rows: the sort is total, the hash is the standard library's FNV-32a, and
staleness is judged against **PocketBase's clock** — the `updated` it stamps on
each worker's own heartbeat — never a local one. Two machines in different clouds
cannot otherwise agree on who is alive.

### `WORKER_ID` is load-bearing

The roster is ordered by worker id, so **the id decides which monitors a worker
checks**. An id that changes re-shards the zone.

- `remote-deploy.sh` derives a stable one from the zone and the node address.
- Docker's default (the container hostname) is a fresh container id on every
  recreate, so a node using it re-shards its zone on each deploy.
- Two workers must never share an id: each would check that one position's share
  and each would assume the other covered the rest, so part of the zone would
  silently stop being checked. `setup-worker.sh` refuses a fixed `WORKER_ID`
  together with `WORKER_REPLICAS > 1` for exactly this reason.

### What happens when the roster changes

| | |
|---|---|
| Heartbeat | every 10s |
| Stale after | 45s — four missed beats |
| Takeover | ≈50s: the 45s TTL plus an immediate reconcile, not the 30s tick |
| Duplicate window on rejoin | one reconcile pass at most |

A dead worker's monitors go unchecked until the others see it as stale, then they
take them over. A worker joining causes a brief window where a monitor may be
checked by both its old and new owner — the new owner's first check can land
before the old owner's reconcile drops it. An ex-owner never *reschedules* a
monitor it has lost, so that window is one check, not one pass of them.

## Adding capacity

> **Deciding** whether to add any of this — what to watch, what the thresholds
> are, and when the right answer is to change nothing — is
> ["When to change something"](runbook.md#when-to-change-something) in the
> runbook. This section is what the options *are*.


In order of preference:

1. **`WORKER_CONCURRENCY`** (default 8) — how many checks one worker runs at
   once. Costs nothing, needs no coordination, and a check is network-bound, so
   this is not a CPU count.
2. **`WORKER_REPLICAS`** — more workers on the same node. Leave `WORKER_ID` blank
   so each container uses its own hostname.
3. **Another host** — another `worker` line in `NODES` with the same zone, or a
   `fly` line (see [`fly/README.md`](../fly/README.md)).

## Spreading one zone across hosts

```
worker 10.0.0.5 eu                 # a VM in Germany
fly    nabz-worker-eu-fly eu ams   # a Fly machine in the Netherlands, same zone
```

Both are deployed by one `remote-deploy.sh` run, from the same commit. That is
deliberate: **two workers in one zone must never run different versions**, because
they are splitting one schedule between them by a rule both have to compute
identically.

A worker that has no route to the private network — the Fly one — reaches
PocketBase through the tunnel at `pb.nabz.sh` with its own Cloudflare Access
service token.

## What a worker does on a loop

| Loop | Every | What it does |
|---|---|---|
| **heartbeat** | 10s | Upserts its `worker_heartbeats` row and recomputes its place in the zone's roster. A change pushes an immediate reconcile. |
| **reconcile** | 30s, or on a roster change | Re-syncs the due-set in **both** directions: monitors this worker owns are scheduled; anything else it is tracking — disabled, deleted, a heartbeat type, moved to another zone, or now another worker's share — is pruned. |
| **check** | continuous | Pops the earliest monitor that is due, hands it to the pool, reschedules it — unless it no longer owns it. |
| **stats** | 10s | Publishes `zone_stats`, if it is the one that should. |

## `zone_stats` with several workers

The row is one per zone, so exactly one worker writes it: **the lowest worker id
in the live roster**, which is simply index 0 since the roster is sorted.

Two rules make that safe:

- A worker that has **not** completed a roster read does not claim the election.
  Its default position is "index 0 of 1" so that it owns every monitor before its
  first read, and reading that as "therefore I am the writer" once let a worker
  with a failed read publish alongside the real one — `workers` flapped between
  the true count and 1.
- **Any live worker publishes if the row itself has gone quiet** for three stats
  intervals. `zone_stats.updated` is the zone's heartbeat for the dead-man's
  switch, `/api/health`, the zone picker and the dashboard — and the dashboard
  calls a zone stale at 30s. Without this, the elected writer restarting would
  make a zone with healthy workers read as dead. **A zone reads dead only when
  ALL of its workers are dead.**

`workers` is the live roster count. `queue_depth` and `schedule_lag_seconds`
describe the **writer's own shard**, not the whole zone — no worker can see its
peers' heaps.

## Restarts

Nothing is persisted and nothing needs to be. A restart rebuilds the schedule
from PocketBase in one reconcile pass before the first check. A check that was in
flight is simply re-run when its monitor comes round again.

First checks are staggered by `hash(id) % interval`, so a restart does not fire
every monitor at once. The hash is stable, so the same monitor lands in the same
slot every time. The cost is that a **newly created monitor waits up to one
interval for its first check**.

## Zones and their names

The `zones` collection holds `code`, `group_code`, `group_name`, `display_name`,
`enabled`, `sort_order`. `code` is unique and is the only load-bearing column —
it is stamped into every `checks.zone` row. Everything else is presentation.

**Renaming a zone is one `UPDATE` of `display_name`.** The code does not move, so
no historical check row is touched. Writes are superuser-only: nothing holding a
service-account token should be able to edit a value that appears in millions of
history rows.

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
