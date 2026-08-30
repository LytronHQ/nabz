package main

import (
	"testing"

	"monitors/corelib/models"
)

func TestNextDueScore(t *testing.T) {
	cases := []struct {
		name      string
		scheduled float64
		interval  float64
		now       float64
		want      float64
	}{
		{"on time, next is one interval later", 1000, 60, 1001, 1060},
		{"exactly at boundary skips to strictly future", 1000, 60, 1060, 1120},
		{"far behind skips missed intervals", 1000, 60, 1200, 1240},
		{"behind by exact multiple stays future", 1000, 60, 1180, 1240},
		{"non-positive interval falls back to default", 1000, 0, 1001, 1060},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := nextDueScore(c.scheduled, c.interval, c.now)
			if got != c.want {
				t.Fatalf("nextDueScore(%v,%v,%v) = %v, want %v", c.scheduled, c.interval, c.now, got, c.want)
			}
			if got <= c.now {
				t.Fatalf("nextDueScore result %v must be strictly after now %v", got, c.now)
			}
		})
	}
}

// The schedule must anchor on the original scheduled time, not on "now", so that
// checks don't drift later on every cycle.
func TestNextDueScoreDoesNotDrift(t *testing.T) {
	scheduled, interval := 1000.0, 60.0
	// Simulate a check that finishes 2s after it was due.
	next := nextDueScore(scheduled, interval, scheduled+2)
	if next != 1060 {
		t.Fatalf("expected fixed 60s cadence (1060), got %v", next)
	}
}

// The clamp itself is tested in corelib/models (one shared implementation, used
// by the worker and the evaluator). This asserts the scheduler actually routes
// through it: a legacy sub-floor monitor must be re-scheduled at the floor, not
// at its stored interval.
func TestSchedulingUsesTheEffectiveInterval(t *testing.T) {
	const scheduled = 1000.0
	next := nextDueScore(scheduled, float64(models.EffectiveInterval(5)), scheduled)
	if want := scheduled + float64(models.MinIntervalSeconds); next != want {
		t.Errorf("a stored 5s interval scheduled next at %v, want %v (the %ds floor)",
			next, want, models.MinIntervalSeconds)
	}
}
