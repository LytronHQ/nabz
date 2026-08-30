package main

import (
	"testing"
	"time"
)

func TestDomainNeedsAlert(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	warn := 30 * 24 * time.Hour
	cases := []struct {
		name    string
		expires time.Time
		want    bool
	}{
		{"unknown (zero) never warns", time.Time{}, false},
		{"far future is quiet", now.Add(90 * 24 * time.Hour), false},
		{"just outside the window", now.Add(31 * 24 * time.Hour), false},
		{"inside the window warns", now.Add(10 * 24 * time.Hour), true},
		{"already expired warns", now.Add(-24 * time.Hour), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := domainNeedsAlert(c.expires, now, warn); got != c.want {
				t.Errorf("domainNeedsAlert = %v, want %v", got, c.want)
			}
		})
	}
}

func TestDomainRefreshDue(t *testing.T) {
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		checkedAt string
		want      bool
	}{
		{"never checked is due", "", true},
		{"unparseable is due", "not-a-time", true},
		{"checked just now is fresh", now.Add(-1 * time.Hour).Format(time.RFC3339), false},
		{"checked within TTL is fresh", now.Add(-23 * time.Hour).Format(time.RFC3339), false},
		{"checked past TTL is due", now.Add(-25 * time.Hour).Format(time.RFC3339), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := domainRefreshDue(c.checkedAt, now); got != c.want {
				t.Errorf("domainRefreshDue(%q) = %v, want %v", c.checkedAt, got, c.want)
			}
		})
	}
}
