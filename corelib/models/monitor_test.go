package models

import "testing"

// The 30s floor (#319) has to be applied identically by every component that
// reasons about cadence — the worker schedules on it, the evaluator sizes its
// freshness window from it. One shared function is the only way they agree.
func TestEffectiveInterval(t *testing.T) {
	cases := []struct {
		name      string
		raw, want int
	}{
		{"unset falls back to the default", 0, DefaultIntervalSeconds},
		{"negative falls back to the default", -5, DefaultIntervalSeconds},
		{"legacy sub-floor row clamps up", 5, MinIntervalSeconds},
		{"just under the floor clamps up", 29, MinIntervalSeconds},
		{"at the floor is unchanged", MinIntervalSeconds, MinIntervalSeconds},
		{"above the floor is unchanged", 60, 60},
		{"well above the floor is unchanged", 3600, 3600},
	}
	for _, c := range cases {
		if got := EffectiveInterval(c.raw); got != c.want {
			t.Errorf("%s: EffectiveInterval(%d) = %d, want %d", c.name, c.raw, got, c.want)
		}
	}
}
