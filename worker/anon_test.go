package main

import (
	"testing"

	"monitors/corelib/models"
)

func TestAnonStatus(t *testing.T) {
	cases := []struct {
		name   string
		result models.CheckResult
		want   string
	}{
		{"up", models.CheckResult{Up: true}, "up"},
		{"down", models.CheckResult{Up: false}, "down"},
		// A rate-limited/blocked response isn't a real outage — treat as up.
		{"blocked counts as up", models.CheckResult{Up: false, Blocked: true}, "up"},
	}
	for _, c := range cases {
		if got := anonStatus(c.result); got != c.want {
			t.Errorf("%s: anonStatus = %q, want %q", c.name, got, c.want)
		}
	}
}

// A row nobody has checked yet is due now: the visitor who just pressed "Try it
// free" is watching the page. Staggering it across the interval left them on
// "Checking…" for up to five minutes (#522).
func TestAnonFirstDueNeverCheckedIsNow(t *testing.T) {
	now := float64(1_000_000)
	for _, id := range []string{"a", "f0z1i906b5h53aq", "h836rndorcdk3w6", "zzzz"} {
		if got := anonFirstDue(models.Monitor{Id: id}, now); got != now {
			t.Fatalf("never-checked %q is due at +%vs, want now", id, got-now)
		}
	}
}

// After a restart, rows that were already checked keep the stable stagger, so a
// restart does not check every anon row in the same second.
func TestAnonFirstDueCheckedKeepsTheStagger(t *testing.T) {
	now := float64(1_000_000)
	m := models.Monitor{Id: "f0z1i906b5h53aq", LastChecked: "2026-10-10 22:30:39.000Z"}
	got := anonFirstDue(m, now)
	if want := now + startupOffset(m.Id, anonMinInterval); got != want {
		t.Fatalf("checked row due at %v, want the stagger %v", got, want)
	}
	if got < now || got >= now+anonMinInterval {
		t.Fatalf("checked row due at +%vs, outside [0,%d)", got-now, anonMinInterval)
	}
}
