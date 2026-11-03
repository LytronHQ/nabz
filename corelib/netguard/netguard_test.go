package netguard

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.5.5.5", "::1",
		"10.0.0.1", "172.16.0.1", "192.168.1.1", "fc00::1",
		"169.254.169.254", "169.254.0.1", "fe80::1",
		"0.0.0.0", "::", "0.1.2.3",
		"224.0.0.1", "ff02::1",
		"100.64.0.1", "100.127.255.255",
		"192.0.0.8", "198.18.0.1", "198.19.255.255", "240.0.0.1", "255.255.255.255",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1",
		"64:ff9b::a00:1", "64:ff9b:1::1", "2002:a00:1::1", "100::1",
	}
	for _, s := range blocked {
		if !IsBlockedIP(net.ParseIP(s)) {
			t.Errorf("IsBlockedIP(%s) = false, want blocked", s)
		}
	}
	public := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "198.20.0.1",
		"2001:4860:4860::8888", "2606:2800:220:1:248:1893:25c8:1946"}
	for _, s := range public {
		if IsBlockedIP(net.ParseIP(s)) {
			t.Errorf("IsBlockedIP(%s) = true, want allowed", s)
		}
	}
	if !IsBlockedIP(nil) {
		t.Error("IsBlockedIP(nil) must fail closed")
	}
}

func guardedClient() *http.Client {
	return &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Control: Control}).DialContext},
	}
}

// On by default: a loopback destination is refused before a byte is sent, and
// the opt-out restores it. httptest listens on 127.0.0.1, a private destination.
func TestControlBlocksByDefaultAndOptOutAllows(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++ }))
	defer srv.Close()

	defer SetAllowPrivate(false)()
	_, err := guardedClient().Get(srv.URL)
	if err == nil || !strings.Contains(err.Error(), "blocked target") {
		t.Fatalf("default must refuse a loopback target, got %v", err)
	}
	if hits != 0 {
		t.Fatalf("the refused request reached the server %d times", hits)
	}

	restore := SetAllowPrivate(true)
	defer restore()
	if _, err := guardedClient().Get(srv.URL); err != nil {
		t.Fatalf("with the opt-out the loopback target must be reachable: %v", err)
	}
}

// A redirect is dialed through the same Control, so a hop into a private
// address is refused too. The first hop is allowed here only so the test can
// serve the redirect from loopback; the check is per dial.
func TestControlBlocksRedirectHop(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer internal.Close()
	dials := 0
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil,
		DialContext: (&net.Dialer{Control: func(n, a string, c syscall.RawConn) error {
			dials++
			if dials == 1 {
				return nil // the "public" first hop
			}
			return Control(n, a, c)
		}}).DialContext,
		DisableKeepAlives: true}}
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internal.URL, http.StatusFound)
	}))
	defer redirector.Close()
	defer SetAllowPrivate(false)()
	_, err := client.Get(redirector.URL)
	if err == nil || !strings.Contains(err.Error(), "blocked target") {
		t.Fatalf("a redirect into a private address must be refused, got %v", err)
	}
}
