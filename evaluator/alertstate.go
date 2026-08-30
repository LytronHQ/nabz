package main

import (
	"log"
	"sync"
	"time"

	"monitors/corelib/pb"
)

// Persistent "have I already alerted?" state (#327).
//
// The incident path always persisted its transition state in PocketBase, but the
// four non-incident alerters kept theirs in maps local to main(). Every evaluator
// restart therefore re-armed them, and remote-deploy.sh restarts the evaluator on
// every deploy — so any condition still true across a deploy re-notified, most
// visibly cert warnings, which stay true for a fortnight at a time.
//
// Latency was worse in the other direction: the recovery message only goes out if
// the alerter believes it alerted, so a monitor that recovered across a restart
// got its "is slow" alert and then silence, never closed out. A dropped recovery
// is worse than a duplicate warning.
//
// The store is a tiny key/value table. Keys are namespaced per alerter so one
// collection serves all of them, including the dead-man's switch, whose subject
// is a zone rather than a monitor.

const (
	stateKindZoneSilent = "zone.silent"
	stateKindCert       = "cert"
	stateKindDomain     = "domain"
	stateKindLatency    = "latency"
	// Set while every assigned zone of a monitor has gone quiet, so the owner is
	// told once rather than on every evaluator restart (#328).
	stateKindUnjudged = "consensus.unjudged"
)

func stateKey(kind, subject string) string { return kind + ":" + subject }

// alertStateStore persists transition flags. Writes are best-effort and never
// block alerting: failing to record that we alerted may cost a duplicate after a
// restart, but refusing to alert because the bookkeeping failed would cost the
// alert itself.
type alertStateStore interface {
	Load() (map[string]string, error)
	Put(key, value string)
	Delete(key string)
}

// pbAlertState is the production store, backed by the alert_state collection.
type pbAlertState struct {
	client *pb.Client
	mu     sync.Mutex
	// Mirrors what we believe is stored, so an unchanged value skips the write.
	// These transitions are rare, but the loop turns every 10s and there is no
	// reason to PATCH the same row forever.
	known map[string]string
}

func newPBAlertState(client *pb.Client) *pbAlertState {
	return &pbAlertState{client: client, known: map[string]string{}}
}

func (s *pbAlertState) Load() (map[string]string, error) {
	rows, err := s.client.ListAlertState()
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Key] = r.Value
	}
	s.mu.Lock()
	for k, v := range out {
		s.known[k] = v
	}
	s.mu.Unlock()
	return out, nil
}

func (s *pbAlertState) Put(key, value string) {
	s.mu.Lock()
	if prev, ok := s.known[key]; ok && prev == value {
		s.mu.Unlock()
		return
	}
	s.known[key] = value
	s.mu.Unlock()

	if err := s.client.PutAlertState(key, value); err != nil {
		// Drop the cached value so the next tick retries rather than assuming
		// the write landed.
		s.mu.Lock()
		delete(s.known, key)
		s.mu.Unlock()
		log.Printf("alert-state: could not persist %q: %s", key, err)
	}
}

func (s *pbAlertState) Delete(key string) {
	s.mu.Lock()
	_, cached := s.known[key]
	delete(s.known, key)
	s.mu.Unlock()
	if !cached {
		// Never recorded in this process and not loaded at startup: nothing to
		// clear. Saves a request per recovered monitor per tick.
		return
	}
	if err := s.client.DeleteAlertState(key); err != nil {
		log.Printf("alert-state: could not clear %q: %s", key, err)
	}
}

// memAlertState is the test/no-op store. A nil *pb.Client would panic, and tests
// call the alerters directly with their state maps.
type memAlertState struct {
	mu   sync.Mutex
	data map[string]string
}

func newMemAlertState() *memAlertState { return &memAlertState{data: map[string]string{}} }

func (s *memAlertState) Load() (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out, nil
}

func (s *memAlertState) Put(key, value string) {
	s.mu.Lock()
	s.data[key] = value
	s.mu.Unlock()
}

func (s *memAlertState) Delete(key string) {
	s.mu.Lock()
	delete(s.data, key)
	s.mu.Unlock()
}

// hydrate rebuilds the in-memory maps from what was persisted, so a restart
// resumes where it left off instead of re-arming every alerter. An unreadable
// store is not fatal: the evaluator starts with empty state, which is exactly
// today's behaviour, and says so rather than failing to boot.
func hydrate(store alertStateStore,
	silentZones map[string]bool,
	certAlerted map[string]time.Time,
	domainAlerted map[string]time.Time,
	latency map[string]*latencyState,
	unjudged map[string]bool,
) {
	rows, err := store.Load()
	if err != nil {
		log.Printf("alert-state: could not load persisted state, starting empty (restart may re-notify): %s", err)
		return
	}
	for key, value := range rows {
		kind, subject, ok := splitStateKey(key)
		if !ok {
			continue
		}
		switch kind {
		case stateKindZoneSilent:
			silentZones[subject] = true
		case stateKindCert:
			if t, err := time.Parse(time.RFC3339, value); err == nil {
				certAlerted[subject] = t
			}
		case stateKindDomain:
			if t, err := time.Parse(time.RFC3339, value); err == nil {
				domainAlerted[subject] = t
			}
		case stateKindLatency:
			// Only `alerted` needs to survive; breachStreak rebuilds in memory.
			latency[subject] = &latencyState{alerted: true}
		case stateKindUnjudged:
			unjudged[subject] = true
		}
	}
	if len(rows) > 0 {
		log.Printf("alert-state: restored %d transition flag(s)", len(rows))
	}
}

// splitStateKey splits "kind:subject" on the FIRST colon — a subject can contain
// one, and a zone code or monitor id must not be truncated into a different key.
func splitStateKey(key string) (kind, subject string, ok bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == ':' {
			return key[:i], key[i+1:], i > 0 && i+1 < len(key)
		}
	}
	return "", "", false
}
