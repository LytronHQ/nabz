package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// A planned stop used to take Go's default SIGTERM path: an immediate exit that
// abandoned the check in flight, its result never written (#417). Cancelling must
// stop new checks from starting, and drainChecks must wait for the running one.
func TestCancelStopsNewChecksAndDrainWaitsForTheRunningOne(t *testing.T) {
	sched := newSchedule()
	now := float64(time.Now().Unix())
	for _, id := range []string{"a", "b", "c"} {
		sched.Add(id, now-1)
	}
	checks := newPool(1)

	var started, finished int64
	release := make(chan struct{})
	firstStarted := make(chan struct{})
	process := func(id string, due float64) {
		if atomic.AddInt64(&started, 1) == 1 {
			close(firstStarted)
		}
		<-release
		atomic.AddInt64(&finished, 1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	loopDone := make(chan struct{})
	go func() {
		dispatch(ctx, sched, checks, process)
		close(loopDone)
	}()

	<-firstStarted
	cancel()
	// The loop is blocked handing the second monitor to a full pool; releasing the
	// first check frees the slot. Whatever happens, nothing new may start after the
	// cancel has been observed, and the loop must return.
	close(release)
	select {
	case <-loopDone:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch did not return after cancel")
	}

	if !drainChecks(checks, 5*time.Second) {
		t.Fatal("drain timed out with checks still running")
	}
	s, f := atomic.LoadInt64(&started), atomic.LoadInt64(&finished)
	if s != f {
		t.Fatalf("%d checks started but only %d finished: the drain returned early", s, f)
	}
	if s > 2 {
		t.Fatalf("%d checks started; after cancel at most the one already handed to the pool may run", s)
	}
	if sched.Len() < 1 {
		t.Fatalf("schedule has %d left; cancelled dispatch should leave the rest unpopped", sched.Len())
	}
}

// A check that never returns must not hold the process past the grace period:
// the drain gives up and says so, and Docker's SIGKILL is not the only bound.
func TestDrainGivesUpAfterItsLimit(t *testing.T) {
	checks := newPool(1)
	block := make(chan struct{})
	defer close(block)
	checks.run(func() { <-block })

	start := time.Now()
	if drainChecks(checks, 50*time.Millisecond) {
		t.Fatal("drain reported success with a check still running")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("drain waited %s, past its 50ms limit", waited)
	}
}

// An idle loop sleeps between polls; a cancel during that sleep must end it at
// once, not after the backoff.
func TestCancelEndsAnIdleLoopPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		dispatch(ctx, newSchedule(), newPool(1), func(string, float64) {})
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(idlePollBackoff / 2):
		t.Fatal("an idle dispatch loop ignored the cancel until its backoff ran out")
	}
}
