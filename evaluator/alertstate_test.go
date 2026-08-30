package main

import (
	"errors"
	"testing"
	"time"
)

// failingStore stands in for PocketBase being unreachable at startup.
type failingStore struct{ *memAlertState }

func (failingStore) Load() (map[string]string, error) { return nil, errors.New("pb down") }

func TestHydrateRestoresEveryAlerterState(t *testing.T) {
	store := newMemAlertState()
	certExpiry := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	domainExpiry := time.Date(2026, 12, 25, 0, 0, 0, 0, time.UTC)

	store.Put(stateKey(stateKindZoneSilent, "eu-central"), "1")
	store.Put(stateKey(stateKindCert, "mon1"), certExpiry.Format(time.RFC3339))
	store.Put(stateKey(stateKindDomain, "mon2"), domainExpiry.Format(time.RFC3339))
	store.Put(stateKey(stateKindLatency, "mon3"), "1")

	silent := map[string]bool{}
	cert := map[string]time.Time{}
	domain := map[string]time.Time{}
	latency := map[string]*latencyState{}
	unjudged := map[string]bool{}
	hydrate(store, silent, cert, domain, latency, unjudged)

	if !silent["eu-central"] {
		t.Error("zone should still be known-silent after a restart, or the dead-man switch re-fires")
	}
	if got := cert["mon1"]; !got.Equal(certExpiry) {
		t.Errorf("cert expiry = %v, want %v", got, certExpiry)
	}
	if got := domain["mon2"]; !got.Equal(domainExpiry) {
		t.Errorf("domain expiry = %v, want %v", got, domainExpiry)
	}
	// The important half of #327: without this the recovery message is never
	// sent, because it only goes out when the alerter believes it alerted.
	if st := latency["mon3"]; st == nil || !st.alerted {
		t.Error("latency must resume as alerted so the recovery still fires")
	}
	// breachStreak deliberately does not survive: it rebuilds in a few ticks and
	// losing it only delays an alert.
	if st := latency["mon3"]; st != nil && st.breachStreak != 0 {
		t.Errorf("breachStreak = %d, want 0", st.breachStreak)
	}
}

func TestHydrateSurvivesAnUnreadableStore(t *testing.T) {
	silent := map[string]bool{}
	// Must not panic and must leave usable empty state — degrading to today's
	// behaviour beats refusing to boot the evaluator.
	hydrate(failingStore{newMemAlertState()}, silent, map[string]time.Time{}, map[string]time.Time{}, map[string]*latencyState{}, map[string]bool{})
	if len(silent) != 0 {
		t.Errorf("expected empty state, got %v", silent)
	}
}

func TestHydrateIgnoresJunkRows(t *testing.T) {
	store := newMemAlertState()
	store.Put("no-colon", "1")
	store.Put(stateKey(stateKindCert, "mon1"), "not-a-timestamp")
	store.Put("unknown.kind:mon2", "1")

	cert := map[string]time.Time{}
	hydrate(store, map[string]bool{}, cert, map[string]time.Time{}, map[string]*latencyState{}, map[string]bool{})
	if len(cert) != 0 {
		t.Errorf("an unparseable expiry must be dropped, not zero-valued: %v", cert)
	}
}

func TestSplitStateKeySplitsOnFirstColon(t *testing.T) {
	// Subjects can contain colons; truncating one would silently address a
	// different key and resurrect the bug this table exists to fix.
	kind, subject, ok := splitStateKey("cert:mon:with:colons")
	if !ok || kind != "cert" || subject != "mon:with:colons" {
		t.Errorf("got (%q, %q, %v)", kind, subject, ok)
	}
	for _, bad := range []string{"nocolon", ":leading", "trailing:"} {
		if _, _, ok := splitStateKey(bad); ok {
			t.Errorf("%q should not parse", bad)
		}
	}
}

func TestMemAlertStateRoundTrips(t *testing.T) {
	s := newMemAlertState()
	s.Put("k", "v")
	got, err := s.Load()
	if err != nil || got["k"] != "v" {
		t.Fatalf("Load() = %v, %v", got, err)
	}
	s.Delete("k")
	got, _ = s.Load()
	if _, still := got["k"]; still {
		t.Error("Delete did not clear the key")
	}
	// Load must hand back a copy; a caller mutating it must not corrupt the store.
	got["k"] = "resurrected"
	fresh, _ := s.Load()
	if _, leaked := fresh["k"]; leaked {
		t.Error("Load returned the live map")
	}
}
