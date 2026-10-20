package pb

import (
	"testing"
	"time"
)

func TestParseTime(t *testing.T) {
	want := time.Date(2026, 9, 21, 10, 30, 0, 0, time.UTC)
	// The first form is what PocketBase actually returns for an autodate field.
	for _, in := range []string{
		"2026-09-21 10:30:00.000Z",
		"2026-09-21 10:30:00Z",
		"2026-09-21T10:30:00Z",
		"2026-09-21T10:30:00.000000Z",
	} {
		got, ok := ParseTime(in)
		if !ok {
			t.Errorf("ParseTime(%q) failed to parse", in)
			continue
		}
		if !got.Equal(want) {
			t.Errorf("ParseTime(%q) = %v, want %v", in, got, want)
		}
		if got.Location() != time.UTC {
			t.Errorf("ParseTime(%q) returned %v, want UTC", in, got.Location())
		}
	}
}

// An unparseable timestamp must report failure rather than the zero time, which a
// caller would read as "1970" — i.e. infinitely stale.
func TestParseTimeRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "not a time", "2026-13-45 99:99:99Z", "1758450600"} {
		if _, ok := ParseTime(in); ok {
			t.Errorf("ParseTime(%q) reported success", in)
		}
	}
}
