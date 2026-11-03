package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"monitors/corelib/netguard"
	"monitors/corelib/utils"
)

// Limits on sending to addresses users choose (#670). The evaluator is one
// serial loop serving every tenant: a destination that accepts a connection and
// never answers used to hold it for about two minutes per channel (30 s x 4
// attempts), and nothing capped how many channels or test alerts one user could
// line up, so one account could stop alerting for everyone.
const (
	// deliveryTimeout bounds one attempt, response read included. One attempt
	// only: a retry against an address the user picked is the user's cost, not
	// every other tenant's.
	deliveryTimeout = 10 * time.Second
	// dispatchDeadline bounds one alert across all of its channels.
	dispatchDeadline = 15 * time.Second
	// deliveryConcurrency is how many channels of one alert are sent at once.
	deliveryConcurrency = 16
	// maxDeliveryBody caps what is read back: only a status and a short reason
	// are ever used, and an unbounded read let a destination fill memory.
	maxDeliveryBody = 64 << 10
)

// deliveryClient sends alerts to the addresses users configure: webhooks, chat
// providers, push services. The evaluator sits on the private network next to
// PocketBase, so these requests must not reach private addresses (#669). The
// check runs on every dial, after DNS, so a redirect into the private network is
// refused too. Proxy is off so the check sees the real destination. PocketBase
// calls keep corelib's own client, which has to reach the private address.
var deliveryClient = &http.Client{
	Timeout: deliveryTimeout,
	Transport: &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, Control: netguard.Control}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		ForceAttemptHTTP2:   true,
	},
	CheckRedirect: func(_ *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

// deliverPOST sends one alert body to a user-chosen address: one attempt, at
// most deliveryTimeout, at most maxDeliveryBody read back.
func deliverPOST(url string, body []byte) (utils.HTTPResult, error) {
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return utils.HTTPResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := deliveryClient.Do(req)
	if err != nil {
		return utils.HTTPResult{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxDeliveryBody))
	if err != nil {
		return utils.HTTPResult{}, err
	}
	return utils.HTTPResult{Body: b, StatusCode: res.StatusCode}, nil
}

// errDispatchDeadline marks a channel that did not finish within dispatchDeadline.
var errDispatchDeadline = errors.New("not delivered within the alert time limit")

// runBounded runs deliver for each index in parallel (at most
// deliveryConcurrency at once) and returns the results once all have finished or
// the deadline passes, whichever is first. An entry that had not finished gets
// timedOut(i). A send still running at the deadline ends on its own, within its
// own timeout; its late result is dropped, so the caller never races with it.
func runBounded(n int, deadline time.Duration, deliver func(i int) deliveryResult, timedOut func(i int) deliveryResult) []deliveryResult {
	results := make([]deliveryResult, n)
	have := make([]bool, n)
	closed := false
	var mu sync.Mutex
	sem := make(chan struct{}, deliveryConcurrency)
	expired := make(chan struct{})
	timer := time.AfterFunc(deadline, func() { close(expired) })
	defer timer.Stop()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-expired:
				return
			}
			defer func() { <-sem }()
			select {
			case <-expired:
				return // the slot came free after the deadline: do not start
			default:
			}
			r := deliver(i)
			mu.Lock()
			if !closed {
				results[i], have[i] = r, true
			}
			mu.Unlock()
		}(i)
	}
	all := make(chan struct{})
	go func() { wg.Wait(); close(all) }()
	select {
	case <-all:
	case <-expired:
	}
	mu.Lock()
	defer mu.Unlock()
	closed = true
	for i := range results {
		if !have[i] {
			results[i] = timedOut(i)
		}
	}
	return results
}
