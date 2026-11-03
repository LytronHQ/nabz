package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
)

// blackhole accepts connections and never answers, like a destination built to
// hold the evaluator.
func blackhole(t *testing.T) (url string, accepted *int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var n int32
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&n, 1)
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
	})
	return "http://" + ln.Addr().String() + "/hook", &n
}

func shortDeliveryTimeout(t *testing.T, d time.Duration) {
	prev := deliveryClient.Timeout
	deliveryClient.Timeout = d
	t.Cleanup(func() { deliveryClient.Timeout = prev })
}

// One alert to channels that never answer returns after one attempt each, in
// parallel, not after channels x 4 attempts x 30 s (#670). The production timeout
// is shortened here; the shape is what is tested.
func TestDispatchToUnresponsiveChannelsIsBounded(t *testing.T) {
	shortDeliveryTimeout(t, 300*time.Millisecond)
	var channels []models.AlertChannel
	var counters []*int32
	for i := 0; i < 5; i++ {
		u, n := blackhole(t)
		ch := models.AlertChannel{Id: "c" + string(rune('a'+i)), Type: "webhook"}
		ch.Config.URL = u
		channels = append(channels, ch)
		counters = append(counters, n)
	}
	start := time.Now()
	results := dispatch(alertConfig{}, channels, "s", "b", map[string]interface{}{"event": "test"})
	took := time.Since(start)
	if took > 2*time.Second {
		t.Fatalf("5 unresponsive channels held dispatch for %s; want about one timeout", took)
	}
	for i, r := range results {
		if r.Outcome != "failed" {
			t.Errorf("channel %d: outcome %q, want failed", i, r.Outcome)
		}
		if got := atomic.LoadInt32(counters[i]); got != 1 {
			t.Errorf("channel %d: %d connection attempts, want exactly 1 (no retries)", i, got)
		}
	}
}

// The whole alert stops at the deadline even if a send never returns; its late
// result is dropped and the channel is reported as not delivered.
func TestRunBoundedStopsAtTheDeadline(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	start := time.Now()
	res := runBounded(3, 200*time.Millisecond,
		func(i int) deliveryResult {
			if i == 1 {
				<-release // never finishes within the deadline
			}
			return deliveryResult{Outcome: "delivered"}
		},
		func(i int) deliveryResult {
			return deliveryResult{Outcome: "failed", Detail: errDispatchDeadline.Error()}
		})
	if took := time.Since(start); took > time.Second {
		t.Fatalf("runBounded waited %s past a 200ms deadline", took)
	}
	if res[0].Outcome != "delivered" || res[2].Outcome != "delivered" || res[1].Outcome != "failed" {
		t.Fatalf("results = %+v", res)
	}
}

// A destination that streams a huge body gets at most maxDeliveryBody read.
func TestDeliveryReadIsCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		chunk := []byte(strings.Repeat("x", 1<<20))
		for i := 0; i < 16; i++ { // 16 MiB
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	res, err := deliverPOST(srv.URL, []byte("{}"))
	if err != nil {
		t.Fatalf("deliverPOST: %v", err)
	}
	if len(res.Body) != maxDeliveryBody {
		t.Fatalf("read %d bytes, want the %d-byte cap", len(res.Body), maxDeliveryBody)
	}
}

// A monitor name with line breaks stays one Subject header, and the body stays
// the plain-text alert (#670).
func TestEmailSubjectCannotAddHeaders(t *testing.T) {
	host, port, captured := startSMTPSink(t)
	cfg := alertConfig{smtpHost: host, smtpPort: port, smtpFrom: "alerts@nabz.sh"}
	name := "shop\r\nReply-To: x@evil.example\r\nContent-Type: text/html\r\n\r\n<h1>hi</h1>"
	if err := sendEmail(cfg, "dev@example.com", "[nabz] "+name+" is DOWN", "shop is down."); err != nil {
		t.Fatalf("sendEmail: %v", err)
	}
	var raw []byte
	select {
	case raw = <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("sink captured no message")
	}
	head, body, ok := strings.Cut(string(raw), "\r\n\r\n")
	if !ok {
		t.Fatalf("no header/body separator: %q", raw)
	}
	for _, bad := range []string{"\r\nReply-To:", "\r\nContent-Type: text/html"} {
		if strings.Contains(head, bad) {
			t.Errorf("injected header present: %q in\n%q", bad, head)
		}
	}
	if !strings.Contains(head, "Content-Type: text/plain") || !strings.HasPrefix(body, "shop is down.") {
		t.Errorf("headers or body replaced:\n%q", raw)
	}
}

// One tick takes at most the cap and one request per user, oldest first, so one
// user's queue cannot crowd out another's.
func TestFairTestAlerts(t *testing.T) {
	q := []pb.TestAlert{{Id: "1", User: "a"}, {Id: "2", User: "a"}, {Id: "3", User: "b"}, {Id: "4", User: "a"}, {Id: "5", User: "c"}}
	got := fairTestAlerts(q, 2)
	if len(got) != 2 || got[0].Id != "1" || got[1].Id != "3" {
		t.Fatalf("got %+v, want ids 1 and 3", got)
	}
	if got := fairTestAlerts(q, 10); len(got) != 3 {
		t.Fatalf("one per user: got %d, want 3", len(got))
	}
}
