package main

import (
	"testing"
	"time"
)

// The roster is sorted by worker id, so index 0 IS the lowest id — the election
// needs no separate mechanism, and every worker reaches the same answer.
func TestStatsWriterIsTheLowestId(t *testing.T) {
	mem := newMembership()
	// Before any roster read this worker does not know it is alone, so it must
	// NOT claim the election — see TestUnreadRosterDoesNotClaimTheElection.
	if mem.isStatsWriter() {
		t.Fatal("a worker with no roster read claimed the election")
	}
	mem.set(0, 1)
	if !mem.isStatsWriter() {
		t.Fatal("a lone worker must publish zone_stats")
	}
	mem.set(0, 3)
	if !mem.isStatsWriter() {
		t.Fatal("index 0 of 3 must publish zone_stats")
	}
	for _, idx := range []int{1, 2} {
		mem.set(idx, 3)
		if mem.isStatsWriter() {
			t.Fatalf("index %d of 3 must not publish zone_stats", idx)
		}
	}
}

func TestZoneStatsIsStale(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	fmtPB := func(d time.Duration) string {
		return now.Add(-d).Format("2006-01-02 15:04:05.000Z")
	}
	cases := []struct {
		name    string
		updated string
		want    bool
	}{
		{"just written", fmtPB(0), false},
		{"one interval old", fmtPB(10 * time.Second), false},
		{"just inside the window", fmtPB(29 * time.Second), false},
		{"past the window", fmtPB(31 * time.Second), true},
		{"long dead", fmtPB(10 * time.Minute), true},
		// Unparseable is treated as stale: we cannot tell, and publishing is the
		// safe move — the alternative is a zone that reads dead with live workers.
		{"unparseable", "garbage", true},
		{"empty", "", true},
	}
	for _, c := range cases {
		if got := zoneStatsIsStale(c.updated, now, 30*time.Second); got != c.want {
			t.Errorf("%s: zoneStatsIsStale = %v, want %v", c.name, got, c.want)
		}
	}
}

// Absolute time comes from PocketBase, elapsed time from the local monotonic
// clock, so a worker whose wall clock is wrong still measures ages correctly.
func TestServerNowAdvancesFromPocketBasesClock(t *testing.T) {
	mem := newMembership()
	if _, ok := mem.serverNow(); ok {
		t.Fatal("serverNow reported a time before any heartbeat succeeded")
	}

	// A deliberately implausible server clock: if serverNow were secretly using
	// the local clock, this would not survive.
	server := time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)
	mem.observeServerTime(server)

	got, ok := mem.serverNow()
	if !ok {
		t.Fatal("serverNow reported nothing after a heartbeat")
	}
	if drift := got.Sub(server); drift < 0 || drift > time.Second {
		t.Fatalf("serverNow = %v, want within a second of %v", got, server)
	}

	time.Sleep(20 * time.Millisecond)
	later, _ := mem.serverNow()
	if !later.After(got) {
		t.Fatalf("serverNow did not advance: %v then %v", got, later)
	}
}

// The whole point of the fallback: a zone with any live worker keeps publishing.
func TestFallbackCoversAnElectedWriterGoingAway(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	follower := newMembership()
	follower.set(2, 3) // not elected

	if follower.isStatsWriter() {
		t.Fatal("index 2 must not be the elected writer")
	}
	// Elected writer alive and publishing → the follower stays quiet.
	fresh := now.Add(-5 * time.Second).Format("2006-01-02 15:04:05.000Z")
	if zoneStatsIsStale(fresh, now, zoneStatsStaleAfter) {
		t.Fatal("a freshly written row must not look stale")
	}
	// Elected writer gone: the row stops moving, and it must go stale WELL before
	// the 45s roster TTL would remove that writer — otherwise the dashboard (30s)
	// calls the zone dead while two workers are healthy.
	if zoneStatsStaleAfter >= rosterTTL {
		t.Fatalf("zoneStatsStaleAfter (%s) must be shorter than rosterTTL (%s) or the fallback is pointless",
			zoneStatsStaleAfter, rosterTTL)
	}
	quiet := now.Add(-zoneStatsStaleAfter - time.Second).Format("2006-01-02 15:04:05.000Z")
	if !zoneStatsIsStale(quiet, now, zoneStatsStaleAfter) {
		t.Fatal("a row that stopped moving must go stale so a follower takes over")
	}
}

// The bug a local e2e run caught: a worker whose first roster read failed kept
// the default (0, 1), read it as "I am index 0", and published zone_stats
// alongside the real writer — so `workers` flapped between the true roster size
// and 1.
//
// It must still OWN everything in that state: not checking is the worse failure.
// Only the publishing claim is withdrawn.
func TestUnreadRosterDoesNotClaimTheElection(t *testing.T) {
	mem := newMembership()

	if mem.isStatsWriter() {
		t.Error("a worker that has never read the roster must not claim the election")
	}
	if !mem.ownsMonitor("m1") {
		t.Error("a worker that has never read the roster must still own its monitors")
	}

	// A successful read of a single-worker zone elects it, as before.
	mem.set(0, 1)
	if !mem.isStatsWriter() {
		t.Error("a lone worker must publish after a successful roster read")
	}
}
