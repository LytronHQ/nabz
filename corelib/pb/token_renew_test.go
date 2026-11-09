package pb

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func tokenWithExp(t *testing.T, exp time.Time, serial int64) string {
	t.Helper()
	payload, err := json.Marshal(map[string]int64{"exp": exp.Unix(), "serial": serial})
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"HS256"}`)) + "." + enc(payload) + ".sig"
}

func tokenExp(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return time.Time{}
	}
	return time.Unix(claims.Exp, 0)
}

// fakeExpiringPB behaves as production's PocketBase did in #711: an expired token
// is not refused, it is treated as no token at all, so a list answers 200 with no
// items and a 401 never comes.
func fakeExpiringPB(t *testing.T, life time.Duration, authFails *atomic.Bool, auths *atomic.Int64) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth-with-password") {
			n := auths.Add(1)
			if authFails.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			fmt.Fprintf(w, `{"token":%q}`, tokenWithExp(t, time.Now().Add(life), n))
			return
		}
		if time.Now().Before(tokenExp(r.Header.Get("Authorization"))) {
			w.Write([]byte(`{"items":[{"id":"visible"}]}`))
			return
		}
		w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)

	config := pbConfig(srv.URL)
	config.PB.Admin.Collection = "service_accounts"
	config.PB.Admin.Username = "worker@svc.local"
	config.PB.Admin.Password = "pw"
	c, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %s", err)
	}
	return c
}

func sees(t *testing.T, c *Client) bool {
	t.Helper()
	res, err := c.request("GET", "/api/collections/monitors/records", nil)
	if err != nil {
		t.Fatalf("request: %s", err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("status %d: %s", res.StatusCode, res.Body)
	}
	return strings.Contains(string(res.Body), "visible")
}

func TestClientKeepsItsIdentityPastTokenExpiry(t *testing.T) {
	var failing atomic.Bool
	var auths atomic.Int64
	c := fakeExpiringPB(t, 2*time.Second, &failing, &auths)

	if !sees(t, c) {
		t.Fatal("a fresh token should see records")
	}
	time.Sleep(3 * time.Second)
	if !sees(t, c) {
		t.Fatalf("after the token's expiry the client went anonymous (logins: %d): this is the #711 outage", auths.Load())
	}
	if got := auths.Load(); got != 2 {
		t.Fatalf("logins = %d, want 2 (start + one renewal)", got)
	}
}

// PocketBase being briefly unavailable at renewal time must not cost the client
// a token that still has life in it, and the renewal must be tried again.
func TestClientSurvivesAFailedRenewalAndRetries(t *testing.T) {
	saved := renewRetryDelay
	renewRetryDelay = 0
	t.Cleanup(func() { renewRetryDelay = saved })

	var failing atomic.Bool
	var auths atomic.Int64
	c := fakeExpiringPB(t, 4*time.Second, &failing, &auths)

	time.Sleep(2500 * time.Millisecond) // past halfway, still valid
	failing.Store(true)
	if !sees(t, c) {
		t.Fatal("a failed renewal must keep the still-valid token")
	}
	if got := auths.Load(); got != 2 {
		t.Fatalf("logins = %d, want 2 (start + the failed renewal)", got)
	}

	failing.Store(false)
	time.Sleep(2500 * time.Millisecond) // the first token has now expired
	if !sees(t, c) {
		t.Fatal("the retry should have renewed the token")
	}
	if got := auths.Load(); got != 3 {
		t.Fatalf("logins = %d, want 3 (start + failed + retry)", got)
	}
}

func TestTokenRenewAt(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cases := []struct {
		name  string
		token string
		want  time.Time
	}{
		{"halfway through a 5 day token", tokenWithExp(t, now.Add(120*time.Hour), 1), now.Add(60 * time.Hour)},
		{"no exp claim", "tok", now.Add(renewWithoutExpiry)},
		{"already expired", tokenWithExp(t, now.Add(-time.Hour), 1), now.Add(renewRetryDelay)},
	}
	for _, tc := range cases {
		if got := tokenRenewAt(tc.token, now); !got.Equal(tc.want) {
			t.Errorf("%s: renew at %v, want %v", tc.name, got, tc.want)
		}
	}
}
