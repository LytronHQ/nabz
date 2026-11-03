package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"time"

	"monitors/corelib/utils"
)

// pingInterval bounds how often the evaluator pings its dead-man's-switch URL.
// The main loop turns every 10s; a heartbeat with a 5-minute period
// needs nothing like that, and each ping is an outbound request from the central
// node.
const pingInterval = 60 * time.Second

// pingTimeout keeps a hung endpoint from stalling the loop. The ping is
// best-effort telemetry — it must never be able to delay evaluation.
const pingTimeout = 5 * time.Second

// healthPinger reports "the evaluator completed a pass" to an external
// dead-man's switch (a Better Stack heartbeat, or any ping-on-success URL). It is the primary liveness
// path: nabz's own dead-man's switch runs inside the evaluator, so it cannot
// report the evaluator's own death.
//
// A nil *healthPinger is the disabled state and every method is safe on it —
// with HEALTHCHECK_PING_URL unset nothing is constructed and nothing is sent.
type healthPinger struct {
	url    string
	client *http.Client
	every  time.Duration
	last   time.Time
}

// newHealthPinger returns nil when no URL is configured, so the feature is off
// by default with no branch in the caller.
func newHealthPinger(url string) *healthPinger {
	if url == "" {
		return nil
	}
	return &healthPinger{
		url:    url,
		client: &http.Client{Timeout: pingTimeout},
		every:  pingInterval,
	}
}

// ping fires at most once per interval. Fire-and-forget: a failure is logged and
// dropped, because a missed ping is exactly what the external check is watching
// for — retrying here would mask the signal it exists to raise.
func (p *healthPinger) ping(now time.Time) {
	if p == nil {
		return
	}
	if !p.last.IsZero() && now.Sub(p.last) < p.every {
		return
	}
	p.last = now

	ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
	defer cancel()
	// Never log the URL: its last segment is Better Stack's secret for this
	// heartbeat, and Go's url.Error quotes the whole URL. Every timeout put it in
	// the container log (#656).
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		log.Printf("Healthcheck ping: HEALTHCHECK_PING_URL does not parse: %s", withoutURL(err))
		return
	}
	res, err := p.client.Do(req)
	if err != nil {
		log.Printf("Healthcheck ping: failed: %s", withoutURL(err))
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		log.Printf("Healthcheck ping: endpoint returned %d", res.StatusCode)
	}
}

// healthPingURL reads the configured endpoint. Unset = feature off.
func healthPingURL() string { return utils.GetEnv("HEALTHCHECK_PING_URL", "") }

// withoutURL drops the URL that net/url and net/http put in their errors, keeping
// the cause ("context deadline exceeded", "connection refused", "invalid URL
// escape").
func withoutURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
