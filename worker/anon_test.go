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
