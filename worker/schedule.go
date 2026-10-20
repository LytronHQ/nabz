package main

import (
	"container/heap"
	"hash/fnv"
	"sync"
)

// The zone's due-set, held in this process.
//
// It replaces the per-zone Valkey sorted set (`due:<zone>`). That queue was built
// for 1–3 workers sharing a zone, which never happened: a zone is exactly one
// worker, so the sorted set, its Lua reserve script and the leader lock around it
// were all coordination for a peer that does not exist.
//
// A monitor is either IN the heap carrying its next due time, or IN FLIGHT —
// PopDue takes it out and processMonitor puts it back once the check is done.
// That is the same mutual exclusion the Valkey reservation provided, minus the
// redelivery: a crash loses the whole heap either way, and the reconcile pass
// rebuilds it from PocketBase at startup.

// scheduleItem is one monitor's place in the due-set.
type scheduleItem struct {
	id string
	// due is a unix timestamp in seconds, kept as float64 because it is the score
	// nextDueScore anchors the next run on — the drift-free rule reschedules from
	// the time a check was DUE, never from when it finished.
	due float64
	// index is maintained by heap.Interface so Update and Remove can fix an item's
	// position in place instead of scanning the slice.
	index int
}

// dueHeap is the ordering half of the due-set: a min-heap on due time. It is not
// safe on its own — every caller goes through schedule, which holds the mutex.
type dueHeap []*scheduleItem

func (h dueHeap) Len() int           { return len(h) }
func (h dueHeap) Less(i, j int) bool { return h[i].due < h[j].due }

func (h dueHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *dueHeap) Push(x any) {
	item := x.(*scheduleItem)
	item.index = len(*h)
	*h = append(*h, item)
}

func (h *dueHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil // let the popped item be collected
	item.index = -1
	*h = old[:n-1]
	return item
}

// schedule is the goroutine-safe due-set: a min-heap for "what is due next" plus
// a map for O(1) lookup, so rescheduling or dropping one monitor out of thousands
// costs a heap fix rather than a scan.
type schedule struct {
	mu sync.Mutex
	h  dueHeap
	by map[string]*scheduleItem
}

func newSchedule() *schedule {
	return &schedule{by: make(map[string]*scheduleItem)}
}

// Add schedules id at due, moving it if it is already tracked (an upsert — the
// ZADD the worker used after each check).
func (s *schedule) Add(id string, due float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if item, ok := s.by[id]; ok {
		item.due = due
		heap.Fix(&s.h, item.index)
		return
	}
	item := &scheduleItem{id: id, due: due}
	s.by[id] = item
	heap.Push(&s.h, item)
}

// AddIfAbsent schedules id only when it is not already tracked, and reports
// whether it was added. The reconcile pass uses it so a re-sync never disturbs a
// monitor that is already ticking — the ZADD NX the seeder relied on.
func (s *schedule) AddIfAbsent(id string, due float64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.by[id]; ok {
		return false
	}
	item := &scheduleItem{id: id, due: due}
	s.by[id] = item
	heap.Push(&s.h, item)
	return true
}

// Update moves an already-tracked monitor to a new due time, reporting whether it
// was tracked at all. An untracked id is NOT inserted — this is the "move it if
// it is still scheduled" half of the API, kept separate from Add so a caller
// cannot resurrect a pruned monitor by accident.
func (s *schedule) Update(id string, due float64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.by[id]
	if !ok {
		return false
	}
	item.due = due
	heap.Fix(&s.h, item.index)
	return true
}

// Remove drops id from the due-set, reporting whether it was tracked.
func (s *schedule) Remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.by[id]
	if !ok {
		return false
	}
	heap.Remove(&s.h, item.index)
	delete(s.by, id)
	return true
}

// PopDue removes and returns the earliest monitor due at or before now. Removing
// it — rather than marking it — is what keeps a check from being handed out twice
// while it runs; the caller reschedules it when the check completes.
//
// The returned due time is the time the check was DUE, not the time it was
// popped, because that is what the next interval is measured from.
func (s *schedule) PopDue(now float64) (id string, due float64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.h) == 0 || s.h[0].due > now {
		return "", 0, false
	}
	item := heap.Pop(&s.h).(*scheduleItem)
	delete(s.by, item.id)
	return item.id, item.due, true
}

// Len is how many monitors this zone has scheduled — the queue_depth published to
// zone_stats. A monitor being checked right now is NOT counted: it has been popped
// and is not back yet.
func (s *schedule) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.h)
}

// EarliestDue returns the next due time, and false when nothing is scheduled. The
// stats loop turns it into schedule lag: how far behind the schedule the zone is.
func (s *schedule) EarliestDue() (float64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.h) == 0 {
		return 0, false
	}
	return s.h[0].due, true
}

// Ids lists every tracked monitor, in no particular order. The reconcile pass
// diffs it against PocketBase to find monitors that should no longer be checked.
func (s *schedule) Ids() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.by))
	for id := range s.by {
		ids = append(ids, id)
	}
	return ids
}

// startupOffset spreads a monitor's FIRST check over its interval instead of
// firing every monitor the moment the worker starts. The seeder used to schedule
// everything at `now`, so a restart (or a Valkey restart, which had no
// persistence) meant the whole zone probed at once and then drifted into clumps.
//
// Hashing the id keeps the offset stable: the same monitor lands in the same slot
// on every restart, so a restart does not reshuffle the zone's whole cadence.
func startupOffset(id string, interval int) float64 {
	if interval <= 0 {
		return 0
	}
	return float64(hashId(id) % uint32(interval))
}

// hashId is the one hash used for anything that must be stable across restarts
// AND identical on every worker: the start-up stagger and, once a zone has more
// than one worker, which of them owns a monitor. FNV-32a is fixed by the standard
// library, so two workers built from the same source always agree.
func hashId(id string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return h.Sum32()
}

// pool bounds how many checks run at once.
//
// The check loop used to run one check to completion before popping the next, so
// a single hung target stalled the whole zone for up to checkTimeout and a zone's
// throughput was one check at a time regardless of how idle the box was. With the
// due-set in this process, concurrency is a pool over the heap rather than a
// second container and a shared queue.
//
// run blocks when every slot is taken, which is the point: the schedule itself
// becomes the backpressure, so a zone that falls behind builds a visible lag
// instead of an unbounded pile of goroutines.
type pool struct {
	sem chan struct{}
	wg  sync.WaitGroup
}

// newPool builds a pool of the given size. A size below 1 is clamped to 1 — an
// unset or nonsensical config must still check monitors, just serially.
func newPool(size int) *pool {
	if size < 1 {
		size = 1
	}
	return &pool{sem: make(chan struct{}, size)}
}

// run waits for a free slot and then runs f on its own goroutine.
func (p *pool) run(f func()) {
	p.sem <- struct{}{}
	p.wg.Add(1)
	go func() {
		defer func() {
			<-p.sem
			p.wg.Done()
		}()
		f()
	}()
}

// wait blocks until every in-flight task has finished: the drain on a stop
// signal (#417), and tests.
func (p *pool) wait() { p.wg.Wait() }

// busy is how many tasks are running right now.
func (p *pool) busy() int { return len(p.sem) }

// size is the pool's configured concurrency.
func (p *pool) size() int { return cap(p.sem) }
