# Architecture decisions

Why the system is shaped the way it is. Condensed from the Phase 2 design doc
(2026) once the rebuild shipped — the plan is history, these constraints are not.

**Stack:** Go (worker, evaluator) · SvelteKit (web) · PocketBase (data, auth,
backups) · Valkey (per-zone due-queue). Two goals drove every trade: **reliable
alerting** and **low cost**.

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

## One Valkey per zone, not one central

Each zone's worker owns its local `due:<zone>` set. No cross-zone latency on the
hot path and no shared SPOF; the queue is fully rebuildable by the seeder, so a
Valkey restart just re-seeds. Liveness lives in PocketBase (`zone_stats.updated`),
not Valkey, so the dead-man's switch never depends on it.

**Consequence:** two workers in one zone with separate Valkeys double-probe. Every
worker in a zone must share one queue — see #311.

## Reserve, don't pop

`ZPOPMIN` ignores the due cutoff and loses the job if the worker dies. The Lua
script bumps the due score to `now + reservation` and returns the member, so a
crash lets the reservation lapse and the check is redelivered.

## Nodes never authenticate as superuser

Worker and evaluator use scoped `service_accounts` with role-gated collection
rules. An unset `PB_AUTH_COLLECTION` is a hard startup failure, not a fallback.

## The evaluator runs alone, off the zone VMs

If it shared a host with a zone it would die with that zone — and it is the thing
that notices the zone died.

## Deliberately deferred

Third zone (architecture allows it; buy it when there's a need), per-user
scheduling fairness, and a teams/org model (see `teams-readiness.md`).
