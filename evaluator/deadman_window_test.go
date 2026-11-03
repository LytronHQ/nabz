package main

import (
	"testing"
	"time"

	"monitors/corelib/pb"
)

// #656: the web's liveness beat is a cron every 120 s, but the dead-man judged it
// on the zones' 90 s window, so a punctual beat read "silent" in nearly every
// cycle — 692 false `zone "web" is silent` lines on 22 Oct 2026 alone.
func TestSilenceWindowJudgesTheWebOnItsOwnBeat(t *testing.T) {
	cfg := alertConfig{deadman: 90 * time.Second, webBeat: 300 * time.Second}
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	at := func(ago time.Duration) string { return now.Add(-ago).Format("2006-01-02 15:04:05.000Z") }

	cases := []struct {
		zone  string
		ago   time.Duration
		stale bool
	}{
		{pb.WebZone, 115 * time.Second, false}, // one punctual cron cycle
		{pb.WebZone, 250 * time.Second, false}, // one missed run, still inside 5 min
		{pb.WebZone, 310 * time.Second, true},
		{"eu-central", 60 * time.Second, false},
		{"eu-central", 115 * time.Second, true}, // zones beat every 10 s: 90 s still applies
	}
	for _, c := range cases {
		got := isHeartbeatStale(at(c.ago), now, silenceWindow(c.zone, cfg))
		if got != c.stale {
			t.Errorf("zone %q last seen %s ago: stale=%v, want %v", c.zone, c.ago, got, c.stale)
		}
	}
}
