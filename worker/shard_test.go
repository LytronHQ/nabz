package main

import (
	"fmt"
	"testing"
	"time"

	"monitors/corelib/pb"
)

const pbLayout = "2006-01-02 15:04:05.000Z"

var base = time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

func beat(worker string, ago time.Duration) pb.WorkerHeartbeat {
	return pb.WorkerHeartbeat{Worker: worker, Zone: "eu", Updated: base.Add(-ago).Format(pbLayout)}
}

func TestRosterDropsStaleWorkers(t *testing.T) {
	rows := []pb.WorkerHeartbeat{
		beat("w-alive", 5*time.Second),
		beat("w-dead", 2*time.Minute),
		beat("w-edge", 44*time.Second),
	}
	got := roster(rows, base, 45*time.Second)
	if fmt.Sprint(got) != fmt.Sprint([]string{"w-alive", "w-edge"}) {
		t.Fatalf("roster = %v, want [w-alive w-edge]", got)
	}
}

// An unreadable timestamp is not evidence of life.
func TestRosterTreatsUnparseableAsStale(t *testing.T) {
	rows := []pb.WorkerHeartbeat{
		{Worker: "good", Updated: base.Format(pbLayout)},
		{Worker: "bad", Updated: "not a timestamp"},
		{Worker: "empty", Updated: ""},
		{Worker: "", Updated: base.Format(pbLayout)}, // no id at all
	}
	if got := roster(rows, base, time.Minute); fmt.Sprint(got) != fmt.Sprint([]string{"good"}) {
		t.Fatalf("roster = %v, want [good]", got)
	}
}

// Every worker must derive the SAME ordering from the same rows, whatever order
// PocketBase happened to return them in — this is what keeps two workers from
// disagreeing about who owns what.
func TestRosterOrderingIsStableRegardlessOfInputOrder(t *testing.T) {
	a := roster([]pb.WorkerHeartbeat{beat("c", 0), beat("a", 0), beat("b", 0)}, base, time.Minute)
	b := roster([]pb.WorkerHeartbeat{beat("b", 0), beat("c", 0), beat("a", 0)}, base, time.Minute)
	want := fmt.Sprint([]string{"a", "b", "c"})
	if fmt.Sprint(a) != want || fmt.Sprint(b) != want {
		t.Fatalf("roster orderings disagree: %v vs %v, want %s", a, b, want)
	}
}

func TestRosterDeduplicates(t *testing.T) {
	got := roster([]pb.WorkerHeartbeat{beat("a", 0), beat("a", 0), beat("b", 0)}, base, time.Minute)
	if fmt.Sprint(got) != fmt.Sprint([]string{"a", "b"}) {
		t.Fatalf("roster = %v, want [a b]", got)
	}
}

func TestRosterEmpty(t *testing.T) {
	if got := roster(nil, base, time.Minute); len(got) != 0 {
		t.Fatalf("roster(nil) = %v, want empty", got)
	}
	if got := roster([]pb.WorkerHeartbeat{beat("old", time.Hour)}, base, time.Minute); len(got) != 0 {
		t.Fatalf("all-stale roster = %v, want empty", got)
	}
}

func TestIndexOf(t *testing.T) {
	r := []string{"a", "b", "c"}
	for want, id := range r {
		if got, ok := indexOf(r, id); !ok || got != want {
			t.Errorf("indexOf(%q) = (%d,%v), want (%d,true)", id, got, ok, want)
		}
	}
	if _, ok := indexOf(r, "missing"); ok {
		t.Error("indexOf found a worker that is not in the roster")
	}
	if _, ok := indexOf(nil, "a"); ok {
		t.Error("indexOf found a worker in an empty roster")
	}
}

// The property that matters most: for any roster size, every monitor is owned by
// exactly one index. Not "roughly one" — exactly.
func TestOwnershipIsAPartition(t *testing.T) {
	for count := 1; count <= 10; count++ {
		for i := 0; i < 500; i++ {
			id := fmt.Sprintf("monitor%d", i)
			owners := 0
			for idx := 0; idx < count; idx++ {
				if owns(id, idx, count) {
					owners++
				}
			}
			if owners != 1 {
				t.Fatalf("count=%d monitor=%s owned by %d workers, want exactly 1", count, id, owners)
			}
		}
	}
}

// A single worker owns everything, which is what keeps a one-worker zone on
// exactly the path it had before sharding existed.
func TestSingleWorkerOwnsEverything(t *testing.T) {
	for i := 0; i < 200; i++ {
		id := fmt.Sprintf("m%d", i)
		if !owns(id, 0, 1) {
			t.Fatalf("single worker did not own %s", id)
		}
		if !owns(id, 0, 0) {
			t.Fatalf("count=0 must behave as a single worker for %s", id)
		}
	}
}

// A worker that cannot find itself in the roster owns nothing: it has just
// learned its own heartbeat is not visible, which is the one moment it must not
// claim work its peers believe they own.
func TestOutOfRangeIndexOwnsNothing(t *testing.T) {
	for _, idx := range []int{-1, 3, 99} {
		if owns("m1", idx, 3) {
			t.Fatalf("index %d of 3 owned a monitor", idx)
		}
	}
}

// A wildly skewed hash would leave one worker doing everything. This is a
// sanity bound, not a uniformity proof.
func TestOwnershipIsRoughlyEven(t *testing.T) {
	const n, count = 3000, 3
	counts := make([]int, count)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("mon-%d-abc", i)
		for idx := 0; idx < count; idx++ {
			if owns(id, idx, count) {
				counts[idx]++
			}
		}
	}
	lo, hi := n/count/2, n/count*3/2
	for idx, c := range counts {
		if c < lo || c > hi {
			t.Fatalf("index %d owns %d of %d monitors, outside [%d,%d] — distribution is skewed", idx, c, n, lo, hi)
		}
	}
}

// Ownership must not depend on anything local: the same id and roster size give
// the same answer on every worker and every restart.
func TestOwnershipIsDeterministic(t *testing.T) {
	for i := 0; i < 100; i++ {
		id := fmt.Sprintf("monitor%d", i)
		first := owns(id, 1, 4)
		for r := 0; r < 5; r++ {
			if owns(id, 1, 4) != first {
				t.Fatalf("owns(%s,1,4) is not deterministic", id)
			}
		}
	}
}

// When the roster changes, ownership moves — that is the mechanism, and the test
// exists to show it actually moves rather than silently keeping everything.
func TestOwnershipMovesWhenTheRosterChanges(t *testing.T) {
	moved := 0
	for i := 0; i < 300; i++ {
		id := fmt.Sprintf("m%d", i)
		if owns(id, 0, 2) != owns(id, 0, 3) {
			moved++
		}
	}
	if moved == 0 {
		t.Fatal("no monitor changed owner when the roster grew from 2 to 3")
	}
}
