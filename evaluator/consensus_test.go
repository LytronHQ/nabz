package main

import "testing"

func TestDecide(t *testing.T) {
	up := ZoneEval{Fresh: true, Up: true}
	down := ZoneEval{Fresh: true, Up: false, TrailingDown: 1}
	stale := ZoneEval{Fresh: false}

	cases := []struct {
		name    string
		zones   []ZoneEval
		require int
		want    Status
	}{
		{"no fresh zones -> pending", []ZoneEval{stale, stale}, 2, StatusPending},

		// Single zone: needs consecutive failures to go down.
		{"1 zone up", []ZoneEval{up}, 2, StatusUp},
		{"1 zone down once -> pending", []ZoneEval{{Fresh: true, Up: false, TrailingDown: 1}}, 2, StatusPending},
		{"1 zone down twice -> down", []ZoneEval{{Fresh: true, Up: false, TrailingDown: 2}}, 2, StatusDown},

		// Two zones: unanimity required either way.
		{"2 up -> up", []ZoneEval{up, up}, 2, StatusUp},
		{"2 down -> down", []ZoneEval{down, down}, 2, StatusDown},
		{"1 up 1 down -> pending (no false alarm)", []ZoneEval{up, down}, 2, StatusPending},

		// A stale zone is ignored, so 1 fresh down + 1 stale = single-zone rule.
		{"1 down + 1 stale -> pending until consecutive", []ZoneEval{{Fresh: true, Up: false, TrailingDown: 1}, stale}, 2, StatusPending},

		// Three zones: majority.
		{"3 zones 2 down -> down", []ZoneEval{down, down, up}, 2, StatusDown},
		{"3 zones 2 up -> up", []ZoneEval{up, up, down}, 2, StatusUp},
		{"4 zones 2-2 tie -> pending", []ZoneEval{up, up, down, down}, 2, StatusPending},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decide(c.zones, c.require); got != c.want {
				t.Fatalf("decide(%+v) = %s, want %s", c.zones, got, c.want)
			}
		})
	}
}
