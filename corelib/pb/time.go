package pb

import "time"

// ParseTime parses a PocketBase timestamp. PocketBase serializes autodate fields
// as "2006-01-02 15:04:05.000Z" — a space, not a T — but returns RFC3339 in some
// contexts, so both are accepted.
//
// It lives here rather than in a node because every consumer of a PocketBase
// timestamp needs it: the evaluator judges heartbeat staleness with it, and the
// worker judges the liveness of its peers with it.
func ParseTime(s string) (time.Time, bool) {
	layouts := []string{
		"2006-01-02 15:04:05.000Z",
		"2006-01-02 15:04:05Z",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
