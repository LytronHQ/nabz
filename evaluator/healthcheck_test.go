package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Unset HEALTHCHECK_PING_URL means the feature does not exist: nothing is
// constructed and nothing is ever sent.
func TestHealthPingerDisabledByDefault(t *testing.T) {
	if p := newHealthPinger(""); p != nil {
		t.Fatalf("empty URL should disable the pinger, got %+v", p)
	}
	// The nil pinger IS the disabled state, so calling it must be safe — the main
	// loop calls it unconditionally.
	var p *healthPinger
	p.ping(time.Now())
}

func TestHealthPingerRateLimits(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := newHealthPinger(srv.URL)
	start := time.Now()

	p.ping(start)                      // first ever — sends
	p.ping(start.Add(1 * time.Second)) // the main loop turns every 10s…
	p.ping(start.Add(30 * time.Second))
	p.ping(start.Add(pingInterval - time.Second)) // …so it must not send per turn
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("within one interval: sent %d pings, want 1", got)
	}

	p.ping(start.Add(pingInterval))
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("after the interval elapsed: sent %d pings, want 2", got)
	}
}

// A dead-man's switch that is itself down must not take the evaluator with it:
// the ping is best-effort, and its failures are logged rather than propagated.
func TestHealthPingerSurvivesAFailingEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	p := newHealthPinger(srv.URL)
	p.ping(time.Now())

	srv.Close() // now unreachable
	p.ping(time.Now().Add(2 * pingInterval))

	newHealthPinger("http://%zz-not-a-url").ping(time.Now())
}

// #656: the ping URL's last segment is Better Stack's secret for the heartbeat;
// anyone holding it can report the evaluator alive. A failed ping logged Go's
// url.Error, which quotes the whole URL, so every timeout wrote the secret into
// the container log — and from there it reached a chat transcript.
func TestHealthPingerKeepsTheURLOutOfTheLog(t *testing.T) {
	const secret = "s3cretHeartbeatToken"
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close() // a refused connection, like the timeouts of 21 Oct
	newHealthPinger(srv.URL + "/api/v1/heartbeat/" + secret).ping(time.Now())
	newHealthPinger("http://%zz/api/v1/heartbeat/" + secret).ping(time.Now())

	out := buf.String()
	if !strings.Contains(out, "Healthcheck ping") {
		t.Fatalf("no ping failure was logged at all: %q", out)
	}
	if strings.Contains(out, secret) {
		t.Fatalf("the log carries the heartbeat secret: %q", out)
	}
}
