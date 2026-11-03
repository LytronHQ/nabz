package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"monitors/corelib/utils"
)

// webBeatInterval is how often the evaluator drives the check-in path beat. The
// web's staleness window is 5 minutes, so a minute leaves room for four misses.
const webBeatInterval = 60 * time.Second

// webBeatTimeout bounds one beat. The beat runs on its own goroutine, so this
// only keeps a hung edge from piling up requests.
const webBeatTimeout = 15 * time.Second

// webBeater POSTs the web's /internal/liveness beat over the public URL, the way
// a customer's /ping travels: edge -> Worker -> Access -> Tunnel -> PocketBase.
//
// The Worker's own Cron Trigger used to be the only source, and Cloudflare does
// not run it on time: on 2026-10-23 a quarter of the runs started over 2 minutes
// late, one 102 minutes late, with gaps of up to 7 minutes and no run at all
// (#656). Each gap read as a broken check-in path, so /api/health answered 503
// and the evaluator held customers' heartbeat incidents while the path was fine.
// The cron stays as a second source; either one keeps the row fresh, and only a
// path that fails both reads as broken.
//
// A nil *webBeater is the disabled state (no WEB_URL or no HEALTH_DEBUG_TOKEN).
type webBeater struct {
	url    string
	token  string
	origin string
	client *http.Client
}

func newWebBeater(webURL, token string) *webBeater {
	webURL = strings.TrimRight(webURL, "/")
	if webURL == "" || token == "" {
		return nil
	}
	return &webBeater{
		url:    webURL + "/internal/liveness",
		token:  token,
		origin: webURL,
		client: &http.Client{Timeout: webBeatTimeout},
	}
}

// beat sends one beat. The error never carries the token, and names the URL
// without it, since the URL here is public.
func (b *webBeater) beat(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.url, strings.NewReader("{}"))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.token)
	// Without both, SvelteKit answers a POST as a cross-site form: 403 before
	// the route runs (#588).
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", b.origin)
	res, err := b.client.Do(req)
	if err != nil {
		return withoutURL(err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s answered %d", b.url, res.StatusCode)
	}
	return nil
}

// run beats every interval until ctx ends, logging failures and the recovery
// after them once each rather than every minute.
func (b *webBeater) run(ctx context.Context, every time.Duration) {
	if b == nil {
		return
	}
	failing := false
	for {
		bctx, cancel := context.WithTimeout(ctx, webBeatTimeout)
		err := b.beat(bctx)
		cancel()
		switch {
		case err != nil && !failing:
			log.Printf("Web liveness beat: failed: %s", err)
		case err == nil && failing:
			log.Printf("Web liveness beat: recovered")
		}
		failing = err != nil
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

func webBeatConfig() (string, string) {
	return utils.GetEnv("WEB_URL", ""), utils.GetEnv("HEALTH_DEBUG_TOKEN", "")
}
