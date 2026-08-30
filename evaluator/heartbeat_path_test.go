package main

import (
	"testing"
	"time"

	"monitors/corelib/pb"
)

func pbNow(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05.000Z") }

func TestCheckInPathDownDetectsAStaleBeat(t *testing.T) {
	now := time.Now().UTC()
	window := 90 * time.Second

	fresh := []pb.ZoneStat{{Zone: pb.WebZone, Updated: pbNow(now.Add(-10 * time.Second))}}
	if down, _, seen := checkInPathDown(fresh, window, now); down || !seen {
		t.Errorf("fresh beat: down=%v seen=%v, want false/true", down, seen)
	}

	stale := []pb.ZoneStat{{Zone: pb.WebZone, Updated: pbNow(now.Add(-10 * time.Minute))}}
	down, age, seen := checkInPathDown(stale, window, now)
	if !down || !seen {
		t.Errorf("stale beat: down=%v seen=%v, want true/true", down, seen)
	}
	if age < 9*time.Minute {
		t.Errorf("age = %s, want ~10m", age)
	}
}

func TestCheckInPathAbsentBeatIsTreatedAsHealthy(t *testing.T) {
	now := time.Now().UTC()
	// An environment that has not deployed the cron must keep alerting normally.
	// Treating "never seen" as broken would silently disable heartbeat alerting
	// forever — the same failure, arrived at from the other side.
	rows := []pb.ZoneStat{{Zone: "eu-central", Updated: pbNow(now)}, {Zone: pb.EvaluatorZone, Updated: pbNow(now)}}
	if down, _, seen := checkInPathDown(rows, 90*time.Second, now); down || seen {
		t.Errorf("absent beat: down=%v seen=%v, want false/false", down, seen)
	}
}

func TestCheckInPathIgnoresOtherZones(t *testing.T) {
	now := time.Now().UTC()
	// A dead worker zone must not be mistaken for a broken check-in path; they
	// are unrelated failures with opposite responses.
	rows := []pb.ZoneStat{
		{Zone: "eu-central", Updated: pbNow(now.Add(-time.Hour))},
		{Zone: pb.WebZone, Updated: pbNow(now)},
	}
	if down, _, _ := checkInPathDown(rows, 90*time.Second, now); down {
		t.Error("a stale worker zone must not mark the check-in path down")
	}
}

func TestCheckInPathUnparseableTimestampIsNotTreatedAsDown(t *testing.T) {
	now := time.Now().UTC()
	rows := []pb.ZoneStat{{Zone: pb.WebZone, Updated: "not-a-time"}}
	if down, _, seen := checkInPathDown(rows, 90*time.Second, now); down || seen {
		t.Errorf("garbage timestamp: down=%v seen=%v, want false/false", down, seen)
	}
}

func TestHeartbeatStatusIsUnaffectedByTheHold(t *testing.T) {
	// The hold must not change the verdict itself — only whether it pages. The UI
	// keeps telling the truth while the incident waits.
	now := time.Now().UTC()
	silent := pbNow(now.Add(-1 * time.Hour))
	if got := heartbeatStatus(silent, 60, now); got != StatusDown {
		t.Errorf("status = %q, want down regardless of path state", got)
	}
}
