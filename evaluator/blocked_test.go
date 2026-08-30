package main

import (
	"testing"
	"time"

	"monitors/corelib/pb"
)

// A rate-limited / blocked latest check (429/403) must be a neutral abstention:
// the zone drops out of consensus so it can't open an incident or page.
func TestBuildZoneEvalAbstainsOnBlocked(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Format("2006-01-02 15:04:05.000Z")
	window := time.Minute

	for _, code := range []int{429, 403} {
		ze := buildZoneEval([]pb.CheckRecord{
			{Zone: "eu", Up: false, StatusCode: code, CheckedAt: fresh},
		}, now, window)
		if ze.Fresh {
			t.Fatalf("status %d must abstain (Fresh=false), got %+v", code, ze)
		}
	}
}

// All zones rate-limited => no fresh votes => pending. Never down, so no alert.
func TestBlockedEverywhereIsPendingNotDown(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Format("2006-01-02 15:04:05.000Z")
	window := time.Minute

	zoneEvals := []ZoneEval{
		buildZoneEval([]pb.CheckRecord{{Zone: "eu", Up: false, StatusCode: 429, CheckedAt: fresh}}, now, window),
		buildZoneEval([]pb.CheckRecord{{Zone: "us", Up: false, StatusCode: 429, CheckedAt: fresh}}, now, window),
	}
	if got := decide(zoneEvals, consecutiveThreshold); got != StatusPending {
		t.Fatalf("all-blocked must be pending (no incident), got %s", got)
	}
}

// A blocked check must not extend the consecutive-down streak that drives the
// single-zone down verdict: a real down preceded by a 429 counts as one down.
func TestBlockedBreaksTrailingDownStreak(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Format("2006-01-02 15:04:05.000Z")
	window := time.Minute

	ze := buildZoneEval([]pb.CheckRecord{
		{Zone: "eu", Up: false, StatusCode: 500, CheckedAt: fresh}, // older genuine down
		{Zone: "eu", Up: false, StatusCode: 429, CheckedAt: fresh}, // blocked resets streak
		{Zone: "eu", Up: false, StatusCode: 500, CheckedAt: fresh}, // latest genuine down
	}, now, window)

	if ze.TrailingDown != 1 {
		t.Fatalf("blocked check must break the streak (want TrailingDown=1), got %d", ze.TrailingDown)
	}
	// One down (single fresh zone) is not enough to page under the 2-in-a-row rule.
	if got := decide([]ZoneEval{ze}, consecutiveThreshold); got != StatusPending {
		t.Fatalf("single down after a blocked reset must stay pending, got %s", got)
	}
}
