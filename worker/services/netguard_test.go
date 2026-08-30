package services

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"monitors/corelib/models"
)

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.5.5.5", "::1", // loopback
		"10.0.0.1", "172.16.0.1", "192.168.1.1", "fc00::1", // private
		"169.254.169.254", "169.254.0.1", "fe80::1", // link-local (incl. cloud metadata)
		"0.0.0.0", "::", // unspecified
		"224.0.0.1", "ff02::1", // multicast
		"100.64.0.1", "100.127.255.255", // CGNAT (RFC 6598)
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", // IPv4-mapped IPv6 must not slip through
	}
	for _, s := range blocked {
		if !isBlockedIP(net.ParseIP(s)) {
			t.Errorf("isBlockedIP(%s) = false, want true (should be blocked)", s)
		}
	}

	public := []string{
		"8.8.8.8", "1.1.1.1", "93.184.216.34",
		"2001:4860:4860::8888", "2606:2800:220:1:248:1893:25c8:1946",
	}
	for _, s := range public {
		if isBlockedIP(net.ParseIP(s)) {
			t.Errorf("isBlockedIP(%s) = true, want false (public, should be allowed)", s)
		}
	}

	// An unparseable/nil IP fails closed.
	if !isBlockedIP(nil) {
		t.Error("isBlockedIP(nil) = false, want true (fail closed)")
	}
}

// With the guard on, a check whose target resolves to a loopback/private IP is
// rejected at dial time; with it off, behavior is unchanged. httptest binds to
// 127.0.0.1, so it doubles as a "private destination" here. The guard sits on the
// dialer, so the same rejection applies to every redirect hop.
func TestHTTPGuardBlocksPrivateTarget(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Guard OFF (default): the loopback target is reachable.
	blockPrivateTargets = false
	if r := runHTTPCheck(srv.URL, models.MonitorConfig{}); !r.Up || r.Error != "" {
		t.Fatalf("guard off: expected up with no error, got %+v", r)
	}

	// Guard ON: the same target is refused before any bytes are sent.
	blockPrivateTargets = true
	defer func() { blockPrivateTargets = false }()
	r := runHTTPCheck(srv.URL, models.MonitorConfig{})
	if r.Up {
		t.Fatalf("guard on: expected down for a loopback target, got up: %+v", r)
	}
	if !strings.Contains(r.Error, "blocked") {
		t.Fatalf("guard on: expected a 'blocked' error, got %q", r.Error)
	}
}

// The TCP engine (port/ping) honors the same guard.
func TestTCPGuardBlocksPrivateTarget(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	blockPrivateTargets = true
	defer func() { blockPrivateTargets = false }()
	r := runTCPCheck(ln.Addr().String())
	if r.Up {
		t.Fatalf("guard on: expected TCP check down for a loopback target, got %+v", r)
	}
	if !strings.Contains(r.Error, "blocked") {
		t.Fatalf("guard on: expected a 'blocked' error, got %q", r.Error)
	}
}
