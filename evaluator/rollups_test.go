package main

import (
	"math"
	"testing"
	"time"

	"monitors/corelib/pb"
)

func TestAggregateByZone(t *testing.T) {
	from, _ := time.Parse(time.RFC3339, "2020-01-01T00:00:00Z")
	to := from.Add(time.Hour)

	checks := []pb.CheckRecord{
		{Zone: "eu", Up: true, ResponseMs: 100, CheckedAt: "2020-01-01T00:10:00Z"},
		{Zone: "eu", Up: false, ResponseMs: 200, CheckedAt: "2020-01-01T00:20:00Z"},
		{Zone: "eu", Up: true, ResponseMs: 300, CheckedAt: "2020-01-01T00:30:00Z"},
		{Zone: "us", Up: true, ResponseMs: 50, CheckedAt: "2020-01-01T00:05:00Z"},
		// Outside the window — must be excluded.
		{Zone: "eu", Up: true, ResponseMs: 999, CheckedAt: "2020-01-01T01:30:00Z"},
	}

	out := aggregateByZone(checks, from, to)

	eu, ok := out["eu"]
	if !ok {
		t.Fatalf("expected eu stats")
	}
	if eu.count != 3 {
		t.Fatalf("eu count = %d, want 3", eu.count)
	}
	if math.Abs(eu.uptimePct-66.6667) > 0.01 {
		t.Fatalf("eu uptime = %v, want ~66.67", eu.uptimePct)
	}
	if eu.avgMs != 200 || eu.minMs != 100 || eu.maxMs != 300 {
		t.Fatalf("eu ms avg/min/max = %v/%v/%v, want 200/100/300", eu.avgMs, eu.minMs, eu.maxMs)
	}

	us := out["us"]
	if us.count != 1 || us.uptimePct != 100 || us.avgMs != 50 {
		t.Fatalf("us = %+v, want count1 uptime100 avg50", us)
	}
}

func TestAggregateRollups(t *testing.T) {
	// Two hourly buckets for eu (weighted differently), one for us.
	children := []pb.RollupRecord{
		{Zone: "eu", UptimePct: 100, AvgMs: 100, MinMs: 80, MaxMs: 120, CheckCount: 60},
		{Zone: "eu", UptimePct: 50, AvgMs: 200, MinMs: 50, MaxMs: 400, CheckCount: 20},
		{Zone: "us", UptimePct: 90, AvgMs: 30, MinMs: 10, MaxMs: 60, CheckCount: 100},
		// zero-count bucket must be ignored entirely.
		{Zone: "eu", UptimePct: 0, AvgMs: 0, MinMs: 0, MaxMs: 0, CheckCount: 0},
	}

	out := aggregateRollups(children)

	eu, ok := out["eu"]
	if !ok {
		t.Fatalf("expected eu stats")
	}
	// count = 80; up = 1.0*60 + 0.5*20 = 70 -> 87.5%; avg = (100*60 + 200*20)/80 = 125
	if eu.count != 80 {
		t.Fatalf("eu count = %d, want 80", eu.count)
	}
	if math.Abs(eu.uptimePct-87.5) > 1e-9 {
		t.Fatalf("eu uptime = %v, want 87.5", eu.uptimePct)
	}
	if math.Abs(eu.avgMs-125) > 1e-9 {
		t.Fatalf("eu avg = %v, want 125", eu.avgMs)
	}
	if eu.minMs != 50 || eu.maxMs != 400 {
		t.Fatalf("eu min/max = %v/%v, want 50/400", eu.minMs, eu.maxMs)
	}

	us := out["us"]
	if us.count != 100 || us.uptimePct != 90 || us.avgMs != 30 {
		t.Fatalf("us = %+v, want count100 uptime90 avg30", us)
	}
}
