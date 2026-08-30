package main

import (
	"strings"
	"testing"
)

func TestSplitCSVTreatsEmptyAsNone(t *testing.T) {
	// strings.Split("", ",") returns [""] — one element, not zero — which would
	// make "no zone is reporting" look like "one zone named empty string".
	if got := splitCSV(""); len(got) != 0 {
		t.Fatalf("splitCSV(\"\") = %#v, want empty", got)
	}
	if got := splitCSV("eu-central"); len(got) != 1 || got[0] != "eu-central" {
		t.Fatalf("got %#v", got)
	}
	if got := splitCSV("eu-central,us-east"); len(got) != 2 {
		t.Fatalf("got %#v", got)
	}
}

// The decision table the UI has to explain. These assertions are the contract
// #328 is about: M is what changes when a zone goes quiet, and the rule that
// applies changes with it.
func TestDecideRuleChangesWithTheNumberOfFreshZones(t *testing.T) {
	down := ZoneEval{Fresh: true, Up: false, TrailingDown: 1}
	downStreak := ZoneEval{Fresh: true, Up: false, TrailingDown: 2}
	up := ZoneEval{Fresh: true, Up: true}
	absent := ZoneEval{Fresh: false}

	// Two assigned zones, both voting: disagreement cannot open an incident.
	if got := decide([]ZoneEval{down, up}, 2); got != StatusPending {
		t.Errorf("two zones disagreeing = %q, want pending", got)
	}
	// The same monitor after one zone goes quiet: now a single zone with a
	// consecutive-failure run is enough to call it down. Same inputs from the
	// surviving zone, different verdict — this is the silent weakening.
	if got := decide([]ZoneEval{downStreak, absent}, 2); got != StatusDown {
		t.Errorf("one fresh zone with a streak = %q, want down", got)
	}
	// And with no zone reporting it is unjudged, not up and not down.
	if got := decide([]ZoneEval{absent, absent}, 2); got != StatusPending {
		t.Errorf("no fresh zone = %q, want pending", got)
	}
}

func TestUnjudgedKeyIsNamespacedAndReversible(t *testing.T) {
	k := unjudgedKey("mon123")
	if !strings.HasPrefix(k, stateKindUnjudged+":") {
		t.Fatalf("key %q is not namespaced", k)
	}
	kind, subject, ok := splitStateKey(k)
	if !ok || kind != stateKindUnjudged || subject != "mon123" {
		t.Fatalf("round-trip failed: (%q, %q, %v)", kind, subject, ok)
	}
}

func TestHydrateRestoresTheUnjudgedFlag(t *testing.T) {
	// Without this a restart re-notifies the owner that a monitor is unchecked,
	// which is the #327 failure repeated on a new alerter.
	store := newMemAlertState()
	store.Put(unjudgedKey("mon123"), "1")
	unjudged := map[string]bool{}
	hydrate(store, map[string]bool{}, nil, nil, map[string]*latencyState{}, unjudged)
	if !unjudged["mon123"] {
		t.Error("unjudged flag did not survive a restart")
	}
}
