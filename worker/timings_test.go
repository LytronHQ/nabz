package main

import (
	"testing"
	"time"
)

// Restore the deployed values after each case: these are process-wide, and a
// test that leaves 1s intervals behind would quietly change what every other
// test in this package is measuring.
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
	t.Cleanup(func() {
		reconcileInterval, statsInterval = defaultReconcileInterval, defaultStatsInterval
		heartbeatInterval, rosterTTL = defaultHeartbeatInterval, defaultRosterTTL
		zoneStatsStaleAfter = 3 * defaultStatsInterval
	})
}

// An unset environment must behave exactly as the deployed fleet does. This is
// the case that matters most: the override exists for tests, and production
// never sets it.
func TestUnsetTimingsAreTheDeployedOnes(t *testing.T) {
	withEnv(t, map[string]string{})
	if err := loadTimings(); err != nil {
		t.Fatalf("loadTimings with nothing set: %s", err)
	}
	cases := []struct {
		name      string
		got, want time.Duration
	}{
		{"heartbeat", heartbeatInterval, 10 * time.Second},
		{"reconcile", reconcileInterval, 30 * time.Second},
		{"stats", statsInterval, 10 * time.Second},
		{"roster TTL", rosterTTL, 45 * time.Second},
		{"stats stale after", zoneStatsStaleAfter, 30 * time.Second},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %s, want %s", c.name, c.got, c.want)
		}
	}
}

func TestTimingsAreOverridable(t *testing.T) {
	withEnv(t, map[string]string{
		"WORKER_HEARTBEAT_INTERVAL": "1",
		"WORKER_RECONCILE_INTERVAL": "2",
		"WORKER_STATS_INTERVAL":     "1",
		"WORKER_ROSTER_TTL":         "4",
	})
	if err := loadTimings(); err != nil {
		t.Fatalf("a valid fast configuration was rejected: %s", err)
	}
	if heartbeatInterval != time.Second || reconcileInterval != 2*time.Second ||
		statsInterval != time.Second || rosterTTL != 4*time.Second {
		t.Fatalf("overrides not applied: hb=%s rec=%s stats=%s ttl=%s",
			heartbeatInterval, reconcileInterval, statsInterval, rosterTTL)
	}
	// Derived, not configured — and still inside the TTL.
	if zoneStatsStaleAfter != 3*time.Second {
		t.Errorf("zoneStatsStaleAfter = %s, want 3s", zoneStatsStaleAfter)
	}
	if zoneStatsStaleAfter >= rosterTTL {
		t.Errorf("the fast configuration broke the fallback: stale after %s, TTL %s", zoneStatsStaleAfter, rosterTTL)
	}
}

// A TTL shorter than twice the heartbeat means one slow round trip to PocketBase
// unschedules a worker from its own zone. Individually sane numbers, wrong
// together — which is the whole reason this is validated rather than trusted.
func TestTTLMustSurviveAMissedBeat(t *testing.T) {
	withEnv(t, map[string]string{
		"WORKER_HEARTBEAT_INTERVAL": "10",
		"WORKER_ROSTER_TTL":         "15",
	})
	err := loadTimings()
	if err == nil {
		t.Fatal("a TTL shorter than two heartbeats was accepted")
	}
	if !contains(err.Error(), "WORKER_ROSTER_TTL") {
		t.Errorf("the error should name the offending variable, got: %s", err)
	}
}

// If the stats row only goes stale after its writer has already left the roster,
// the fallback cannot fire while it is needed and a zone with live workers reads
// as dead.
func TestStatsStalenessMustBeatTheRosterTTL(t *testing.T) {
	withEnv(t, map[string]string{
		"WORKER_HEARTBEAT_INTERVAL": "5",
		"WORKER_STATS_INTERVAL":     "20",
		"WORKER_ROSTER_TTL":         "30",
	})
	if err := loadTimings(); err == nil {
		t.Fatal("a stats interval that outlives the roster TTL was accepted")
	}
}

func TestRejectsNonsense(t *testing.T) {
	for _, v := range []string{"0", "-5", "abc", "10s", "1.5"} {
		withEnv(t, map[string]string{"WORKER_HEARTBEAT_INTERVAL": v})
		if err := loadTimings(); err == nil {
			t.Errorf("WORKER_HEARTBEAT_INTERVAL=%q was accepted", v)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
