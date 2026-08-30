package main

import (
	"log"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
)

// heartbeatGraceFloor is the minimum grace added to the interval before a silent
// heartbeat is considered down, so short intervals still get a little slack.
const heartbeatGraceFloor = 30 * time.Second

// heartbeatWindow is how long a heartbeat may be silent before it's down: the
// expected interval plus a grace period (half the interval, floored).
func heartbeatWindow(intervalSecs int) time.Duration {
	if intervalSecs <= 0 {
		intervalSecs = defaultInterval
	}
	interval := time.Duration(intervalSecs) * time.Second
	grace := interval / 2
	if grace < heartbeatGraceFloor {
		grace = heartbeatGraceFloor
	}
	return interval + grace
}

// heartbeatStatus is the pure decision: no check-in recorded → pending (don't
// alert on a brand-new monitor); silent longer than interval+grace → down;
// otherwise up.
func heartbeatStatus(lastChecked string, intervalSecs int, now time.Time) Status {
	last, ok := parsePBTime(lastChecked)
	switch {
	case !ok:
		return StatusPending
	case now.Sub(last) > heartbeatWindow(intervalSecs):
		return StatusDown
	default:
		return StatusUp
	}
}

// evaluateHeartbeat decides a heartbeat (cron check-in) monitor's status from its
// last check-in rather than by probing: never checked in → pending (no incident
// yet); silent past interval+grace → down; otherwise up. Incident open/resolve
// and alerting reuse reconcileIncident, exactly like probed monitors.
//
// pathDown holds the verdict (#339). A check-in is recorded by the web Worker
// writing to PocketBase over Cloudflare; the evaluator sits on the private
// network and is unaffected by that path breaking. So a Cloudflare incident makes
// every heartbeat monitor look silent while every probed monitor stays green, and
// without this the evaluator would page for all of them — outages that are not
// happening. For an alerting product a false alarm is worse than a dark
// dashboard: a silent UI is embarrassing, waking someone at 3am for a healthy
// service destroys trust in every future alert.
//
// It is a HOLD, not a discard. The status still moves, so the UI keeps telling
// the truth; only the incident (and therefore the page) waits. When the path
// recovers, the next pass re-evaluates from the same last_checked and opens the
// incident then if the monitor really was down throughout. Suppressing the
// verdict outright would trade false positives for false negatives, which is the
// worse of the two.
func evaluateHeartbeat(pbClient *pb.Client, monitor models.Monitor, pathDown bool, now time.Time) error {
	status := heartbeatStatus(monitor.LastChecked, monitor.Interval, now)

	if string(status) != monitor.Status {
		if err := pbClient.UpdateMonitorStatus(monitor.Id, string(status)); err != nil {
			return err
		}
		log.Printf("[%s] heartbeat status %q -> %q", monitor.Id, monitor.Status, status)
	}

	// Only `down` is held. An `up` heartbeat proves a check-in landed, so the path
	// demonstrably works for this monitor whatever the beat says, and resolving an
	// incident must never be blocked — that would leave someone paged for a
	// service that recovered.
	if pathDown && status == StatusDown {
		return nil
	}
	return reconcileIncident(pbClient, monitor, status, nil, now)
}

// checkInPathDown reports whether the web's liveness beat has gone stale, i.e.
// whether a check-in could reach us at all right now.
//
// Absent row: the beat has never run — treated as HEALTHY, not broken. Otherwise
// an environment that has not deployed the cron would silently stop alerting on
// every heartbeat monitor forever, which is the failure this whole mechanism
// exists to avoid, arrived at from the other direction.
func checkInPathDown(zones []pb.ZoneStat, window time.Duration, now time.Time) (down bool, age time.Duration, seen bool) {
	for _, z := range zones {
		if z.Zone != pb.WebZone {
			continue
		}
		last, ok := parsePBTime(z.Updated)
		if !ok {
			return false, 0, false
		}
		age = now.Sub(last)
		return age > window, age, true
	}
	return false, 0, false
}
