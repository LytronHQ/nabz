package main

// Status is the consensus verdict for a monitor.
type Status string

const (
	StatusUp      Status = "up"
	StatusDown    Status = "down"
	StatusPending Status = "pending"
)

// isBlockedStatus mirrors the worker: HTTP 429/403 mean the target rate-limited
// or bot-blocked us. Such a result is a neutral abstention — never up, never a
// real down — so the evaluator excludes it from consensus entirely.
func isBlockedStatus(code int) bool {
	return code == 429 || code == 403
}

// ZoneEval is one zone's contribution to a monitor's consensus: whether we have
// a fresh-enough latest check, whether that check was up, and how many checks
// in a row (ending at the latest) were down (used for the single-zone rule).
type ZoneEval struct {
	Fresh        bool
	Up           bool
	TrailingDown int
}

// decide computes a monitor's status from its zones' latest results (§10.1).
//
//   - Only zones with a fresh check count (M = number of fresh zones).
//   - M == 0  → pending (we can't judge).
//   - M == 1  → up if the latest is up; down only after `requireConsecutive`
//     failures in a row; otherwise pending. (No cross-zone vote to lean on.)
//   - M == 2  → down only if both are down, up only if both are up, else pending.
//   - M >= 3  → majority wins; ties are pending.
func decide(zones []ZoneEval, requireConsecutive int) Status {
	fresh := make([]ZoneEval, 0, len(zones))
	for _, z := range zones {
		if z.Fresh {
			fresh = append(fresh, z)
		}
	}

	m := len(fresh)
	if m == 0 {
		return StatusPending
	}

	downs := 0
	for _, z := range fresh {
		if !z.Up {
			downs++
		}
	}
	ups := m - downs

	switch {
	case m == 1:
		z := fresh[0]
		if z.Up {
			return StatusUp
		}
		if z.TrailingDown >= requireConsecutive {
			return StatusDown
		}
		return StatusPending
	case m == 2:
		if downs == 2 {
			return StatusDown
		}
		if ups == 2 {
			return StatusUp
		}
		return StatusPending
	default: // m >= 3, majority
		if downs*2 > m {
			return StatusDown
		}
		if ups*2 > m {
			return StatusUp
		}
		return StatusPending
	}
}
