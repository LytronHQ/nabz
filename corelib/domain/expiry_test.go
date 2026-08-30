package domain

import (
	"errors"
	"testing"
	"time"
)

func TestParseRDAPExpiry(t *testing.T) {
	// A realistic RDAP domain object: the expiration event carries the date,
	// alongside other events we must ignore.
	body := []byte(`{
		"objectClassName": "domain",
		"ldhName": "EXAMPLE.COM",
		"events": [
			{"eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z"},
			{"eventAction": "last changed",  "eventDate": "2024-08-14T07:01:34Z"},
			{"eventAction": "expiration",    "eventDate": "2026-08-13T04:00:00Z"}
		]
	}`)
	got, err := parseRDAPExpiry(body)
	if err != nil {
		t.Fatalf("parseRDAPExpiry error: %v", err)
	}
	want := time.Date(2026, 8, 13, 4, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("parseRDAPExpiry = %v, want %v", got, want)
	}
}

func TestParseRDAPExpiryCaseInsensitive(t *testing.T) {
	// eventAction casing varies across registries.
	body := []byte(`{"events":[{"eventAction":"Expiration","eventDate":"2027-01-02T00:00:00Z"}]}`)
	got, err := parseRDAPExpiry(body)
	if err != nil {
		t.Fatalf("parseRDAPExpiry error: %v", err)
	}
	if want := time.Date(2027, 1, 2, 0, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("parseRDAPExpiry = %v, want %v", got, want)
	}
}

func TestParseRDAPExpiryNoEvent(t *testing.T) {
	body := []byte(`{"events":[{"eventAction":"registration","eventDate":"1995-08-14T04:00:00Z"}]}`)
	if _, err := parseRDAPExpiry(body); !errors.Is(err, ErrNoExpiry) {
		t.Errorf("parseRDAPExpiry with no expiration event: got %v, want ErrNoExpiry", err)
	}
}

func TestParseWHOISExpiry(t *testing.T) {
	// Each snippet is a different registry's label + date format.
	cases := []struct {
		name string
		text string
		want time.Time
	}{
		{
			name: "verisign registry expiry date",
			text: "Domain Name: EXAMPLE.COM\r\nRegistry Expiry Date: 2026-08-13T04:00:00Z\r\nRegistrar: X\r\n",
			want: time.Date(2026, 8, 13, 4, 0, 0, 0, time.UTC),
		},
		{
			name: "generic expiration date dd-mon-yyyy",
			text: "Expiration Date: 13-Aug-2026\n",
			want: time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "registrar registration expiration date",
			text: "Registrar Registration Expiration Date: 2025-12-01T09:30:00Z\n",
			want: time.Date(2025, 12, 1, 9, 30, 0, 0, time.UTC),
		},
		{
			name: "ru paid-till",
			text: "domain: EXAMPLE.RU\npaid-till: 2026.03.15\nstate: REGISTERED\n",
			want: time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "date-only expiry date",
			text: "Expiry date: 2026-08-13\n",
			want: time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseWHOISExpiry(c.text)
			if err != nil {
				t.Fatalf("parseWHOISExpiry error: %v", err)
			}
			if !got.Equal(c.want) {
				t.Errorf("parseWHOISExpiry = %v, want %v", got, c.want)
			}
		})
	}
}

func TestParseWHOISExpiryNone(t *testing.T) {
	text := "Domain Name: EXAMPLE.DE\nStatus: connect\nNserver: ns1.example.de\n"
	if _, err := parseWHOISExpiry(text); !errors.Is(err, ErrNoExpiry) {
		t.Errorf("parseWHOISExpiry with no expiry line: got %v, want ErrNoExpiry", err)
	}
}

func TestWHOISReferral(t *testing.T) {
	iana := "% IANA WHOIS server\ndomain: COM\norganisation: VeriSign\nrefer:  whois.verisign-grs.com\n"
	if got := whoisReferral(iana); got != "whois.verisign-grs.com" {
		t.Errorf("whoisReferral = %q, want whois.verisign-grs.com", got)
	}
	if got := whoisReferral("no referral here\n"); got != "" {
		t.Errorf("whoisReferral with none = %q, want empty", got)
	}
}

func TestDaysUntil(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		expiry time.Time
		want   int
		wantOK bool
	}{
		{"thirty days", now.Add(30 * 24 * time.Hour), 30, true},
		{"same day rounds down", now.Add(20 * time.Hour), 0, true},
		{"already expired", now.Add(-48 * time.Hour), -2, true},
		{"zero is unknown", time.Time{}, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			days, ok := DaysUntil(c.expiry, now)
			if ok != c.wantOK || days != c.want {
				t.Errorf("DaysUntil = (%d,%v), want (%d,%v)", days, ok, c.want, c.wantOK)
			}
		})
	}
}
