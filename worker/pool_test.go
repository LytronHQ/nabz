package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The cap is the whole point: a pool that lets everything through is just `go f()`.
func TestPoolRunsAtMostSizeAtOnce(t *testing.T) {
	const size = 4
	p := newPool(size)

	var inFlight, peak int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		p.run(func() {
			defer wg.Done()
			n := atomic.AddInt64(&inFlight, 1)
			for {
				old := atomic.LoadInt64(&peak)
				if n <= old || atomic.CompareAndSwapInt64(&peak, old, n) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			atomic.AddInt64(&inFlight, -1)
		})
	}
	wg.Wait()
	p.wait()

	if got := atomic.LoadInt64(&peak); got > size {
		t.Fatalf("peak concurrency %d exceeded the pool size %d", got, size)
	}
	if got := atomic.LoadInt64(&peak); got < 2 {
		t.Fatalf("peak concurrency %d — the pool never ran anything in parallel", got)
	}
}

func TestPoolRunsEveryTask(t *testing.T) {
	p := newPool(3)
	var done int64
	for i := 0; i < 100; i++ {
		p.run(func() { atomic.AddInt64(&done, 1) })
	}
	p.wait()

	if got := atomic.LoadInt64(&done); got != 100 {
		t.Fatalf("ran %d tasks, want 100", got)
	}
}

// An unset or nonsensical WORKER_CONCURRENCY must still check monitors — serially,
// which is exactly the old behaviour.
func TestPoolClampsSizeBelowOne(t *testing.T) {
	for _, size := range []int{0, -5} {
		p := newPool(size)
		if p.size() != 1 {
			t.Fatalf("newPool(%d).size() = %d, want 1", size, p.size())
		}
	}
	p := newPool(1)
	var concurrent, peak int64
	for i := 0; i < 20; i++ {
		p.run(func() {
			n := atomic.AddInt64(&concurrent, 1)
			if n > atomic.LoadInt64(&peak) {
				atomic.StoreInt64(&peak, n)
			}
			time.Sleep(time.Millisecond)
			atomic.AddInt64(&concurrent, -1)
		})
	}
	p.wait()
	if got := atomic.LoadInt64(&peak); got != 1 {
		t.Fatalf("a size-1 pool ran %d tasks at once, want strictly serial", got)
	}
}

// run must block rather than queue: that is what makes the schedule, not an
// unbounded goroutine pile, absorb a zone falling behind.
func TestPoolRunBlocksWhenFull(t *testing.T) {
	p := newPool(1)
	release := make(chan struct{})
	p.run(func() { <-release })

	returned := make(chan struct{})
	go func() {
		p.run(func() {})
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("run returned while the only slot was occupied")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("run never returned after a slot freed up")
	}
	p.wait()
}
