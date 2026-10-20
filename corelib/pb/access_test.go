package pb

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccessHeaders(t *testing.T) {
	h := accessHeaders("id-123", "secret-456")
	if h["CF-Access-Client-Id"] != "id-123" || h["CF-Access-Client-Secret"] != "secret-456" {
		t.Fatalf("accessHeaders = %v", h)
	}
	// Half a service token is a misconfiguration that would 403 every request.
	// Treat it as absent rather than sending something that cannot work.
	for _, c := range [][2]string{{"", ""}, {"id", ""}, {"", "secret"}} {
		if got := accessHeaders(c[0], c[1]); got != nil {
			t.Errorf("accessHeaders(%q,%q) = %v, want nil", c[0], c[1], got)
		}
	}
}

// A node behind Access must send the pair on EVERY request, the auth call
// included — Cloudflare answers 403 before PocketBase sees anything, so an
// unauthenticated login attempt never even reaches the auth endpoint.
func TestClientSendsAccessHeadersOnAuthAndRequests(t *testing.T) {
	var authHeaders, callHeaders http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth-with-password") {
			authHeaders = r.Header.Clone()
			w.Write([]byte(`{"token":"tok"}`))
			return
		}
		callHeaders = r.Header.Clone()
		w.Write([]byte(`{"items":[]}`))
	}))
	defer srv.Close()

	config := pbConfig(srv.URL)
	config.PB.Admin.Collection = "service_accounts"
	config.PB.Admin.Username = "worker@svc.local"
	config.PB.Admin.Password = "pw"
	config.PB.Access.ClientId = "cf-id"
	config.PB.Access.ClientSecret = "cf-secret"

	c, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %s", err)
	}
	if err := c.Ping(); err != nil {
		t.Fatalf("Ping: %s", err)
	}

	for label, h := range map[string]http.Header{"auth": authHeaders, "request": callHeaders} {
		if h.Get("CF-Access-Client-Id") != "cf-id" || h.Get("CF-Access-Client-Secret") != "cf-secret" {
			t.Errorf("%s request did not carry the Access pair: %v", label, h)
		}
	}
}

// A node on the private network must send nothing extra: an empty header would
// still be a header, and Access is not in its path at all.
func TestClientOmitsAccessHeadersWhenUnconfigured(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		if strings.Contains(r.URL.Path, "auth-with-password") {
			w.Write([]byte(`{"token":"tok"}`))
			return
		}
		w.Write([]byte(`{"items":[]}`))
	}))
	defer srv.Close()

	config := pbConfig(srv.URL)
	config.PB.Admin.Collection = "service_accounts"
	config.PB.Admin.Username = "worker@svc.local"
	config.PB.Admin.Password = "pw"

	c, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %s", err)
	}
	if err := c.Ping(); err != nil {
		t.Fatalf("Ping: %s", err)
	}
	if _, ok := seen["Cf-Access-Client-Id"]; ok {
		t.Errorf("an unconfigured node sent an Access header: %v", seen)
	}
	if _, ok := seen["Cf-Access-Client-Secret"]; ok {
		t.Errorf("an unconfigured node sent an Access secret header: %v", seen)
	}
}
