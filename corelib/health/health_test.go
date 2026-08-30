package health

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testToken = "s3cr3t-debug-token"

// hit runs one request against a Server's handler and returns the recorder.
func hit(t *testing.T, s *Server, path, auth string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body is not JSON: %v — %q", err, rec.Body.String())
	}
	return m
}

func okDep(name string) Dependency { return Dependency{Name: name, Check: func() error { return nil }} }
func downDep(name string, err error) Dependency {
	return Dependency{Name: name, Check: func() error { return err }}
}

func TestPublicNodeBody_HidesEverythingButStatus(t *testing.T) {
	s := &Server{Name: "worker-eu", Token: testToken, Deps: []Dependency{okDep("valkey"), okDep("pocketbase")}}

	rec := hit(t, s, "/health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("healthy node: want 200, got %d", rec.Code)
	}
	m := decode(t, rec)
	if m["status"] != "ok" {
		t.Errorf("want status ok, got %v", m["status"])
	}
	// A per-node public body reveals only status — no node name, no dep list.
	for _, leak := range []string{"node", "items", "dependencies", "unhealthy", "valkey", "pocketbase"} {
		if _, ok := m[leak]; ok {
			t.Errorf("public node body leaked field %q: %v", leak, m)
		}
	}
}

func TestDegradedReturns503(t *testing.T) {
	s := &Server{Name: "worker-eu", Deps: []Dependency{okDep("pocketbase"), downDep("valkey", errors.New("boom"))}}
	rec := hit(t, s, "/health", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("degraded node: want 503, got %d", rec.Code)
	}
	if decode(t, rec)["status"] != "degraded" {
		t.Errorf("want status degraded")
	}
}

// The central scrubbing guarantee: a raw driver error carrying an address and
// credentials must never surface — only the generic "unreachable" label.
func TestScrubbing_RawErrorNeverLeaks(t *testing.T) {
	raw := errors.New("dial tcp 10.1.2.3:6379: connect: connection refused (auth: user=admin password=hunter2, redis://admin:hunter2@valkey.internal:6379)")
	s := &Server{Name: "worker-eu", Token: testToken, Deps: []Dependency{downDep("valkey", raw)}}

	// Even on the DEBUG tier (most detail), nothing sensitive appears.
	rec := hit(t, s, "/health", "Bearer "+testToken)
	body := rec.Body.String()
	for _, secret := range []string{"10.1.2.3", "6379", "hunter2", "admin", "redis://", "valkey.internal", "connection refused", "dial tcp"} {
		if strings.Contains(body, secret) {
			t.Errorf("debug body leaked sensitive substring %q\nbody: %s", secret, body)
		}
	}
	// It still says WHAT is wrong: the generic label + generic cause.
	if !strings.Contains(body, "unreachable") {
		t.Errorf("debug body should carry the generic label, got: %s", body)
	}
}

func TestDebugTier_TokenGating(t *testing.T) {
	s := &Server{Name: "worker-eu", Token: testToken, Deps: []Dependency{downDep("valkey", errors.New("x"))}}

	cases := []struct {
		name       string
		auth       string
		wantDetail bool
	}{
		{"no header", "", false},
		{"wrong scheme", "Basic " + testToken, false},
		{"wrong token", "Bearer not-the-token", false},
		{"prefix of token", "Bearer " + testToken[:5], false},
		{"token plus extra", "Bearer " + testToken + "x", false},
		{"correct token", "Bearer " + testToken, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := decode(t, hit(t, s, "/health", c.auth))
			_, hasItems := m["items"]
			if hasItems != c.wantDetail {
				t.Errorf("auth %q: detail=%v, want %v (body %v)", c.auth, hasItems, c.wantDetail, m)
			}
			// A rejected token must fall back to the exact public body, never a 401
			// or a partial leak.
			if !c.wantDetail {
				if _, leaked := m["node"]; leaked {
					t.Errorf("rejected token leaked node name: %v", m)
				}
			}
		})
	}
}

func TestDebugTier_DisabledWhenTokenBlank(t *testing.T) {
	// No token configured ⇒ a valid-looking bearer still gets only the public body.
	s := &Server{Name: "worker-eu", Deps: []Dependency{okDep("pocketbase")}}
	m := decode(t, hit(t, s, "/health", "Bearer anything"))
	if _, ok := m["items"]; ok {
		t.Errorf("blank token must never serve detail: %v", m)
	}
}

func TestDebugBody_CarriesLabelCauseAndStaleness(t *testing.T) {
	agg := func() Report {
		return Report{
			Node: "evaluator",
			Items: []Item{
				{Name: "worker-eu", Label: LabelStale, StaleFor: 4*time.Minute + 2*time.Second},
				{Name: "worker-us", Label: LabelOK},
			},
		}
	}
	s := &Server{Name: "evaluator", Token: testToken, Aggregate: agg}

	rec := hit(t, s, "/health/all", "Bearer "+testToken)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale zone should be degraded (503), got %d", rec.Code)
	}
	var resp detailResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Node != "evaluator" || resp.Status != StatusDegraded {
		t.Errorf("unexpected header: %+v", resp)
	}
	var stale *detailItem
	for i := range resp.Items {
		if resp.Items[i].Name == "worker-eu" {
			stale = &resp.Items[i]
		}
	}
	if stale == nil {
		t.Fatal("missing worker-eu item")
	}
	if stale.Status != LabelStale {
		t.Errorf("want stale label, got %q", stale.Status)
	}
	if stale.StaleFor != "4m2s" {
		t.Errorf("want stale_for 4m2s, got %q", stale.StaleFor)
	}
	if stale.Cause == "" {
		t.Errorf("stale item should carry a generic cause")
	}
}

func TestAggregatorPublic_NamesUnhealthyOnly(t *testing.T) {
	agg := func() Report {
		return Report{Items: []Item{
			{Name: "worker-eu", Label: LabelStale, StaleFor: time.Minute},
			{Name: "worker-us", Label: LabelOK},
		}}
	}
	s := &Server{Name: "evaluator", Token: testToken, Aggregate: agg}

	m := decode(t, hit(t, s, "/health/all", ""))
	if m["status"] != "degraded" {
		t.Errorf("want degraded, got %v", m["status"])
	}
	un, ok := m["unhealthy"].([]any)
	if !ok || len(un) != 1 || un[0] != "worker-eu" {
		t.Errorf("aggregator public body should name only the unhealthy node, got %v", m["unhealthy"])
	}
	// Public tier must not carry per-item labels/causes/staleness.
	for _, leak := range []string{"items", "cause", "stale_for"} {
		if _, bad := m[leak]; bad {
			t.Errorf("public aggregate body leaked %q: %v", leak, m)
		}
	}
}

func TestAllHealthy_Public200AndNoUnhealthyKey(t *testing.T) {
	agg := func() Report {
		return Report{Items: []Item{{Name: "worker-eu", Label: LabelOK}}}
	}
	s := &Server{Name: "evaluator", Aggregate: agg}
	rec := hit(t, s, "/health/all", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("all healthy: want 200, got %d", rec.Code)
	}
	m := decode(t, rec)
	if m["status"] != "ok" {
		t.Errorf("want ok, got %v", m["status"])
	}
	if _, ok := m["unhealthy"]; ok {
		t.Errorf("healthy aggregate should omit unhealthy: %v", m)
	}
}

func TestBuildInfo_DebugOnlyAndOmittedWhenUnset(t *testing.T) {
	s := &Server{Name: "worker-eu", Token: testToken, Deps: []Dependency{okDep("pocketbase")}}

	// Unset build metadata ⇒ no "build" key on either tier.
	if _, ok := decode(t, hit(t, s, "/health", "Bearer "+testToken))["build"]; ok {
		t.Errorf("build should be omitted when Version/Commit are empty")
	}

	// Inject build metadata (as -ldflags would) and restore afterward.
	origV, origC := Version, Commit
	Version, Commit = "9.9.9", "abc1234"
	defer func() { Version, Commit = origV, origC }()

	// Public tier never carries it.
	if _, ok := decode(t, hit(t, s, "/health", ""))["build"]; ok {
		t.Errorf("public body must not expose build metadata")
	}

	// Debug tier reports version + commit.
	var resp detailResp
	if err := json.Unmarshal(hit(t, s, "/health", "Bearer "+testToken).Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Build == nil || resp.Build.Version != "9.9.9" || resp.Build.Commit != "abc1234" {
		t.Errorf("debug build info = %+v, want version 9.9.9 commit abc1234", resp.Build)
	}
	if BuildString() != "v9.9.9 (abc1234)" {
		t.Errorf("BuildString() = %q", BuildString())
	}
}

func TestNoAggregate_NoAllRoute(t *testing.T) {
	// A worker (no Aggregate) must not expose /health/all at all.
	s := &Server{Name: "worker-eu", Deps: []Dependency{okDep("valkey")}}
	rec := hit(t, s, "/health/all", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("worker should not serve /health/all, got %d", rec.Code)
	}
}
