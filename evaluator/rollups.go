package main

import (
	"fmt"
	"log"
	"time"

	"monitors/corelib/pb"
)

// Rollup periods and retention.
//
//	hour  — built from raw `checks` each hour.       kept ~45 days.
//	day   — built from that day's 24 hourly rollups. kept indefinitely.
//	month — built from that month's daily rollups.   kept indefinitely.
//
// Raw checks are purged after `retentionDays`; the aggregated rollups preserve
// long-range history (so 30d / 365d / all-time views survive the purge) at a
// tiny fraction of the row count.
const (
	rollupPeriodHour  = "hour"
	rollupPeriodDay   = "day"
	rollupPeriodMonth = "month"

	retentionDays             = 7  // raw checks
	hourRollupRetentionDays   = 45 // hourly rollups (dailies preserve older history)
	channelEventRetentionDays = 90 // per-channel delivery log

	// incident_events is the per-incident timeline: opened, acknowledged, zone
	// observations, operator comments. 90 days matches channel_events, which is
	// the same kind of record — an audit trail you read while an incident is
	// recent and never again.
	//
	// incidents themselves are NOT purged, deliberately (#323). The monitor
	// availability table computes downtime, incident count, longest outage and
	// mean duration for "Last 365 days" and "All time" straight from incidents
	// (app/src/lib/server/availability.ts), so any finite retention there would
	// silently truncate two columns of a table that looks complete. Those rows
	// are small and carry started_at / resolved_at, which is all that read needs;
	// the events timeline is the bulky half and nothing computes stats from it.
	incidentEventRetentionDays = 90
)

// purgeBudget bounds how long a single purge run may spend deleting, so draining
// a large backlog can't stall the evaluation cycle indefinitely. It's shared
// across the purge targets (checks first), so total purge time per cycle is
// capped regardless of how far behind we are.
const purgeBudget = 8 * time.Second

// rollupState tracks the last hour/day/month we rolled up, so each is processed
// once per boundary. Zero values are fine on startup — the first tick recomputes
// the most-recent completed bucket (idempotent upsert), which self-heals restarts.
type rollupState struct {
	lastHour, lastDay, lastMonth time.Time
}

type rollupStat struct {
	uptimePct float64
	avgMs     float64
	maxMs     float64
	minMs     float64
	count     int
}

// aggregateByZone summarizes the raw checks that fall in [from, to) per zone.
func aggregateByZone(checks []pb.CheckRecord, from, to time.Time) map[string]rollupStat {
	type acc struct {
		total, up, sum, min, max int
	}
	accs := map[string]*acc{}

	for _, ch := range checks {
		t, ok := parsePBTime(ch.CheckedAt)
		if !ok || t.Before(from) || !t.Before(to) {
			continue
		}
		a := accs[ch.Zone]
		if a == nil {
			a = &acc{}
			accs[ch.Zone] = a
		}
		if a.total == 0 {
			a.min = ch.ResponseMs
			a.max = ch.ResponseMs
		}
		a.total++
		if ch.Up {
			a.up++
		}
		a.sum += ch.ResponseMs
		if ch.ResponseMs < a.min {
			a.min = ch.ResponseMs
		}
		if ch.ResponseMs > a.max {
			a.max = ch.ResponseMs
		}
	}

	out := map[string]rollupStat{}
	for zone, a := range accs {
		if a.total == 0 {
			continue
		}
		out[zone] = rollupStat{
			uptimePct: float64(a.up) / float64(a.total) * 100,
			avgMs:     float64(a.sum) / float64(a.total),
			maxMs:     float64(a.max),
			minMs:     float64(a.min),
			count:     a.total,
		}
	}
	return out
}

// aggregateRollups combines finer rollups (e.g. 24 hourly buckets) into one
// coarser bucket per zone — a check-count-weighted roll-up-of-roll-ups. This is
// how day and month buckets are built without re-scanning raw checks (which are
// purged, and capped per query anyway).
func aggregateRollups(children []pb.RollupRecord) map[string]rollupStat {
	type acc struct {
		count     int
		up        float64 // fractional up-checks: uptimePct/100 * count, summed
		sumMs     float64 // avgMs * count, summed
		min, max  float64
		hasMinMax bool
	}
	accs := map[string]*acc{}

	for _, r := range children {
		if r.CheckCount == 0 {
			continue
		}
		a := accs[r.Zone]
		if a == nil {
			a = &acc{}
			accs[r.Zone] = a
		}
		a.count += r.CheckCount
		a.up += r.UptimePct / 100 * float64(r.CheckCount)
		a.sumMs += r.AvgMs * float64(r.CheckCount)
		if !a.hasMinMax {
			a.min, a.max, a.hasMinMax = r.MinMs, r.MaxMs, true
		} else {
			if r.MinMs < a.min {
				a.min = r.MinMs
			}
			if r.MaxMs > a.max {
				a.max = r.MaxMs
			}
		}
	}

	out := map[string]rollupStat{}
	for zone, a := range accs {
		if a.count == 0 {
			continue
		}
		out[zone] = rollupStat{
			uptimePct: a.up / float64(a.count) * 100,
			avgMs:     a.sumMs / float64(a.count),
			maxMs:     a.max,
			minMs:     a.min,
			count:     a.count,
		}
	}
	return out
}

// maybeRollupAndPurge rolls up the just-completed hour (and, at day/month
// boundaries, the completed day/month) and purges old rows — at most once per
// hour (tracked via st.lastHour).
func maybeRollupAndPurge(pbClient *pb.Client, st *rollupState, now time.Time) {
	// Purge runs EVERY cycle, not just on the hour: at scale the insert rate far
	// outpaces an hourly, fixed-cap purge, so hourly purging never drains the
	// backlog and the retention window silently stops holding (#314).
	purge(pbClient, now)

	curHour := now.Truncate(time.Hour)
	if curHour.Equal(st.lastHour) {
		return
	}

	// Hourly, from raw checks.
	prevHour := curHour.Add(-time.Hour)
	log.Printf("Rollup: processing hour %s", prevHour.Format(time.RFC3339))
	rollupHour(pbClient, prevHour)

	// Daily, from the previous day's hourly rollups, when the UTC day rolls over.
	curDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if !curDay.Equal(st.lastDay) {
		rollupCoarser(pbClient, rollupPeriodHour, rollupPeriodDay, curDay.AddDate(0, 0, -1), curDay)
		st.lastDay = curDay
	}

	// Monthly, from the previous month's daily rollups, when the month rolls over.
	curMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	if !curMonth.Equal(st.lastMonth) {
		rollupCoarser(pbClient, rollupPeriodDay, rollupPeriodMonth, curMonth.AddDate(0, -1, 0), curMonth)
		st.lastMonth = curMonth
	}

	st.lastHour = curHour
}

func rollupHour(pbClient *pb.Client, hourStart time.Time) {
	hourEnd := hourStart.Add(time.Hour)

	monitors, err := pbClient.ListMonitorsForEval()
	if err != nil {
		log.Printf("Rollup: failed to list monitors: %s", err)
		return
	}

	for _, monitor := range monitors {
		checks, err := pbClient.GetChecksSince(monitor.Id, hourStart)
		if err != nil {
			log.Printf("Rollup: [%s] failed to read checks: %s", monitor.Id, err)
			continue
		}
		stats := aggregateByZone(checks, hourStart, hourEnd)
		if len(stats) == 0 {
			continue
		}
		writeRollups(pbClient, monitor.Id, rollupPeriodHour, hourStart, hourEnd, stats)
	}
}

// rollupCoarser builds one parentPeriod bucket per monitor+zone from the
// childPeriod buckets in [start, end). Used for hour->day and day->month.
// If the child buckets don't exist yet (e.g. right after this first shipped),
// the aggregate is empty and the bucket is simply skipped — graceful.
func rollupCoarser(pbClient *pb.Client, childPeriod, parentPeriod string, start, end time.Time) {
	log.Printf("Rollup: processing %s %s", parentPeriod, start.Format(time.RFC3339))

	monitors, err := pbClient.ListMonitorsForEval()
	if err != nil {
		log.Printf("Rollup(%s): failed to list monitors: %s", parentPeriod, err)
		return
	}

	for _, monitor := range monitors {
		children, err := pbClient.GetRollups(monitor.Id, childPeriod, start, end)
		if err != nil {
			log.Printf("Rollup(%s): [%s] failed to read %s rollups: %s", parentPeriod, monitor.Id, childPeriod, err)
			continue
		}
		stats := aggregateRollups(children)
		if len(stats) == 0 {
			continue
		}
		writeRollups(pbClient, monitor.Id, parentPeriod, start, end, stats)
	}
}

// writeRollups upserts one bucket per zone, counting incidents over [start, end)
// directly (rather than summing children, which would double-count incidents
// that span bucket boundaries).
func writeRollups(pbClient *pb.Client, monitorId, period string, start, end time.Time, stats map[string]rollupStat) {
	incidentCount, err := pbClient.CountIncidentsBetween(monitorId, start, end)
	if err != nil {
		log.Printf("Rollup(%s): [%s] failed to count incidents: %s", period, monitorId, err)
	}
	for zone, st := range stats {
		if err := pbClient.UpsertRollup(monitorId, zone, period, start,
			st.uptimePct, st.avgMs, st.maxMs, st.minMs, st.count, incidentCount); err != nil {
			log.Printf("Rollup(%s): [%s/%s] upsert failed: %s", period, monitorId, zone, err)
		}
	}
}

// purge drains records past their retention window. It runs every cycle (see
// maybeRollupAndPurge) and loops until each target is caught up or the shared
// time budget is spent — so at scale it keeps up with the insert rate instead of
// nibbling a fixed cap once an hour. `remaining_over_retention` climbing is the
// alarm that purge is falling behind.
func purge(pbClient *pb.Client, now time.Time) {
	deadline := time.Now().Add(purgeBudget)
	runOne := func(label, collection, timeField, extraFilter string, cutoff time.Time) {
		budget := time.Until(deadline)
		if budget <= 0 {
			return // an earlier target used the whole budget; this one runs next cycle
		}
		r, err := pbClient.PurgeOlderThan(collection, timeField, extraFilter, cutoff, budget)
		if err != nil {
			log.Printf("Retention: purge %s failed (purged %d): %s", label, r.Deleted, err)
			return
		}
		if r.Deleted > 0 || r.Remaining > 0 {
			log.Printf("Retention: %s purged=%d remaining_over_retention=%d", label, r.Deleted, r.Remaining)
		}
	}

	// Checks first — the only target that accrues fast enough to fall behind.
	runOne("checks", "checks", "checked_at", "", now.AddDate(0, 0, -retentionDays))
	runOne("hourly rollups", "rollups", "bucket_start", fmt.Sprintf(`period = "%s"`, rollupPeriodHour), now.AddDate(0, 0, -hourRollupRetentionDays))
	runOne("channel events", "channel_events", "created", "", now.AddDate(0, 0, -channelEventRetentionDays))
	// Last, and only the events: see incidentEventRetentionDays for why the
	// incidents themselves stay forever. An old incident keeps its dates and its
	// contribution to the availability figures, and loses only its timeline.
	runOne("incident events", "incident_events", "created", "", now.AddDate(0, 0, -incidentEventRetentionDays))
}
