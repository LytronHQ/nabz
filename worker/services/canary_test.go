package services

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"monitors/corelib/models"
)

// A canary URL nothing listens on: a closed httptest server's address.
func deadURL(t *testing.T) string {
	srv := httptest.NewServer(http.NotFoundHandler())
	u := srv.URL
	srv.Close()
	return u + "/trace"
}

func failed() models.CheckResult {
	return models.CheckResult{Up: false, Error: "Get \"https://site.example\": context deadline exceeded"}
}

// The site's own failure, with this worker's network fine: it counts (#598).
func TestCanaryHealthyLeavesTheFailureCounted(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer ok.Close()
	// Any HTTP answer means the network works, even an error status.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer bad.Close()

	r := failed()
	NewCanary([]string{ok.URL, bad.URL}).Judge(&r)
	if r.Inconclusive {
		t.Fatalf("a failure with healthy canaries was marked inconclusive: %+v", r)
	}
}

// This worker could not reach the internet either: not the site's downtime.
func TestCanaryUnreachableMarksTheFailureInconclusive(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer ok.Close()
	dead := deadURL(t)

	r := failed()
	NewCanary([]string{ok.URL, dead}).Judge(&r)
	if !r.Inconclusive {
		t.Fatal("a failure while a canary was unreachable should be inconclusive")
	}
	if !strings.Contains(r.Error, "context deadline exceeded") || !strings.Contains(r.Error, "not counted") ||
		!strings.Contains(r.Error, hostOf(dead)) {
		t.Fatalf("the error should keep the original reason and name the canary: %q", r.Error)
	}
}

func TestCanaryLeavesUpAndBlockedAlone(t *testing.T) {
	c := NewCanary([]string{deadURL(t)})
	for _, r := range []models.CheckResult{{Up: true}, {Blocked: true, Error: "rate-limited (status 429)"}} {
		before := r
		c.Judge(&r)
		if r != before {
			t.Fatalf("Judge changed a result it must not touch: %+v -> %+v", before, r)
		}
	}
}

// A zone-wide drop fails every check at once; one probe round answers them all.
func TestCanaryVerdictIsReusedWithinItsTTL(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := NewCanary([]string{srv.URL})
	clock := time.Unix(1_000_000, 0)
	c.now = func() time.Time { return clock }
	for i := 0; i < 5; i++ {
		c.Healthy()
	}
	if hits.Load() != 1 {
		t.Fatalf("5 calls within the TTL probed %d times, want 1", hits.Load())
	}
	clock = clock.Add(canaryTTL + time.Second)
	c.Healthy()
	if hits.Load() != 2 {
		t.Fatalf("after the TTL it should probe again, probed %d times", hits.Load())
	}
}

func TestParseCanaryURLs(t *testing.T) {
	if got := ParseCanaryURLs(""); len(got) != len(DefaultCanaryURLs) {
		t.Fatalf("unset should mean the defaults, got %v", got)
	}
	if got := ParseCanaryURLs("off"); got != nil {
		t.Fatalf("off should mean none, got %v", got)
	}
	if got := ParseCanaryURLs(" http://a/x , http://b/y ,"); len(got) != 2 || got[0] != "http://a/x" || got[1] != "http://b/y" {
		t.Fatalf("got %v", got)
	}
	r := failed()
	NewCanary(nil).Judge(&r)
	if r.Inconclusive {
		t.Fatal("with no canaries every failure counts")
	}
}
