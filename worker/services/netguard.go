package services

import (
	"net"
	"net/http"
	"syscall"
	"time"

	"monitors/corelib/netguard"
)

// Outbound destination guard. The check itself lives in corelib/netguard, shared
// with the evaluator's alert delivery (#669).
//
// It used to be opt-in (BLOCK_PRIVATE_TARGETS=true), set only for the anonymous
// "free" zone. The signed-in zones ran tenant-chosen targets from inside the
// private network with no guard, and a free-zone worker started by a path that
// forgot the variable had none either. The dial hook is now always installed and
// refuses private destinations unless ALLOW_PRIVATE_TARGETS=true (dev fleet, e2e,
// self-hosters who monitor private hosts on purpose).

// dialControl is the Control hook for the TCP and DNS dialers.
func dialControl() func(network, address string, c syscall.RawConn) error {
	return netguard.Control
}

// guardedHTTPTransport is a clone of the check transport whose dialer runs the
// guard on every connection, the initial request and each redirect hop. Proxy is
// off: through a proxy the guard would check the proxy's address, not the target.
var guardedHTTPTransport = func() *http.Transport {
	t := checkTransport()
	t.Proxy = nil
	t.DialContext = (&net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   netguard.Control,
	}).DialContext
	return t
}()

// httpTransport returns the transport for outbound HTTP checks.
func httpTransport() http.RoundTripper { return guardedHTTPTransport }

// Both check transports dial a new connection for every check. Sharing a
// keep-alive pool sent some checks out on a connection the target's edge had
// just closed: they failed in a few milliseconds with no status code, about 0.5%
// of checks against sites that answered 200 to every request that reached them
// (#595). A monitor should also measure what a visitor pays — DNS, connect and
// TLS — which a reused connection skips.
func checkTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DisableKeepAlives = true
	return t
}

// plainHTTPTransport is for operator-chosen URLs only (the canaries in
// WORKER_CANARY_URLS, which e2e points at a private fixture). Never tenant targets.
var plainHTTPTransport = checkTransport()
