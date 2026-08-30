package services

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"syscall"
	"time"
)

// SSRF guard (#268, groundwork for the anonymous "try it" zone, #265).
//
// Anonymous, unauthenticated visitors will point checks at arbitrary URLs in an
// isolated "free" zone. Without a guard, a target — or a redirect hop — could
// reach the worker's own loopback, the private network, or the cloud-metadata
// endpoint (169.254.169.254). This gates outbound checks to PUBLIC destinations.
//
// It's OFF by default so the existing eu/us zones and the e2e fixture (which lives
// on a private docker IP) are unaffected; the free-zone worker sets
// BLOCK_PRIVATE_TARGETS=true. Real zones may opt in later — no legitimate uptime
// target resolves to a private/loopback address from a hosted worker anyway.

// blockPrivateTargets is read once at startup; tests set it directly.
var blockPrivateTargets = os.Getenv("BLOCK_PRIVATE_TARGETS") == "true"

// cgnat is RFC 6598 shared address space (100.64.0.0/10) — not covered by
// net.IP.IsPrivate but not a valid public target either.
var cgnat = func() *net.IPNet { _, n, _ := net.ParseCIDR("100.64.0.0/10"); return n }()

// isBlockedIP reports whether an address is one an untrusted target must not reach:
// loopback, private (RFC1918 / fc00::/7), CGNAT, link-local (incl. the
// 169.254.169.254 cloud-metadata endpoint and IPv6 fe80::/10), unspecified, or
// multicast. IPv4-mapped IPv6 is unwrapped first so ::ffff:127.0.0.1 can't slip
// through. A nil/unparseable IP is treated as blocked (fail closed).
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() ||
		cgnat.Contains(ip)
}

// guardDialControl is a net.Dialer Control hook. It runs AFTER DNS resolution with
// the concrete ip:port about to be connected, so it checks the actual destination
// (mitigating DNS rebinding) — on the first hop and, since the same dialer serves
// the HTTP transport, on every redirect hop too.
func guardDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("blocked: unparseable address %q", address)
	}
	if isBlockedIP(net.ParseIP(host)) {
		return fmt.Errorf("blocked target %s: private/loopback/link-local addresses are not allowed", host)
	}
	return nil
}

// dialControl returns the Control hook when the guard is enabled, or nil (a no-op,
// identical to default dialing) when it's off. Shared by the TCP and DNS dialers.
func dialControl() func(network, address string, c syscall.RawConn) error {
	if !blockPrivateTargets {
		return nil
	}
	return guardDialControl
}

// guardedHTTPTransport is a clone of the default transport whose dialer enforces
// the guard on every connection (initial request + each redirect hop). Built once.
var guardedHTTPTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = (&net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   guardDialControl,
	}).DialContext
	return t
}()

// httpTransport returns the transport for outbound HTTP checks: the guarded clone
// when BLOCK_PRIVATE_TARGETS is on, otherwise the shared default (unchanged behavior).
func httpTransport() http.RoundTripper {
	if !blockPrivateTargets {
		return http.DefaultTransport
	}
	return guardedHTTPTransport
}
