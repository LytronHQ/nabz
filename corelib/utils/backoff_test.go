package utils

import (
	"testing"
	"time"
)

func TestBackoff(t *testing.T) {
	base := 2 * time.Second
	max := 60 * time.Second
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 16 * time.Second},
		{5, 32 * time.Second},
		{6, 60 * time.Second},   // 64 capped to 60
		{100, 60 * time.Second}, // capped; no overflow
	}
	for _, c := range cases {
		if got := Backoff(c.attempt, base, max); got != c.want {
			t.Errorf("Backoff(%d) = %s, want %s", c.attempt, got, c.want)
		}
	}
}

func TestJitterWithinBounds(t *testing.T) {
	d := 10 * time.Second
	for i := 0; i < 1000; i++ {
		j := Jitter(d)
		if j < 8*time.Second || j > 12*time.Second {
			t.Fatalf("Jitter(%s) = %s, outside ±20%%", d, j)
		}
	}
}
