package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The beat must pass the same gates a customer's check-in does: the token, and
// the Content-Type and Origin without which SvelteKit refuses a POST (#588).
func TestWebBeatSendsWhatTheLivenessRouteAccepts(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	b := newWebBeater(srv.URL+"/", "tok")
	if err := b.beat(context.Background()); err != nil {
		t.Fatalf("beat: %s", err)
	}
	if got == nil {
		t.Fatal("no request reached the server")
	}
	checks := map[string][2]string{
		"method":        {got.Method, http.MethodPost},
		"path":          {got.URL.Path, "/internal/liveness"},
		"authorization": {got.Header.Get("Authorization"), "Bearer tok"},
		"content-type":  {got.Header.Get("Content-Type"), "application/json"},
		"origin":        {got.Header.Get("Origin"), srv.URL},
	}
	for name, c := range checks {
		if c[0] != c[1] {
			t.Errorf("%s = %q, want %q", name, c[0], c[1])
		}
	}
}

func TestWebBeatOffWithoutURLOrToken(t *testing.T) {
	if b := newWebBeater("", "tok"); b != nil {
		t.Error("no WEB_URL should disable the beat")
	}
	if b := newWebBeater("https://nabz.sh", ""); b != nil {
		t.Error("no HEALTH_DEBUG_TOKEN should disable the beat")
	}
	var b *webBeater
	b.run(context.Background(), time.Millisecond) // the disabled state returns at once
}

// A refused beat is an error, and neither it nor the log carries the token.
func TestWebBeatFailureKeepsTheTokenOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	b := newWebBeater(srv.URL, "s3cret-token")
	err := b.beat(context.Background())
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("a 404 should fail the beat with its status, got %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	b.run(ctx, 10*time.Millisecond)
	if strings.Contains(err.Error()+buf.String(), "s3cret-token") {
		t.Fatalf("the token leaked: %s / %s", err, buf.String())
	}
	if n := strings.Count(buf.String(), "failed"); n != 1 {
		t.Fatalf("a run of failures should log once, logged %d times:\n%s", n, buf.String())
	}
}

// The beat keeps coming on its own clock, and a failure does not stop it.
func TestWebBeatKeepsBeatingThroughFailures(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&hits, 1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	newWebBeater(srv.URL, "tok").run(ctx, 20*time.Millisecond)
	if n := atomic.LoadInt32(&hits); n < 3 {
		t.Fatalf("beat %d times in 200ms at a 20ms interval, want at least 3", n)
	}
	if !strings.Contains(buf.String(), "recovered") {
		t.Fatalf("the recovery after a failed beat was not logged:\n%s", buf.String())
	}
}
