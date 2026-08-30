package main

import "testing"

// monitorInZone drives both the seeder (which monitors to add) and the
// process-time guard (which to keep vs. drop from a zone's due set). An
// empty zone list means "run everywhere"; otherwise the zone must be listed.
func TestMonitorInZone(t *testing.T) {
	cases := []struct {
		name  string
		zones []string
		zone  string
		want  bool
	}{
		{"empty zones runs everywhere", nil, "us", true},
		{"empty slice runs everywhere", []string{}, "eu", true},
		{"assigned zone is kept", []string{"eu"}, "eu", true},
		{"unassigned zone is dropped", []string{"eu"}, "us", false},
		{"one of several assigned zones", []string{"eu", "us"}, "us", true},
		{"none of several assigned zones", []string{"eu", "ap"}, "us", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := monitorInZone(c.zones, c.zone); got != c.want {
				t.Fatalf("monitorInZone(%v, %q) = %v, want %v", c.zones, c.zone, got, c.want)
			}
		})
	}
}
