package main

import (
	"testing"
	"time"
)

func TestCertNeedsAlert(t *testing.T) {
	now := time.Now().UTC()
	warn := 14 * 24 * time.Hour

	cases := []struct {
		name    string
		expires time.Time
		want    bool
	}{
		{"within window (10 days)", now.Add(10 * 24 * time.Hour), true},
		{"exactly at window boundary (14 days)", now.Add(14 * 24 * time.Hour), true},
		{"beyond window (30 days)", now.Add(30 * 24 * time.Hour), false},
		{"already expired", now.Add(-1 * time.Hour), true},
		{"zero time (unknown / not HTTPS)", time.Time{}, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := certNeedsAlert(c.expires, now, warn); got != c.want {
				t.Fatalf("certNeedsAlert(%v) = %v, want %v", c.expires, got, c.want)
			}
		})
	}
}
