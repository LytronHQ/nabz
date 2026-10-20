# Architecture decisions

Why the system is shaped the way it is. Condensed from the Phase 2 design doc
(2026) once the rebuild shipped — the plan is history, these constraints are not.

**Stack:** Go (worker, evaluator) · SvelteKit (web) · PocketBase (data, auth,
backups). Two goals drove every trade: **reliable alerting** and **low cost**.

## Consensus is N-of-M, not "both zones"

A monitor may run in 1, 2 or 3 zones, so "both agree" is undefined. `decide()` in
`evaluator/consensus.go`: M = zones with a *fresh* check. M=0 → pending. M=1 →
`up` on a good check, `down` only after N consecutive failures (no cross-zone vote
to lean on). M=2 → unanimous or pending. M≥3 → majority, ties pending.

## Freshness is required, or a dead zone masks an outage

Zones run independent schedules, so a stopped zone still has a recent `up` row.
Any check older than ~3× the interval counts as **unknown**, not `up`. Per-monitor
complement to the dead-man's switch. Both windows derive from
`models.EffectiveInterval`, never the raw stored value.

## The schedule lives in the worker, ownership comes from a roster

Each worker keeps its due-set as an in-memory min-heap (`worker/schedule.go`)
rather than in a queue beside it, and **which** monitors are in that heap is
derived from PocketBase: every worker in a zone reads the same
`worker_heartbeats` rows, sorts the live ones by worker id, finds itself, and
owns the monitors that hash to its position.

So a zone can hold any number of workers on any number of hosts with no
coordinator, no queue and no new infrastructure — the only thing they share is
the database they were already both talking to. Staleness is judged against
PocketBase's clock, never a local one, because two machines in different clouds
cannot otherwise agree on who is alive.

**Consequence:** the correctness of the split rests on every worker computing the
same roster. That is why the sort is total, the hash is fixed by the standard
library, and the worker id must be stable — an id that changes re-shards the
zone. It also means the windows are real and accepted: a dead worker's monitors
wait for the roster TTL (~45s), and a rejoining worker can cause one duplicate
check per monitor while ownership moves.

This **supersedes** the previous entry, which said a zone was exactly one
stateless container. It still is one stateless container — there are just as many
of them as you want now.

It also supersedes the per-zone Valkey queue and its reserve-don't-pop Lua
script, which existed to hand work to whichever worker asked first. Deriving
ownership instead of handing it out costs a takeover window and buys the removal
of a whole piece of infrastructure from every node.

Capacity within one worker is `WORKER_CONCURRENCY`, and it is the first lever:
raising it needs no coordination at all, where another worker needs the roster to
be right.

Liveness still lives in PocketBase (`zone_stats.updated`), so the dead-man's
switch depends on nothing but the database — and exactly one worker per zone
writes that row, with any live worker taking over if it goes quiet, so a zone
reads dead only when all of its workers are.

## Nodes never authenticate as superuser

Worker and evaluator use scoped `service_accounts` with role-gated collection
rules. An unset `PB_AUTH_COLLECTION` is a hard startup failure, not a fallback.

## The evaluator runs alone, off the zone VMs

If it shared a host with a zone it would die with that zone — and it is the thing
that notices the zone died.

## Deliberately deferred

Third zone (architecture allows it; buy it when there's a need), per-user
scheduling fairness, and a teams/org model (see `teams-readiness.md`).
