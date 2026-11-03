package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"monitors/corelib/models"
	"monitors/corelib/netguard"
)

var allowPrivateAtStart bool

// The package's other tests deliver to loopback fixtures, which the guard
// refuses, so they run opted out. Each guard test turns it back on, as the
// production evaluator runs.
func TestMain(m *testing.M) {
	allowPrivateAtStart = netguard.AllowPrivate()
	restore := netguard.SetAllowPrivate(true)
	code := m.Run()
	restore()
	os.Exit(code)
}

// An evaluator started with no setting refuses to deliver a webhook to a
// private address (#669). A child process with an empty environment, so the
// guard's start-up read is what is tested.
func TestDeliveryGuardIsOnWithoutAnySetting(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestDeliveryGuardDefaultHelper$", "-test.v")
	cmd.Env = []string{"DELIVERY_GUARD_HELPER=1"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "hits=0 blocked=true") {
		t.Fatalf("with an empty environment a private webhook must be refused, got:\n%s", out)
	}
}

func TestDeliveryGuardDefaultHelper(t *testing.T) {
	if os.Getenv("DELIVERY_GUARD_HELPER") != "1" {
		t.Skip("run by TestDeliveryGuardIsOnWithoutAnySetting")
	}
	defer netguard.SetAllowPrivate(allowPrivateAtStart)()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++ }))
	defer srv.Close()
	err := sendWebhook(srv.URL, map[string]interface{}{"event": "test"})
	fmt.Printf("hits=%d blocked=%v\n", hits, err != nil && strings.Contains(err.Error(), "blocked target"))
}

// A public address that redirects into the private network is refused at the
// hop. The redirector is loopback too, so the guard is opened for the first dial
// only, by allowing private targets until the redirect is served.
func TestDeliveryRefusesRedirectIntoPrivate(t *testing.T) {
	internalHits := 0
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { internalHits++ }))
	defer internal.Close()
	var once sync.Once
	restoreGuard := func() {}
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Once: a retry can reuse the open connection and call this again, and a
		// second Set would record "off" as the value to restore.
		once.Do(func() { restoreGuard = netguard.SetAllowPrivate(false) })
		http.Redirect(w, r, internal.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	defer func() { restoreGuard() }()
	err := sendWebhook(redirector.URL, map[string]interface{}{"event": "test"})
	if err == nil || !strings.Contains(err.Error(), "blocked target") {
		t.Fatalf("a redirect into a private address must be refused, got %v", err)
	}
	if internalHits != 0 {
		t.Fatalf("the private target was reached %d times", internalHits)
	}
}

// A failing generic webhook reports its status only, never the body of an
// address the user chose (#669).
func TestWebhookFailureDoesNotEchoTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"INTERNAL-ONLY-MARKER"}`)
	}))
	defer srv.Close()
	err := sendWebhook(srv.URL, map[string]interface{}{"event": "test"})
	if err == nil || err.Error() != "webhook returned status 401" {
		t.Fatalf("want status-only error, got %v", err)
	}
}

// Push endpoints go through the same guard.
func TestPushRefusesPrivateEndpoint(t *testing.T) {
	defer netguard.SetAllowPrivate(false)()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++ }))
	defer srv.Close()
	cfg := alertConfig{vapidPublic: "x", vapidPrivate: "y", vapidSubject: "mailto:a@example.test"}
	ch := models.AlertChannel{}
	ch.Config.Endpoint, ch.Config.P256dh, ch.Config.Auth = srv.URL, "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", "tBHItJI5svbpez7KI4CCXg"
	err := sendPush(cfg, ch, "s", "b", map[string]interface{}{})
	if err == nil || hits != 0 {
		t.Fatalf("a private push endpoint must be refused before connecting: err=%v hits=%d", err, hits)
	}
}
