package services

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"monitors/corelib/models"
	"monitors/corelib/netguard"
)

// The address list itself is tested in corelib/netguard. TestMain opts the
// package's other tests out (their fixtures are loopback servers), so each guard
// test below turns the guard back on explicitly, as a production zone runs.
var allowPrivateAtStart bool

func TestMain(m *testing.M) {
	allowPrivateAtStart = netguard.AllowPrivate()
	restore := netguard.SetAllowPrivate(true)
	code := m.Run()
	restore()
	os.Exit(code)
}

// A worker started with no setting at all refuses a loopback target (#669):
// every zone, not only the anonymous one, runs tenant-chosen targets from inside
// the private network. Run in a child process with an empty environment, so the
// guard's start-up read is the one under test.
func TestGuardIsOnWithoutAnySetting(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestGuardDefaultHelper$", "-test.v")
	cmd.Env = []string{"GUARD_DEFAULT_HELPER=1"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "check up=false blocked=true") {
		t.Fatalf("with an empty environment a loopback target must be refused, got:\n%s", out)
	}
}

func TestGuardDefaultHelper(t *testing.T) {
	if os.Getenv("GUARD_DEFAULT_HELPER") != "1" {
		t.Skip("run by TestGuardIsOnWithoutAnySetting")
	}
	defer netguard.SetAllowPrivate(allowPrivateAtStart)() // undo TestMain's opt-out
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	r := runHTTPCheck(srv.URL, models.MonitorConfig{})
	fmt.Printf("check up=%v blocked=%v\n", r.Up, strings.Contains(r.Error, "blocked"))
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

	// Opted out (dev, e2e): the loopback target is reachable.
	if r := runHTTPCheck(srv.URL, models.MonitorConfig{}); !r.Up || r.Error != "" {
		t.Fatalf("opted out: expected up with no error, got %+v", r)
	}

	// Guard on, as every production zone runs: refused before any bytes are sent.
	defer netguard.SetAllowPrivate(false)()
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

	defer netguard.SetAllowPrivate(false)()
	r := runTCPCheck(ln.Addr().String())
	if r.Up {
		t.Fatalf("guard on: expected TCP check down for a loopback target, got %+v", r)
	}
	if !strings.Contains(r.Error, "blocked") {
		t.Fatalf("guard on: expected a 'blocked' error, got %q", r.Error)
	}
}
