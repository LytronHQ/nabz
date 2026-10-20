package main

import (
	"math"
	"testing"
	"time"

	"monitors/corelib/pb"
)

// A failure the worker blamed on its own network (#598) abstains, like a
// blocked one: it can neither open an incident nor resolve one.
func TestBuildZoneEvalAbstainsOnInconclusive(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Format("2006-01-02 15:04:05.000Z")
	ze := buildZoneEval([]pb.CheckRecord{
		{Zone: "ap", Up: false, Inconclusive: true, CheckedAt: fresh},
	}, now, time.Minute)
	if ze.Fresh {
		t.Fatalf("an inconclusive latest check must abstain, got %+v", ze)
	}
}

// ...and it does not extend a run of genuine failures.
func TestInconclusiveBreaksTrailingDownStreak(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Format("2006-01-02 15:04:05.000Z")
	ze := buildZoneEval([]pb.CheckRecord{
		{Zone: "ap", Up: false, StatusCode: 500, CheckedAt: fresh},
		{Zone: "ap", Up: false, Inconclusive: true, CheckedAt: fresh},
		{Zone: "ap", Up: false, StatusCode: 500, CheckedAt: fresh},
	}, now, time.Minute)
	if ze.TrailingDown != 1 {
		t.Fatalf("want TrailingDown=1, got %d", ze.TrailingDown)
	}
}

// The 2026-10-19 morning in miniature: Singapore's worker lost its network,
// Europe saw the site up the whole time. Singapore's inconclusive failures
// leave its hour out of uptime; a genuine Singapore failure still counts.
func TestAggregateByZoneLeavesInconclusiveOut(t *testing.T) {
	from, _ := time.Parse(time.RFC3339, "2026-10-19T10:00:00Z")
	to := from.Add(time.Hour)
	checks := []pb.CheckRecord{
		{Zone: "ap", Up: true, ResponseMs: 100, CheckedAt: "2026-10-19T10:50:00Z"},
		{Zone: "ap", Up: false, Inconclusive: true, ResponseMs: 20000, CheckedAt: "2026-10-19T10:52:00Z"},
		{Zone: "ap", Up: false, Inconclusive: true, ResponseMs: 20000, CheckedAt: "2026-10-19T10:53:00Z"},
		{Zone: "ap", Up: true, ResponseMs: 120, CheckedAt: "2026-10-19T10:58:00Z"},
		{Zone: "eu", Up: true, ResponseMs: 50, CheckedAt: "2026-10-19T10:52:00Z"},
		{Zone: "eu", Up: false, ResponseMs: 70, CheckedAt: "2026-10-19T10:59:00Z"},
	}
	out := aggregateByZone(checks, from, to)
	ap := out["ap"]
	if ap.count != 2 || ap.uptimePct != 100 {
		t.Fatalf("ap: want 2 counted checks at 100%%, got count=%d uptime=%v", ap.count, ap.uptimePct)
	}
	// The response times of checks that never reached the site are not latency.
	if ap.maxMs != 120 {
		t.Fatalf("ap max ms = %v, want 120 (the 20 s timeouts are left out)", ap.maxMs)
	}
	eu := out["eu"]
	if eu.count != 2 || math.Abs(eu.uptimePct-50) > 0.01 {
		t.Fatalf("eu: a genuine failure still counts, got count=%d uptime=%v", eu.count, eu.uptimePct)
	}
}
