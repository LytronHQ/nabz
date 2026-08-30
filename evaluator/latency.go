package main

import (
	"fmt"
	"log"
	"sort"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
)

const (
	// latencyWindow is how far back the p95 is computed over — long enough that a
	// single spike doesn't move it, short enough to be responsive.
	latencyWindow = 5 * time.Minute
	// latencyBreachTicks is the flap-damping threshold: the p95 must exceed the
	// limit for this many consecutive evaluator ticks before we alert.
	latencyBreachTicks = 3
	// minLatencySamples is the fewest up-checks needed before we'll judge latency.
	minLatencySamples = 5
)

// latencyState is the flap-damping state for one monitor. `alerted` is persisted
// across restarts (#327); `breachStreak` is not, because it rebuilds within a few
// ticks and a lost streak only delays an alert rather than dropping one.
//
// Losing `alerted` broke both directions: a still-slow monitor re-alerted once
// the streak rebuilt, and — worse — a monitor that recovered across a restart
// never got its recovery message, because that is only sent when the alerter
// believes it alerted.
type latencyState struct {
	breachStreak int
	alerted      bool
}

// p95 returns the 95th-percentile (nearest-rank) of the values, or 0 if empty.
func p95(values []int) int {
	n := len(values)
	if n == 0 {
		return 0
	}
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	idx := (95*n+99)/100 - 1 // ceil(0.95*n) - 1, integer math
	if idx < 0 {
		idx = 0
	}
	if idx >= n {
		idx = n - 1
	}
	return sorted[idx]
}

// latencyCheck warns a monitor's channels when its recent p95 response time
// exceeds the configured threshold — with flap damping (N consecutive breaching
// ticks) and a paired recovery alert. Separate from up/down; opens no incident.
func latencyCheck(pbClient *pb.Client, cfg alertConfig, state map[string]*latencyState, store alertStateStore, now time.Time) {
	monitors, err := pbClient.ListMonitorsForLatency()
	if err != nil {
		log.Printf("Latency: failed to list monitors: %s", err)
		return
	}
	for _, m := range monitors {
		threshold := m.Config.LatencyThresholdMs
		if threshold <= 0 {
			delete(state, m.Id) // rule removed — drop stale state
			store.Delete(stateKey(stateKindLatency, m.Id))
			continue
		}
		if inMaintenance(m, now) {
			continue // planned maintenance — hold latency alerts too
		}

		checks, err := pbClient.GetChecksSince(m.Id, now.Add(-latencyWindow))
		if err != nil {
			log.Printf("Latency: [%s] failed to read checks: %s", m.Id, err)
			continue
		}
		samples := make([]int, 0, len(checks))
		for _, c := range checks {
			if c.Up && c.ResponseMs > 0 {
				samples = append(samples, c.ResponseMs)
			}
		}
		if len(samples) < minLatencySamples {
			continue // not enough data to judge yet
		}
		current := p95(samples)

		st := state[m.Id]
		if st == nil {
			st = &latencyState{}
			state[m.Id] = st
		}

		if current > threshold {
			st.breachStreak++
			if st.breachStreak >= latencyBreachTicks && !st.alerted {
				st.alerted = true
				store.Put(stateKey(stateKindLatency, m.Id), "1")
				dispatchLatencyAlert(pbClient, cfg, m, current, threshold, false)
			}
		} else {
			if st.alerted {
				dispatchLatencyAlert(pbClient, cfg, m, current, threshold, true)
				store.Delete(stateKey(stateKindLatency, m.Id))
			}
			st.alerted = false
			st.breachStreak = 0
		}
	}
}

func dispatchLatencyAlert(pbClient *pb.Client, cfg alertConfig, m models.Monitor, p95ms, threshold int, recovered bool) {
	channels, err := pbClient.ChannelsForMonitor(m)
	if err != nil {
		log.Printf("Latency: [%s] cannot load channels, will retry: %s", m.Id, err)
		return
	}
	subject := fmt.Sprintf("[nabz] %s is slow", m.Name)
	body := fmt.Sprintf("%s (%s) p95 response time is %dms over the last %s — above the %dms threshold.",
		m.Name, m.Target, p95ms, latencyWindow, threshold)
	event := "latency.high"
	if recovered {
		subject = fmt.Sprintf("[nabz] %s latency is back to normal", m.Name)
		body = fmt.Sprintf("%s (%s) p95 response time recovered to %dms (threshold %dms).", m.Name, m.Target, p95ms, threshold)
		event = "latency.recovered"
	}
	payload := map[string]interface{}{
		"event":        event,
		"monitor":      m.Name,
		"monitor_id":   m.Id,
		"p95_ms":       p95ms,
		"threshold_ms": threshold,
	}
	results := dispatch(cfg, channels, subject, body, payload)
	sent, _ := summarize(results)
	log.Printf("[%s] %s to %d/%d channel(s) (p95=%dms threshold=%dms)", m.Id, event, sent, len(channels), p95ms, threshold)
	logChannelEvents(pbClient, results, "latency")
}
