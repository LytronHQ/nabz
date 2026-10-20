package main

import (
	"sort"
	"sync"
	"time"

	"monitors/corelib/pb"
)

// Which worker checks which monitor, when a zone has more than one.
//
// The rule is derived, not assigned: every worker reads the same
// worker_heartbeats rows, drops the stale ones, sorts what is left by worker id,
// finds itself, and owns the monitors that hash to its position. No coordinator,
// no claim to write, nothing to release when a worker dies.
//
// It holds together only because every worker computes the SAME roster from the
// same rows. Hence a total, deterministic sort and a hash that is fixed by the
// standard library rather than by anything local.

// roster returns the ids of the workers considered alive, in a stable order.
//
// now must be PocketBase's clock (the `updated` it stamped on our own last
// heartbeat), not the local one — otherwise a worker with a fast clock decides
// its peers are dead.
//
// A row that cannot be parsed is treated as stale: an unreadable timestamp is not
// evidence of life.
func roster(rows []pb.WorkerHeartbeat, now time.Time, ttl time.Duration) []string {
	cutoff := now.Add(-ttl)
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.Worker == "" {
			continue
		}
		t, ok := pb.ParseTime(r.Updated)
		if !ok || t.Before(cutoff) {
			continue
		}
		ids = append(ids, r.Worker)
	}
	// Byte order, and de-duplicated: the unique index makes a duplicate id
	// impossible in one zone, but two workers must never disagree about the
	// ordering even if one somehow appears twice.
	sort.Strings(ids)
	return dedupe(ids)
}

func dedupe(sorted []string) []string {
	out := sorted[:0]
	var prev string
	for i, s := range sorted {
		if i > 0 && s == prev {
			continue
		}
		out = append(out, s)
		prev = s
	}
	return out
}

// indexOf reports this worker's position in the roster, and whether it is there
// at all. A worker that does not find itself owns NOTHING rather than
// everything: it has just learned that its own heartbeat is not visible, which is
// the one moment it should not be claiming work its peers believe they own.
func indexOf(roster []string, id string) (int, bool) {
	for i, r := range roster {
		if r == id {
			return i, true
		}
	}
	return 0, false
}

// owns reports whether the worker at index (of count) should check this monitor.
//
// count <= 1 means the whole zone is one worker, so it owns everything — which
// keeps a single-worker zone on exactly the path it had before sharding existed.
func owns(monitorId string, index, count int) bool {
	if count <= 1 {
		return true
	}
	if index < 0 || index >= count {
		return false
	}
	return int(hashId(monitorId)%uint32(count)) == index
}

// membership is this worker's place in its zone: where it sits in the roster and
// how many workers that roster holds. Read by the reconcile loop, written by the
// heartbeat loop.
//
// It starts as "one worker, index 0" rather than "unknown", so a worker that has
// not yet managed a heartbeat owns EVERYTHING. A zone must not stop checking
// because PocketBase was slow to answer at start-up, and a single-worker zone —
// the overwhelmingly common case — is then on exactly the path it had before
// sharding existed, from the first second.
type membership struct {
	mu    sync.RWMutex
	index int
	count int
	known bool

	// serverTime is the clock PocketBase stamped on this worker's last heartbeat,
	// and takenAt is the local instant we received it. Absolute time comes from
	// PocketBase, elapsed time from the local monotonic clock — so a worker whose
	// wall clock is wrong still measures ages correctly.
	serverTime time.Time
	takenAt    time.Time
}

func newMembership() *membership { return &membership{index: 0, count: 1} }

// observeServerTime records PocketBase's clock as of now.
func (m *membership) observeServerTime(t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.serverTime, m.takenAt = t, time.Now()
}

// serverNow estimates PocketBase's current time: its last known value plus the
// monotonic time since. false until a heartbeat has succeeded.
func (m *membership) serverNow() (time.Time, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.serverTime.IsZero() {
		return time.Time{}, false
	}
	return m.serverTime.Add(time.Since(m.takenAt)), true
}

// isStatsWriter reports whether this worker is the one elected to publish the
// zone's stats row. The roster is sorted by worker id, so index 0 IS the lowest
// id — no separate election, and every worker reaches the same answer.
//
// It requires a SUCCESSFUL roster read. The default position is (0, 1), which
// exists so a worker owns every monitor before its first read — a zone must not
// stop checking because PocketBase was slow at start-up. Reading that same
// default as "I am index 0, therefore I am the writer" is what let a worker whose
// first read failed publish alongside the real writer: the two then raced, and
// `workers` flapped between the true roster size and 1.
//
// Being strict costs nothing, because the stale-row fallback already covers
// "nobody is publishing" — a zone with no row gets one immediately, and a row
// that stops moving is picked up within three stats intervals.
func (m *membership) isStatsWriter() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.known && m.index == 0
}

// set records a new position and reports whether it changed.
func (m *membership) set(index, count int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	changed := !m.known || m.index != index || m.count != count
	m.index, m.count, m.known = index, count, true
	return changed
}

func (m *membership) get() (index, count int) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.index, m.count
}

// zoneStatsIsStale reports whether the zone's stats row has gone quiet.
//
// It is the safety net under the election: the elected writer can die, and until
// it drops out of the roster nobody else is publishing. The dashboard judges a
// zone stale at 30 seconds, so without this a zone whose every other worker is
// healthy would read as dead for the whole roster TTL. A zone must read dead only
// when ALL of its workers are.
//
// A missing or unparseable timestamp counts as stale: nobody has written it, or
// we cannot tell, and in both cases writing it is the safe move.
func zoneStatsIsStale(updated string, now time.Time, after time.Duration) bool {
	t, ok := pb.ParseTime(updated)
	if !ok {
		return true
	}
	return now.Sub(t) > after
}

// ownsMonitor is membership's view of owns().
func (m *membership) ownsMonitor(monitorId string) bool {
	index, count := m.get()
	return owns(monitorId, index, count)
}
