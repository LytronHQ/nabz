package utils

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	httpMaxAttempts = 4
	httpBaseBackoff = 300 * time.Millisecond
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

// HTTPResult is the outcome of an HTTP request: the raw body and the status code.
type HTTPResult struct {
	Body       []byte
	StatusCode int
}

// DoRequest sends an HTTP request with retry + exponential backoff on transport
// (network) errors. It never calls log.Fatal: a transient failure returns an
// error so the caller can decide what to do. HTTP status codes (including 4xx/5xx)
// are returned as-is and are NOT retried here — the caller handles them (e.g. a
// 401 triggers a token refresh in the PocketBase client).
func DoRequest(method, url string, body []byte, token string) (HTTPResult, error) {
	return DoRequestWithHeaders(method, url, body, token, nil)
}

// DoRequestWithHeaders is DoRequest plus extra headers, for a PocketBase that is
// reached through Cloudflare Access: the service-token pair has to be on the
// request or Cloudflare answers 403 before PocketBase ever sees it.
//
// Header VALUES are never logged. A failed request logs the method and URL only,
// which is why the retry logging below stayed as it was.
func DoRequestWithHeaders(method, url string, body []byte, token string, headers map[string]string) (HTTPResult, error) {
	var lastErr error

	for attempt := 0; attempt < httpMaxAttempts; attempt++ {
		if attempt > 0 {
			backoff := httpBaseBackoff * time.Duration(1<<uint(attempt-1))
			time.Sleep(backoff)
		}

		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}

		req, err := http.NewRequest(method, url, reader)
		if err != nil {
			return HTTPResult{}, err
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		for k, v := range headers {
			if v != "" {
				req.Header.Set(k, v)
			}
		}

		res, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			log.Printf("http %s %s failed (attempt %d/%d): %s", method, url, attempt+1, httpMaxAttempts, err)
			continue
		}

		responseBody, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr != nil {
			lastErr = readErr
			log.Printf("reading http response from %s failed (attempt %d/%d): %s", url, attempt+1, httpMaxAttempts, readErr)
			continue
		}

		return HTTPResult{Body: responseBody, StatusCode: res.StatusCode}, nil
	}

	return HTTPResult{}, lastErr
}
