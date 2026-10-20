package main

import (
	"fmt"
	"math/rand"
	"sort"
	"sync"
	"testing"
)

// drain pops everything due at or before now, in the order the schedule hands it
// out.
func drain(s *schedule, now float64) []string {
	var got []string
	for {
		id, _, ok := s.PopDue(now)
		if !ok {
			return got
		}
		got = append(got, id)
	}
}

func TestPopDueReturnsEarliestFirst(t *testing.T) {
	s := newSchedule()
	s.Add("b", 200)
	s.Add("a", 100)
	s.Add("c", 300)

	if got := drain(s, 1000); len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("drained %v, want [a b c]", got)
	}
	if s.Len() != 0 {
		t.Fatalf("Len = %d after draining, want 0", s.Len())
	}
}

// Nothing scheduled in the future may be handed out early — that cutoff is the
// whole schedule.
func TestPopDueRespectsTheDueCutoff(t *testing.T) {
	s := newSchedule()
	s.Add("soon", 100)
	s.Add("later", 500)

	if id, due, ok := s.PopDue(99); ok {
		t.Fatalf("PopDue(99) handed out %q (due %v) with nothing due", id, due)
	}
	id, due, ok := s.PopDue(100)
	if !ok || id != "soon" || due != 100 {
		t.Fatalf("PopDue(100) = (%q,%v,%v), want (soon,100,true)", id, due, ok)
	}
	if _, _, ok := s.PopDue(499); ok {
		t.Fatal("PopDue(499) handed out the future item")
	}
}

// A popped monitor is IN FLIGHT: it is out of the set until the caller
// reschedules it, so it can never be handed out twice concurrently.
func TestPopDueRemovesTheItem(t *testing.T) {
	s := newSchedule()
	s.Add("m1", 100)

	if _, _, ok := s.PopDue(200); !ok {
		t.Fatal("first PopDue found nothing")
	}
	if s.Len() != 0 {
		t.Fatalf("Len = %d while the check is in flight, want 0", s.Len())
	}
	if _, _, ok := s.PopDue(200); ok {
		t.Fatal("PopDue handed the same monitor out twice")
	}
}

func TestAddIfAbsentDoesNotDisturbAnExistingSchedule(t *testing.T) {
	s := newSchedule()
	if added := s.AddIfAbsent("m1", 100); !added {
		t.Fatal("AddIfAbsent on an empty set reported no insert")
	}
	if added := s.AddIfAbsent("m1", 999); added {
		t.Fatal("AddIfAbsent overwrote a monitor that was already scheduled")
	}
	if due, ok := s.EarliestDue(); !ok || due != 100 {
		t.Fatalf("EarliestDue = (%v,%v), want (100,true) — the original score must hold", due, ok)
	}
}

func TestAddUpserts(t *testing.T) {
	s := newSchedule()
	s.Add("m1", 100)
	s.Add("m1", 50)

	if s.Len() != 1 {
		t.Fatalf("Len = %d after re-adding the same id, want 1", s.Len())
	}
	if due, _ := s.EarliestDue(); due != 50 {
		t.Fatalf("EarliestDue = %v, want the upserted 50", due)
	}
}

// Update must not resurrect a monitor the reconcile pass pruned — otherwise a
// disabled monitor would come back the moment its in-flight check rescheduled.
func TestUpdateOnlyMovesTrackedMonitors(t *testing.T) {
	s := newSchedule()
	s.Add("m1", 100)

	if ok := s.Update("m1", 300); !ok {
		t.Fatal("Update on a tracked monitor reported it missing")
	}
	if due, _ := s.EarliestDue(); due != 300 {
		t.Fatalf("EarliestDue = %v after Update, want 300", due)
	}
	if ok := s.Update("gone", 10); ok {
		t.Fatal("Update reported success for an untracked id")
	}
	if s.Len() != 1 {
		t.Fatalf("Len = %d, want 1 — Update must not insert", s.Len())
	}
}

func TestRemove(t *testing.T) {
	s := newSchedule()
	s.Add("a", 100)
	s.Add("b", 200)

	if ok := s.Remove("a"); !ok {
		t.Fatal("Remove reported a tracked monitor as missing")
	}
	if ok := s.Remove("a"); ok {
		t.Fatal("Remove reported success twice for the same id")
	}
	if got := drain(s, 1000); len(got) != 1 || got[0] != "b" {
		t.Fatalf("drained %v after Remove, want [b]", got)
	}
}

// Removing from the middle has to keep the heap ordered — this is the case a
// stale `index` silently breaks.
func TestRemoveFromTheMiddleKeepsTheOrder(t *testing.T) {
	s := newSchedule()
	for i, id := range []string{"a", "b", "c", "d", "e"} {
		s.Add(id, float64(100*(i+1)))
	}
	s.Remove("c")

	got := drain(s, 1000)
	want := []string{"a", "b", "d", "e"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("drained %v, want %v", got, want)
	}
}

func TestEarliestDueAndLenOnAnEmptySet(t *testing.T) {
	s := newSchedule()
	if _, ok := s.EarliestDue(); ok {
		t.Fatal("EarliestDue reported a due time for an empty set")
	}
	if s.Len() != 0 {
		t.Fatalf("Len = %d on an empty set", s.Len())
	}
	if ids := s.Ids(); len(ids) != 0 {
		t.Fatalf("Ids = %v on an empty set", ids)
	}
}

func TestIdsListsEverythingTracked(t *testing.T) {
	s := newSchedule()
	s.Add("a", 100)
	s.Add("b", 200)
	s.Add("c", 300)
	s.Remove("b")

	ids := s.Ids()
	sort.Strings(ids)
	if fmt.Sprint(ids) != fmt.Sprint([]string{"a", "c"}) {
		t.Fatalf("Ids = %v, want [a c]", ids)
	}
}

// Interleaved inserts, moves and removes must still drain in non-decreasing due
// order — the property every other test only spot-checks.
func TestHeapInvariantUnderRandomOps(t *testing.T) {
	s := newSchedule()
	rng := rand.New(rand.NewSource(7))
	live := map[string]float64{}

	for i := 0; i < 2000; i++ {
		id := fmt.Sprintf("m%d", rng.Intn(120))
		switch rng.Intn(3) {
		case 0:
			due := float64(rng.Intn(10000))
			s.Add(id, due)
			live[id] = due
		case 1:
			due := float64(rng.Intn(10000))
			if s.Update(id, due) {
				live[id] = due
			}
		case 2:
			s.Remove(id)
			delete(live, id)
		}
	}

	if s.Len() != len(live) {
		t.Fatalf("Len = %d, want %d", s.Len(), len(live))
	}

	prev := -1.0
	seen := 0
	for {
		id, due, ok := s.PopDue(1e9)
		if !ok {
			break
		}
		if due < prev {
			t.Fatalf("drained out of order: %v after %v", due, prev)
		}
		if want, tracked := live[id]; !tracked || want != due {
			t.Fatalf("drained %q at %v, tracked as %v (tracked=%v)", id, due, want, tracked)
		}
		prev = due
		seen++
	}
	if seen != len(live) {
		t.Fatalf("drained %d items, want %d", seen, len(live))
	}
}

// The check loop and the reconcile loop touch the set from different goroutines;
// `go test -race` is what makes this test worth having.
func TestConcurrentUse(t *testing.T) {
	s := newSchedule()
	var wg sync.WaitGroup

	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				id := fmt.Sprintf("m%d-%d", g, i%50)
				s.AddIfAbsent(id, float64(i))
				s.Update(id, float64(i+1))
				s.Len()
				s.EarliestDue()
				s.PopDue(float64(i))
				s.Remove(id)
			}
		}(g)
	}
	wg.Wait()
}

// The stagger must be stable across restarts (same id, same slot) and stay inside
// the interval, or a restart would reshuffle the whole zone's cadence.
func TestStartupOffsetIsStableAndBounded(t *testing.T) {
	const interval = 60
	for _, id := range []string{"abc123", "zzz", "m1", ""} {
		first := startupOffset(id, interval)
		if first != startupOffset(id, interval) {
			t.Fatalf("startupOffset(%q) is not stable", id)
		}
		if first < 0 || first >= interval {
			t.Fatalf("startupOffset(%q) = %v, outside [0,%d)", id, first, interval)
		}
	}
	if got := startupOffset("anything", 0); got != 0 {
		t.Fatalf("startupOffset with a non-positive interval = %v, want 0", got)
	}
	// Different monitors must not all land in the same slot, or the stagger does
	// nothing.
	slots := map[float64]bool{}
	for i := 0; i < 50; i++ {
		slots[startupOffset(fmt.Sprintf("monitor%d", i), interval)] = true
	}
	if len(slots) < 10 {
		t.Fatalf("50 monitors landed in only %d distinct slots — the stagger is not spreading", len(slots))
	}
}
