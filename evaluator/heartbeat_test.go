package main

import (
	"testing"
	"time"

	"monitors/corelib/pb"
)

func TestHeartbeatWindow(t *testing.T) {
	cases := []struct {
		interval int
		want     time.Duration
	}{
		{60, 90 * time.Second},   // grace = interval/2 = 30s
		{300, 450 * time.Second}, // grace = 150s
		{10, 40 * time.Second},   // grace floored at 30s (interval/2 = 5s < 30s)
		{0, heartbeatWindow(60)}, // 0 -> defaultInterval (60)
	}
	for _, c := range cases {
		if got := heartbeatWindow(c.interval); got != c.want {
			t.Errorf("heartbeatWindow(%d) = %s, want %s", c.interval, got, c.want)
		}
	}
}

func TestHeartbeatStatus(t *testing.T) {
	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	fmtPB := func(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05.000Z") }
	// interval 60 -> window 90s.
	cases := []struct {
		name        string
		lastChecked string
		want        Status
	}{
		{"never checked in", "", StatusPending},
		{"just checked in", fmtPB(now.Add(-5 * time.Second)), StatusUp},
		{"within window", fmtPB(now.Add(-89 * time.Second)), StatusUp},
		{"just past window", fmtPB(now.Add(-91 * time.Second)), StatusDown},
		{"long silent", fmtPB(now.Add(-10 * time.Minute)), StatusDown},
	}
	for _, c := range cases {
		if got := heartbeatStatus(c.lastChecked, 60, now); got != c.want {
			t.Errorf("%s: heartbeatStatus(%q) = %q, want %q", c.name, c.lastChecked, got, c.want)
		}
	}
}

// The web liveness beat is a 2-minute cron, so judging it on the 90s zone deadman
// made a punctual beat look stale for the last 30s of every cycle — and this gate
// HOLDS heartbeat incidents while it believes the check-in path is down. Healthy
// systems would have had heartbeat alerting suppressed about a quarter of the time.
func TestCheckInPathWindowMatchesTheBeatCadence(t *testing.T) {
	now := time.Now().UTC()
	zones := func(ago time.Duration) []pb.ZoneStat {
		return []pb.ZoneStat{{Zone: pb.WebZone, Updated: now.Add(-ago).Format("2006-01-02 15:04:05.000Z")}}
	}

	// 100s: older than the 90s deadman, well inside the 2-minute cadence.
	if down, _, seen := checkInPathDown(zones(100*time.Second), 300*time.Second, now); !seen || down {
		t.Fatalf("a 100s-old beat must not read as down on the web window: down=%v seen=%v", down, seen)
	}
	// Two consecutive misses is a real signal.
	if down, _, seen := checkInPathDown(zones(400*time.Second), 300*time.Second, now); !seen || !down {
		t.Fatalf("a 400s-old beat must read as down: down=%v seen=%v", down, seen)
	}
}
