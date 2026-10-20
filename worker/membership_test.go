package main

import (
	"fmt"
	"sync"
	"testing"

	"monitors/corelib/models"
)

// Before any heartbeat has succeeded a worker must own EVERYTHING: a zone cannot
// stop checking because PocketBase was slow to answer at start-up, and the
// single-worker case — by far the common one — must need no successful roster
// read to behave correctly.
func TestNewMembershipOwnsEverything(t *testing.T) {
	mem := newMembership()
	for i := 0; i < 200; i++ {
		if !mem.ownsMonitor(fmt.Sprintf("m%d", i)) {
			t.Fatalf("a fresh worker did not own m%d", i)
		}
	}
	if index, count := mem.get(); index != 0 || count != 1 {
		t.Fatalf("fresh membership = (%d,%d), want (0,1)", index, count)
	}
}

func TestMembershipSetReportsChange(t *testing.T) {
	mem := newMembership()
	// The first successful roster read is a change even when it says 0 of 1,
	// because until then the position was assumed rather than known.
	if !mem.set(0, 1) {
		t.Fatal("the first roster read did not report a change")
	}
	if mem.set(0, 1) {
		t.Fatal("an unchanged roster reported a change")
	}
	if !mem.set(1, 3) {
		t.Fatal("a changed roster did not report a change")
	}
	if index, count := mem.get(); index != 1 || count != 3 {
		t.Fatalf("membership = (%d,%d), want (1,3)", index, count)
	}
}

func TestMembershipNarrowsOwnership(t *testing.T) {
	mem := newMembership()
	mem.set(1, 3)
	owned, total := 0, 600
	for i := 0; i < total; i++ {
		if mem.ownsMonitor(fmt.Sprintf("m%d", i)) {
			owned++
		}
	}
	if owned == total || owned == 0 {
		t.Fatalf("worker 1 of 3 owns %d of %d monitors — expected a share, not all or nothing", owned, total)
	}
}

// The heartbeat loop writes this while the reconcile loop reads it.
func TestMembershipIsRaceFree(t *testing.T) {
	mem := newMembership()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 300; i++ {
				mem.set(i%3, 3)
				mem.ownsMonitor(fmt.Sprintf("m%d", i))
				mem.get()
			}
		}(g)
	}
	wg.Wait()
}

func TestShouldSchedule(t *testing.T) {
	single := newMembership()
	cases := []struct {
		name    string
		monitor models.Monitor
		zone    string
		mem     *membership
		want    bool
	}{
		{"probe in this zone", models.Monitor{Id: "m1", Type: "website", Zones: []string{"eu"}}, "eu", single, true},
		{"no zones runs everywhere", models.Monitor{Id: "m2", Type: "website"}, "eu", single, true},
		{"heartbeat type is never probed", models.Monitor{Id: "m3", Type: "heartbeat"}, "eu", single, false},
		{"another zone", models.Monitor{Id: "m4", Type: "website", Zones: []string{"us"}}, "eu", single, false},
	}
	for _, c := range cases {
		if got := shouldSchedule(c.monitor, c.zone, c.mem); got != c.want {
			t.Errorf("%s: shouldSchedule = %v, want %v", c.name, got, c.want)
		}
	}
}

// A monitor in this zone that belongs to another worker's shard is skipped — and
// exactly one of the zone's workers picks it up.
func TestShouldScheduleSplitsTheZoneAcrossWorkers(t *testing.T) {
	const count = 3
	members := make([]*membership, count)
	for i := range members {
		members[i] = newMembership()
		members[i].set(i, count)
	}
	for i := 0; i < 300; i++ {
		m := models.Monitor{Id: fmt.Sprintf("mon%d", i), Type: "website", Zones: []string{"eu"}}
		owners := 0
		for _, mem := range members {
			if shouldSchedule(m, "eu", mem) {
				owners++
			}
		}
		if owners != 1 {
			t.Fatalf("%s scheduled by %d workers, want exactly 1", m.Id, owners)
		}
	}
}

// Zone assignment still wins over ownership: a monitor pinned elsewhere is not
// checked by ANY worker in this zone, however the hash falls.
func TestZoneStillWinsOverOwnership(t *testing.T) {
	const count = 3
	for i := 0; i < 200; i++ {
		m := models.Monitor{Id: fmt.Sprintf("mon%d", i), Type: "website", Zones: []string{"us"}}
		for idx := 0; idx < count; idx++ {
			mem := newMembership()
			mem.set(idx, count)
			if shouldSchedule(m, "eu", mem) {
				t.Fatalf("%s is pinned to us but worker %d of eu scheduled it", m.Id, idx)
			}
		}
	}
}
