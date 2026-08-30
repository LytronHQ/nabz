package domain

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// ErrNoExpiry means the lookup reached a server but found no expiration date
// (some TLDs — e.g. .de, .uk via some paths — don't publish one). Treated as
// "unknown", never as a failure that could imply the domain is down.
var ErrNoExpiry = errors.New("no expiration date in registry data")

const (
	rdapBootstrap = "https://rdap.org/domain/"
	ianaWhois     = "whois.iana.org"
	userAgent     = "nabz-monitor/1.0 (domain-expiry)"
)

// Result is a resolved (or attempted) domain-expiry lookup.
type Result struct {
	Domain    string    // registrable domain that was queried
	ExpiresAt time.Time // registration expiry (zero if unknown)
	Source    string    // "rdap" or "whois"
}

// LookupExpiry resolves when a registrable domain's registration lapses. It
// tries RDAP first (structured, reliable) and falls back to WHOIS. A non-nil
// error means "unknown" — the caller keeps any prior value and never treats it
// as the domain being down.
func LookupExpiry(ctx context.Context, domain string) (Result, error) {
	res := Result{Domain: domain}

	// RDAP first — structured and authoritative. On any RDAP failure (network,
	// rate-limit, unsupported TLD, or no expiry field) fall back to WHOIS.
	if exp, err := lookupRDAP(ctx, domain); err == nil {
		res.ExpiresAt, res.Source = exp, "rdap"
		return res, nil
	}

	exp, err := lookupWHOIS(ctx, domain)
	if err != nil {
		return res, err
	}
	res.ExpiresAt, res.Source = exp, "whois"
	return res, nil
}

// --- RDAP -------------------------------------------------------------------

func lookupRDAP(ctx context.Context, domain string) (time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rdapBootstrap+domain, nil)
	if err != nil {
		return time.Time{}, err
	}
	req.Header.Set("Accept", "application/rdap+json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return time.Time{}, fmt.Errorf("rdap %s: status %d", domain, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return time.Time{}, err
	}
	return parseRDAPExpiry(body)
}

// rdapResponse is the slice of the RDAP domain object we need: the events list,
// where the "expiration" action carries the registration end date.
type rdapResponse struct {
	Events []struct {
		Action string `json:"eventAction"`
		Date   string `json:"eventDate"`
	} `json:"events"`
}

// parseRDAPExpiry pulls the expiration event date from an RDAP domain response.
func parseRDAPExpiry(body []byte) (time.Time, error) {
	var r rdapResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return time.Time{}, err
	}
	for _, e := range r.Events {
		if strings.EqualFold(e.Action, "expiration") {
			if t, err := time.Parse(time.RFC3339, e.Date); err == nil {
				return t.UTC(), nil
			}
			// Some servers omit the timezone; accept a date-only form too.
			if len(e.Date) >= 10 {
				if t, err := time.Parse("2006-01-02", e.Date[:10]); err == nil {
					return t.UTC(), nil
				}
			}
		}
	}
	return time.Time{}, ErrNoExpiry
}

// --- WHOIS ------------------------------------------------------------------

// lookupWHOIS asks IANA which WHOIS server is authoritative for the domain's
// TLD, then queries that server and parses the expiry from its free-text reply.
func lookupWHOIS(ctx context.Context, domain string) (time.Time, error) {
	referral, err := whoisQuery(ctx, ianaWhois, domain)
	if err != nil {
		return time.Time{}, err
	}
	server := whoisReferral(referral)
	if server == "" {
		return time.Time{}, ErrNoExpiry
	}
	body, err := whoisQuery(ctx, server, domain)
	if err != nil {
		return time.Time{}, err
	}
	return parseWHOISExpiry(body)
}

// whoisQuery opens a WHOIS (port 43) connection, sends the query, and returns
// the full reply. It honours the context deadline for the whole exchange.
func whoisQuery(ctx context.Context, server, query string) (string, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(server, "43"))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if _, err := conn.Write([]byte(query + "\r\n")); err != nil {
		return "", err
	}
	body, err := io.ReadAll(io.LimitReader(conn, 1<<20))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// whoisReferral finds the referred registry WHOIS server in an IANA reply
// ("refer:" or "whois:" line).
func whoisReferral(text string) string {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "refer:") || strings.HasPrefix(lower, "whois:") {
			if _, v, ok := strings.Cut(line, ":"); ok {
				if s := strings.TrimSpace(v); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

// whoisExpiryLabels are the field names registries use for the registration end
// date, lower-cased. Order doesn't matter — the first match on any line wins.
var whoisExpiryLabels = []string{
	"registry expiry date",
	"registrar registration expiration date",
	"expiration date",
	"expiration time",
	"expiry date",
	"expire",
	"expires",
	"paid-till", // .ru / .su
	"renewal date",
}

// whoisDateLayouts are the date formats seen across registry WHOIS output.
var whoisDateLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05Z",
	"2006-01-02T15:04:05.000Z",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"02-Jan-2006",
	"2006.01.02",
	"02.01.2006",
	"January 2 2006",
}

// parseWHOISExpiry scans free-text WHOIS output for a known expiry label and
// parses its value against the known date layouts.
func parseWHOISExpiry(text string) (time.Time, error) {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		label, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		label = strings.ToLower(strings.TrimSpace(label))
		if !matchesExpiryLabel(label) {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if t, ok := parseWHOISDate(value); ok {
			return t, nil
		}
	}
	return time.Time{}, ErrNoExpiry
}

func matchesExpiryLabel(label string) bool {
	for _, l := range whoisExpiryLabels {
		if label == l {
			return true
		}
	}
	return false
}

func parseWHOISDate(value string) (time.Time, bool) {
	// A trailing "Z" split off ".000Z" style values, and stray parentheses,
	// occasionally trip Parse; try the raw value against each layout.
	for _, layout := range whoisDateLayouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// --- shared -----------------------------------------------------------------

// DaysUntil is whole days from now until expiry, floored (negative once past).
// A zero expiry (unknown) returns 0 with ok=false so callers can distinguish
// "unknown" from "expires today".
func DaysUntil(expiry, now time.Time) (days int, ok bool) {
	if expiry.IsZero() {
		return 0, false
	}
	return int(expiry.Sub(now).Hours() / 24), true
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
