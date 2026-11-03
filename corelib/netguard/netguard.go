// Package netguard keeps user-chosen outbound requests (monitor checks in the
// worker, alert deliveries in the evaluator) off private and internal addresses.
//
// Both services run inside the fleet's private network, next to PocketBase and
// each other, so a destination a user picks must resolve to a public address.
// The check runs at dial time, after DNS resolution, so it also covers DNS
// rebinding and every redirect hop.
//
// It is on by default (#669). It used to be opt-in for the anonymous zone only,
// which left the signed-in zones and the evaluator without it, and a deploy path
// that forgot the variable left even the anonymous zone without it. The only
// opt-out is ALLOW_PRIVATE_TARGETS=true, for the dev fleet and the e2e stack,
// whose fixtures live on private Docker addresses, and for self-hosters who
// deliberately monitor private hosts.
package netguard

import (
	"fmt"
	"net"
	"os"
	"sync/atomic"
	"syscall"
)

var allowPrivate atomic.Bool

func init() { allowPrivate.Store(os.Getenv("ALLOW_PRIVATE_TARGETS") == "true") }

// AllowPrivate reports whether private destinations are allowed (the opt-out).
func AllowPrivate() bool { return allowPrivate.Load() }

// SetAllowPrivate overrides the setting and returns a function restoring the
// previous one. For tests, whose loopback fixtures are private destinations.
func SetAllowPrivate(v bool) (restore func()) {
	prev := allowPrivate.Swap(v)
	return func() { allowPrivate.Store(prev) }
}

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// Ranges not covered by net.IP's own predicates. Each reaches something other
// than the public internet from a hosted node.
var extraBlocked = []*net.IPNet{
	mustCIDR("0.0.0.0/8"),      // "this network"; 0.x reaches the local host on Linux
	mustCIDR("100.64.0.0/10"),  // CGNAT (RFC 6598)
	mustCIDR("192.0.0.0/24"),   // IETF protocol assignments
	mustCIDR("198.18.0.0/15"),  // benchmarking
	mustCIDR("240.0.0.0/4"),    // reserved, incl. 255.255.255.255
	mustCIDR("64:ff9b::/96"),   // NAT64: embeds an IPv4 address, possibly private
	mustCIDR("64:ff9b:1::/48"), // local-use NAT64
	mustCIDR("2002::/16"),      // 6to4: embeds an IPv4 address
	mustCIDR("100::/64"),       // discard-only
}

// IsBlockedIP reports whether a user-chosen request must not reach ip: loopback,
// private (RFC 1918, fc00::/7), link-local (incl. the 169.254.169.254 metadata
// address and fe80::/10), unspecified, multicast, or one of extraBlocked.
// IPv4-mapped IPv6 is unwrapped first. A nil IP is blocked (fail closed).
func IsBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, n := range extraBlocked {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Control is a net.Dialer Control hook. It sees the concrete ip:port about to be
// connected, after resolution, on the first request and on every redirect hop
// that goes through the same dialer. With the opt-out set it allows everything.
func Control(_, address string, _ syscall.RawConn) error {
	if AllowPrivate() {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("blocked: unparseable address %q", address)
	}
	if IsBlockedIP(net.ParseIP(host)) {
		return fmt.Errorf("blocked target %s: private/loopback/link-local addresses are not allowed", host)
	}
	return nil
}
