package utils

import (
	"math/rand"
	"time"
)

// Shared retry timing for startup dependency connects (PocketBase, Valkey).
const (
	RetryBaseDelay = 2 * time.Second
	RetryMaxDelay  = 60 * time.Second
)

// Backoff returns base*2^(attempt-1), capped at max (attempt is 1-based). The
// loop stops early at the cap, so large attempt counts never overflow.
func Backoff(attempt int, base, max time.Duration) time.Duration {
	d := base
	for i := 1; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	return d
}

// Jitter applies up to ±20%, so instances that crashed together don't all retry
// in lockstep and re-thunder the dependency.
func Jitter(d time.Duration) time.Duration {
	span := int64(d) / 5
	if span <= 0 {
		return d
	}
	return d + time.Duration(rand.Int63n(2*span+1)-span)
}
