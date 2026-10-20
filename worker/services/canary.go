package services

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"monitors/corelib/models"
)

// Canary answers "is it us?" for a failed check (#598). A failure seen from one
// zone is the site's downtime there, unless this worker's own network was the
// trouble: on 2026-10-19 the Singapore worker timed out on every site for 11
// minutes while Cloudflare served all of them and Europe saw them up, and that
// lowered every monitor's uptime.
//
// So after a failed check the worker probes a few well-known endpoints on
// independent networks. Any HTTP answer, whatever its status, means this
// worker reached the internet; a connection error or timeout on any of them
// means it could not, and the check is stored as inconclusive.
type Canary struct {
	urls    []string
	client  *http.Client
	ttl     time.Duration
	now     func() time.Time
	mu      sync.Mutex
	at      time.Time
	healthy bool
	reason  string
}

// DefaultCanaryURLs are two independent networks, both answered from their edge.
var DefaultCanaryURLs = []string{
	"https://www.cloudflare.com/cdn-cgi/trace",
	"https://www.google.com/generate_204",
}

const canaryTimeout = 5 * time.Second

// canaryTTL reuses one verdict for a burst of failures: when a zone's network
// drops, every check in it fails at once, and each would otherwise re-probe.
const canaryTTL = 10 * time.Second

// NewCanary probes urls; with none, every failure counts (the old behaviour).
func NewCanary(urls []string) *Canary {
	return &Canary{
		urls:   urls,
		client: &http.Client{Transport: plainHTTPTransport, Timeout: canaryTimeout},
		ttl:    canaryTTL,
		now:    time.Now,
	}
}

// ParseCanaryURLs reads WORKER_CANARY_URLS: unset means the defaults, "off" none.
func ParseCanaryURLs(v string) []string {
	v = strings.TrimSpace(v)
	switch v {
	case "":
		return DefaultCanaryURLs
	case "off":
		return nil
	}
	var out []string
	for _, u := range strings.Split(v, ",") {
		if u = strings.TrimSpace(u); u != "" {
			out = append(out, u)
		}
	}
	return out
}

// Healthy reports whether every canary answered, and if not, which did not.
func (c *Canary) Healthy() (bool, string) {
	if c == nil || len(c.urls) == 0 {
		return true, ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && c.now().Sub(c.at) < c.ttl {
		return c.healthy, c.reason
	}
	var failed []string
	for _, u := range c.urls {
		res, err := c.client.Get(u)
		if err != nil {
			failed = append(failed, hostOf(u))
			continue
		}
		res.Body.Close()
	}
	c.at = c.now()
	c.healthy = len(failed) == 0
	c.reason = strings.Join(failed, ", ")
	return c.healthy, c.reason
}

// Judge marks a failed result inconclusive when this worker's network is suspect.
func (c *Canary) Judge(result *models.CheckResult) {
	if result.Up || result.Blocked {
		return
	}
	if ok, reason := c.Healthy(); !ok {
		result.Inconclusive = true
		result.Error = fmt.Sprintf("%s (not counted: this nabz worker could not reach %s either)", result.Error, reason)
	}
}

func hostOf(u string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexAny(s, "/?"); i >= 0 {
		s = s[:i]
	}
	return s
}
