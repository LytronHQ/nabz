// Package domain resolves when a monitor target's DOMAIN registration lapses —
// distinct from its TLS certificate (that's captured per-check in the worker).
// Registration data changes rarely and registries rate-limit hard, so lookups
// are infrequent and cached by the caller. Preference is RDAP (structured JSON),
// with a best-effort WHOIS (port 43) fallback when RDAP has no answer.
package domain

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// ErrNoDomain means the target has no registrable domain to look up — an IP
// literal, localhost, or an unqualified/private name. Callers skip these
// silently (never a false "unknown"; there's simply nothing to query).
var ErrNoDomain = errors.New("target has no registrable domain")

// RegistrableDomain reduces a monitor target to the registrable ("eTLD+1")
// domain a registry actually holds a record for, using the Public Suffix List
// so multi-label suffixes resolve correctly (api.example.co.uk -> example.co.uk,
// not co.uk). The target may be a URL, a bare host, or host:port.
func RegistrableDomain(target string) (string, error) {
	host := hostFromTarget(target)
	if host == "" {
		return "", ErrNoDomain
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))

	// IP literals (v4/v6) and single-label names have no registrable domain.
	if net.ParseIP(host) != nil || !strings.Contains(host, ".") {
		return "", ErrNoDomain
	}

	reg, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil || reg == "" {
		return "", ErrNoDomain
	}
	return reg, nil
}

// hostFromTarget extracts the hostname from a URL, a host:port, or a bare host.
func hostFromTarget(target string) string {
	t := strings.TrimSpace(target)
	if t == "" {
		return ""
	}

	// A scheme-qualified target parses as a URL; Hostname() drops any port.
	if strings.Contains(t, "://") {
		if u, err := url.Parse(t); err == nil && u.Hostname() != "" {
			return u.Hostname()
		}
		return ""
	}

	// Otherwise it's a host, host:port, or host/path. Drop any path first.
	if i := strings.IndexByte(t, '/'); i >= 0 {
		t = t[:i]
	}
	// Strip a trailing :port (but not the colons inside a bare IPv6 literal).
	if h, _, err := net.SplitHostPort(t); err == nil {
		t = h
	}
	return strings.Trim(t, "[]")
}
