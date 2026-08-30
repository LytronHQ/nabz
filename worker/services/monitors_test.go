package services

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"monitors/corelib/models"
	"net/url"
	"strings"
	"unicode/utf8"
)

func TestCertExpiry(t *testing.T) {
	want := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	res := &http.Response{TLS: &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{NotAfter: want}}}}
	if got := certExpiry(res); !got.Equal(want) {
		t.Fatalf("expected cert expiry %v, got %v", want, got)
	}

	// Plain HTTP (no TLS) and a nil response yield the zero time.
	if got := certExpiry(&http.Response{}); !got.IsZero() {
		t.Fatalf("expected zero time for a non-TLS response, got %v", got)
	}
	if got := certExpiry(nil); !got.IsZero() {
		t.Fatalf("expected zero time for a nil response, got %v", got)
	}
}

func TestRunCheckUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	result := RunCheck(models.Monitor{Type: "website", Target: srv.URL})

	if !result.Up {
		t.Fatalf("expected up=true, got %+v", result)
	}
	if result.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", result.StatusCode)
	}
	if result.Error != "" {
		t.Fatalf("expected no error, got %q", result.Error)
	}
	if result.ResponseMs < 0 {
		t.Fatalf("expected non-negative response_ms, got %d", result.ResponseMs)
	}
}

func TestRunCheckDownOn5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	result := RunCheck(models.Monitor{Type: "website", Target: srv.URL})

	if result.Up {
		t.Fatalf("expected up=false for 500, got %+v", result)
	}
	if result.StatusCode != 500 {
		t.Fatalf("expected status 500, got %d", result.StatusCode)
	}
	if result.Error == "" {
		t.Fatalf("expected an error message for a down check")
	}
}

func TestRunCheckErrorOnUnreachable(t *testing.T) {
	// Spin up a server then close it, giving a guaranteed-closed local address
	// (connection refused immediately, no timeout wait).
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	target := srv.URL
	srv.Close()

	result := RunCheck(models.Monitor{Type: "website", Target: target})

	if result.Up {
		t.Fatalf("expected up=false for unreachable target, got %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected an error message for unreachable target")
	}
}

func TestRunCheckRateLimited429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	result := RunCheck(models.Monitor{Type: "website", Target: srv.URL})

	if result.Up {
		t.Fatalf("429 must not be up, got %+v", result)
	}
	if !result.Blocked {
		t.Fatalf("429 must be marked Blocked, got %+v", result)
	}
	if result.StatusCode != 429 {
		t.Fatalf("expected status 429, got %d", result.StatusCode)
	}
	if result.RetryAfterSecs != 30 {
		t.Fatalf("expected Retry-After 30s, got %d", result.RetryAfterSecs)
	}
	if result.Error == "" {
		t.Fatalf("expected a rate-limited error message")
	}
}

func TestRunCheckBlocked403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	result := RunCheck(models.Monitor{Type: "website", Target: srv.URL})

	if result.Up {
		t.Fatalf("403 must not be up, got %+v", result)
	}
	if !result.Blocked {
		t.Fatalf("403 must be marked Blocked, got %+v", result)
	}
	if result.RetryAfterSecs != 0 {
		t.Fatalf("no Retry-After header => 0, got %d", result.RetryAfterSecs)
	}
}

func TestRunCheckSendsIdentifiableUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	RunCheck(models.Monitor{Type: "website", Target: srv.URL})

	if gotUA != userAgent {
		t.Fatalf("expected User-Agent %q, got %q", userAgent, gotUA)
	}
}

func TestRunCheckTCPPortUp(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to open a local listener: %s", err)
	}
	defer ln.Close()

	result := RunCheck(models.Monitor{Type: "port", Target: ln.Addr().String()})

	if !result.Up {
		t.Fatalf("expected up=true for an open port, got %+v", result)
	}
	if result.ConnectMs < 0 {
		t.Fatalf("expected non-negative connect_ms, got %d", result.ConnectMs)
	}
	if result.Error != "" {
		t.Fatalf("expected no error for an open port, got %q", result.Error)
	}
}

func TestRunCheckTCPPortDownOnRefused(t *testing.T) {
	// Open then immediately close a listener to get a guaranteed-closed local
	// address (connection refused, no timeout wait).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to open a local listener: %s", err)
	}
	target := ln.Addr().String()
	ln.Close()

	result := RunCheck(models.Monitor{Type: "port", Target: target})

	if result.Up {
		t.Fatalf("expected up=false for a closed port, got %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected an error message for a refused connection")
	}
}

func TestRunCheckTCPPortInvalidTarget(t *testing.T) {
	// A bare host with no port can't be dialed — report a clear error, not down-forever.
	result := RunCheck(models.Monitor{Type: "port", Target: "example.com"})

	if result.Up {
		t.Fatalf("expected up=false for a target missing the port, got %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected an error message for an invalid target")
	}
}

func TestAssertBody(t *testing.T) {
	cases := []struct {
		name, body, keyword, mode string
		want                      bool
	}{
		{"contains present", "hello world", "world", "contains", true},
		{"contains missing", "hello world", "bye", "contains", false},
		{"absent while missing", "hello world", "error", "absent", true},
		{"absent while present", "an error page", "error", "absent", false},
		{"empty keyword is a no-op", "anything", "", "contains", true},
		{"unknown mode is a no-op", "x", "x", "weird", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := assertBody(c.body, c.keyword, c.mode); got != c.want {
				t.Fatalf("assertBody(%q,%q,%q) = %v, want %v", c.body, c.keyword, c.mode, got, c.want)
			}
		})
	}
}

func TestRunCheckBodyAssertion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<h1>Something went wrong</h1>"))
	}))
	defer srv.Close()

	// "contains Welcome" is unmet on a 200 body -> down.
	miss := RunCheck(models.Monitor{Type: "website", Target: srv.URL,
		Config: models.MonitorConfig{Keyword: "Welcome", KeywordMode: "contains"}})
	if miss.Up {
		t.Fatalf("expected down when keyword missing on a 2xx, got %+v", miss)
	}
	if miss.StatusCode != 200 {
		t.Fatalf("expected the 200 status still recorded, got %d", miss.StatusCode)
	}
	if miss.Error == "" {
		t.Fatalf("expected a body-assertion error message")
	}

	// "contains wrong" is met -> up.
	hit := RunCheck(models.Monitor{Type: "website", Target: srv.URL,
		Config: models.MonitorConfig{Keyword: "wrong", KeywordMode: "contains"}})
	if !hit.Up {
		t.Fatalf("expected up when keyword present, got %+v", hit)
	}
}

func TestRunCheckExpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot) // 418
	}))
	defer srv.Close()

	// Default rule (200–399): 418 is down.
	if RunCheck(models.Monitor{Type: "website", Target: srv.URL}).Up {
		t.Fatalf("expected 418 to be down under the default rule")
	}
	// Explicit expected status: 418 is up.
	exp := RunCheck(models.Monitor{Type: "website", Target: srv.URL,
		Config: models.MonitorConfig{ExpectedStatus: 418}})
	if !exp.Up {
		t.Fatalf("expected up when the status matches ExpectedStatus, got %+v", exp)
	}
}

func TestRunCheckMethodAndHeaders(t *testing.T) {
	var gotMethod, gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHeader = r.Header.Get("X-Api-Key")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	RunCheck(models.Monitor{Type: "website", Target: srv.URL,
		Config: models.MonitorConfig{Method: "HEAD", Headers: map[string]string{"X-Api-Key": "secret"}}})

	if gotMethod != "HEAD" {
		t.Fatalf("expected method HEAD, got %q", gotMethod)
	}
	if gotHeader != "secret" {
		t.Fatalf("expected custom header to be sent, got %q", gotHeader)
	}
}

func TestRunCheckFollowRedirects(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("FINAL PAGE"))
	}))
	defer final.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound) // 302
	}))
	defer redir.Close()

	// Default: follow to the final page; the body assertion sees "FINAL PAGE" -> up.
	foll := RunCheck(models.Monitor{Type: "website", Target: redir.URL,
		Config: models.MonitorConfig{Keyword: "FINAL PAGE", KeywordMode: "contains"}})
	if !foll.Up {
		t.Fatalf("expected up when following to the final page, got %+v", foll)
	}
	if foll.StatusCode != 200 {
		t.Fatalf("expected the final 200 recorded, got %d", foll.StatusCode)
	}
	if foll.RedirectCount != 1 {
		t.Fatalf("expected 1 redirect followed, got %d", foll.RedirectCount)
	}
	if foll.FinalURL != final.URL {
		t.Fatalf("expected final URL %q, got %q", final.URL, foll.FinalURL)
	}

	// Opt out: evaluate the 302 as-is; the assertion runs on the stub -> down.
	no := false
	nof := RunCheck(models.Monitor{Type: "website", Target: redir.URL,
		Config: models.MonitorConfig{Keyword: "FINAL PAGE", KeywordMode: "contains", FollowRedirects: &no}})
	if nof.Up {
		t.Fatalf("expected down asserting on the redirect stub, got %+v", nof)
	}
	if nof.StatusCode != 302 {
		t.Fatalf("expected the 302 recorded when not following, got %d", nof.StatusCode)
	}
	if nof.RedirectCount != 0 {
		t.Fatalf("opt-out should record no followed redirects, got %d", nof.RedirectCount)
	}
}

// A multi-hop chain (301 -> 302 -> 200) records the hop count and the final URL (#112).
func TestRunCheckRedirectChainCount(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer final.Close()
	hop2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound) // 302
	}))
	defer hop2.Close()
	hop1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, hop2.URL, http.StatusMovedPermanently) // 301
	}))
	defer hop1.Close()

	res := RunCheck(models.Monitor{Type: "website", Target: hop1.URL})
	if res.StatusCode != 200 {
		t.Fatalf("expected final 200, got %d", res.StatusCode)
	}
	if res.RedirectCount != 2 {
		t.Fatalf("expected 2 redirects followed (301 -> 302 -> 200), got %d", res.RedirectCount)
	}
	if res.FinalURL != final.URL {
		t.Fatalf("expected final URL %q, got %q", final.URL, res.FinalURL)
	}
}

func TestEnsurePort(t *testing.T) {
	if got := ensurePort("example.com", "443"); got != "example.com:443" {
		t.Fatalf("bare host should get the default port, got %q", got)
	}
	if got := ensurePort("example.com:22", "443"); got != "example.com:22" {
		t.Fatalf("an explicit port must be preserved, got %q", got)
	}
}

func TestRunCheckPing(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to open a local listener: %s", err)
	}
	defer ln.Close()

	// A ping (TCP reachability) to an open host:port is up, reusing the engine.
	result := RunCheck(models.Monitor{Type: "ping", Target: ln.Addr().String()})
	if !result.Up {
		t.Fatalf("expected ping up to an open port, got %+v", result)
	}
	if result.ConnectMs < 0 {
		t.Fatalf("expected non-negative connect_ms, got %d", result.ConnectMs)
	}
}

func TestRunCheckUnsupportedType(t *testing.T) {
	result := RunCheck(models.Monitor{Type: "heartbeat", Target: "example.com"})

	if result.Up {
		t.Fatalf("expected up=false for unsupported type, got %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected an error message for unsupported type")
	}
}

func TestRunCheckDefaultsToHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Empty type should be treated as an HTTP/website check.
	result := RunCheck(models.Monitor{Type: "", Target: srv.URL})
	if !result.Up {
		t.Fatalf("expected up=true for empty type defaulting to HTTP, got %+v", result)
	}
}

func TestSanitizeFinalURLDropsQueryAndFragment(t *testing.T) {
	// The real shape from the dev data: a Cloudflare Access JWT in the query,
	// 1,327 bytes of it, unique per request and identical in meaning.
	raw := "https://app.example.com/dash?kid=abc123&meta=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9#frag"
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	got := sanitizeFinalURL(u)
	want := "https://app.example.com/dash"
	if got != want {
		t.Fatalf("sanitizeFinalURL(%q) = %q, want %q", raw, got, want)
	}
	if strings.Contains(got, "eyJ") || strings.Contains(got, "?") || strings.Contains(got, "#") {
		t.Fatalf("token or query survived sanitising: %q", got)
	}
}

func TestSanitizeFinalURLKeepsOrdinaryURLsIntact(t *testing.T) {
	for _, raw := range []string{
		"https://example.com/",
		"https://example.com/a/b/c",
		"http://example.com:8080/path",
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := sanitizeFinalURL(u); got != raw {
			t.Errorf("sanitizeFinalURL(%q) = %q, want it unchanged", raw, got)
		}
	}
}

func TestSanitizeFinalURLCapsWithAMarker(t *testing.T) {
	u, err := url.Parse("https://example.com/" + strings.Repeat("p", 400))
	if err != nil {
		t.Fatal(err)
	}
	got := sanitizeFinalURL(u)
	if len(got) > maxFinalURLBytes {
		t.Fatalf("len = %d, want <= %d", len(got), maxFinalURLBytes)
	}
	// Without the marker a truncated URL reads as a real one.
	if !strings.HasSuffix(got, finalURLTruncated) {
		t.Fatalf("truncated value must be marked, got %q", got)
	}
}

func TestSanitizeFinalURLDoesNotSplitARune(t *testing.T) {
	// A multi-byte path that lands the cap mid-rune must still be valid UTF-8,
	// or PocketBase stores a mojibake tail.
	u, err := url.Parse("https://example.com/" + strings.Repeat("é", 300))
	if err != nil {
		t.Fatal(err)
	}
	got := sanitizeFinalURL(u)
	if len(got) > maxFinalURLBytes {
		t.Fatalf("len = %d, want <= %d", len(got), maxFinalURLBytes)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("truncation split a rune: %q", got)
	}
}

func TestSanitizeFinalURLNilIsEmpty(t *testing.T) {
	if got := sanitizeFinalURL(nil); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}
