package services

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"monitors/corelib/models"
)

// checkTimeout bounds a single check so a hung target can never stall the worker.
const checkTimeout = 20 * time.Second

// maxFinalURLBytes caps a stored redirect target. Nothing in the measured data
// comes close (longest origin+path ~73 B) — the cap exists to bound a
// pathologically long path, not the observed case. Must match the `max` on
// checks.final_url in pb_schema.json.
const maxFinalURLBytes = 256

// finalURLTruncated marks a value the cap cut short, so a truncated URL is never
// mistaken for a complete one.
const finalURLTruncated = "\u2026"

// sanitizeFinalURL reduces a post-redirect URL to scheme + host + path.
//
// The query string is dropped entirely, for two reasons that happen to share one
// fix (#325). It is where the bytes are: 93% of everything stored in
// checks.final_url was query strings, and one monitor behind Cloudflare Access
// wrote 9,840 rows of 1,327 bytes that all resolved to a single origin+path,
// because the Access JWT changes per request.
//
// It is also where the secrets are. Those JWTs were sitting in a durable,
// replicated, backed-up column that the monitor's owner can read and the UI
// renders in a tooltip. Stripping rather than redacting is deliberate: redaction
// needs an allowlist of parameter names (meta, kid, token, sig, code, state,
// X-Amz-Signature, …) that grows forever, and anything missed is a silent leak.
// Dropping the whole query is a fixed, auditable rule.
func sanitizeFinalURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	// Copy: this is the live request URL, and callers after us may still read it.
	clean := *u
	clean.RawQuery = ""
	clean.ForceQuery = false
	clean.Fragment = ""
	clean.RawFragment = ""
	out := clean.String()
	if len(out) <= maxFinalURLBytes {
		return out
	}
	// Trim to the cap including the marker, without splitting a multi-byte rune.
	keep := maxFinalURLBytes - len(finalURLTruncated)
	for keep > 0 && !utf8.ValidString(out[:keep]) {
		keep--
	}
	return out[:keep] + finalURLTruncated
}

// maxAssertBodyBytes caps how much of the response body we read for keyword
// assertions, so a huge page can't blow up worker memory.
const maxAssertBodyBytes = 1 << 20 // 1 MiB

// assertBody reports whether a response body satisfies a keyword assertion.
// mode "contains" requires the keyword present; "absent" requires it missing.
// An empty keyword/mode is treated as "no assertion" (always satisfied).
func assertBody(body, keyword, mode string) bool {
	if keyword == "" {
		return true
	}
	present := strings.Contains(body, keyword)
	switch mode {
	case "contains":
		return present
	case "absent":
		return !present
	default:
		return true
	}
}

// userAgent identifies our prober honestly so site owners can allowlist it,
// rather than looking like a bare bot (Go's default UA) that CDNs rate-limit.
const userAgent = "nabz-bot/1.0 (+https://github.com/LytronHQ/nabz)"

// isBlockedStatus reports whether a status code means "the target refused to let
// us judge it" (rate-limited / bot-blocked) rather than a genuine outage. Such a
// result is neither up nor a real down — the evaluator abstains on it.
func isBlockedStatus(code int) bool {
	return code == http.StatusTooManyRequests || code == http.StatusForbidden // 429, 403
}

// certExpiry returns the target's leaf TLS certificate expiry from a response's
// handshake state, or the zero time when there's no TLS (plain HTTP) or no cert.
// It reuses the handshake the HTTPS check already performed — no extra dial.
func certExpiry(res *http.Response) time.Time {
	if res == nil || res.TLS == nil || len(res.TLS.PeerCertificates) == 0 {
		return time.Time{}
	}
	return res.TLS.PeerCertificates[0].NotAfter
}

// parseRetryAfter reads the Retry-After header (delta-seconds form only) and
// returns the requested backoff in seconds, or 0 if absent/unparseable. The
// HTTP-date form is intentionally ignored here — CDNs use delta-seconds for 429.
func parseRetryAfter(res *http.Response) int {
	v := res.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return secs
	}
	return 0
}

// RunCheck performs a single check against the monitor's target and returns the
// result. Only HTTP(S) checks are implemented in Phase 1; other monitor types
// are recorded as an error result rather than crashing the worker.
func RunCheck(monitor models.Monitor) models.CheckResult {
	switch monitor.Type {
	case "", "website":
		return runHTTPCheck(monitor.Target, monitor.Config)
	case "port":
		return runTCPCheck(monitor.Target)
	case "ping":
		// "Ping" is TCP reachability (not ICMP). The user gives a host; default
		// the port to 443 when one isn't specified. Same engine as `port`.
		return runTCPCheck(ensurePort(monitor.Target, defaultPingPort))
	case "dns":
		return runDNSCheck(monitor.Target, monitor.Config)
	default:
		return models.CheckResult{
			Up:    false,
			Error: fmt.Sprintf("unsupported monitor type: %s", monitor.Type),
		}
	}
}

// defaultPingPort is the TCP port a `ping` monitor connects to when the target
// is a bare host (no port). 443 is reachable on most public hosts.
const defaultPingPort = "443"

// ensurePort returns target unchanged if it already has a host:port, otherwise
// it appends the default port. Used by `ping`, whose target is a bare host.
func ensurePort(target, port string) string {
	if _, _, err := net.SplitHostPort(target); err == nil {
		return target
	}
	return net.JoinHostPort(target, port)
}

// runTCPCheck opens a TCP connection to host:port and reports reachability plus
// the connect time. This is the shared TCP-reachability engine: the `port`
// monitor uses it directly, and `ping` — defined as TCP reachability, not ICMP —
// reuses it (defaulting the port). A refused, timed-out, or unresolved
// connection is down.
func runTCPCheck(target string) models.CheckResult {
	result := models.CheckResult{}

	// Require an explicit host:port. Reporting a clear error beats silently
	// dialing a default port the user didn't intend.
	if host, port, err := net.SplitHostPort(target); err != nil || host == "" || port == "" {
		result.Error = fmt.Sprintf("invalid target %q: expected host:port", target)
		return result
	}

	start := time.Now()
	dialer := net.Dialer{Timeout: checkTimeout, Control: dialControl()}
	conn, err := dialer.Dial("tcp", target)
	elapsed := int(time.Since(start).Milliseconds())
	result.ConnectMs = elapsed
	result.ResponseMs = elapsed

	if err != nil {
		result.Up = false
		result.Error = err.Error()
		return result
	}
	conn.Close()

	result.Up = true
	return result
}

func runHTTPCheck(target string, cfg models.MonitorConfig) models.CheckResult {
	result := models.CheckResult{}

	timeout := checkTimeout
	if cfg.TimeoutSecs > 0 {
		timeout = time.Duration(cfg.TimeoutSecs) * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	method := strings.ToUpper(strings.TrimSpace(cfg.Method))
	if method == "" {
		method = "GET"
	}

	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	// Send an identifiable UA + standard Accept headers so bot-protection is
	// less likely to challenge us with a 429/403. (Accept-Encoding is left unset
	// so Go's transport handles gzip transparently.) User-supplied headers win.
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}

	var start, connect, dns, tlsHandshake time.Time

	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { dns = time.Now() },
		DNSDone: func(httptrace.DNSDoneInfo) {
			result.DnsMs = int(time.Since(dns).Milliseconds())
		},
		TLSHandshakeStart: func() { tlsHandshake = time.Now() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			result.TlsMs = int(time.Since(tlsHandshake).Milliseconds())
		},
		ConnectStart: func(string, string) { connect = time.Now() },
		ConnectDone: func(string, string, error) {
			result.ConnectMs = int(time.Since(connect).Milliseconds())
		},
		GotFirstResponseByte: func() {
			result.TtfbMs = int(time.Since(start).Milliseconds())
		},
	}

	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	// Follow redirects by default (evaluate the final response); a monitor can
	// opt out to evaluate the first response as-is. When following, count the hops
	// so we can surface "followed N redirects → final URL" (#112) — transparency
	// only; the final response still decides up/down.
	var redirectCount int
	client := &http.Client{Transport: httpTransport()}
	if cfg.FollowRedirects != nil && !*cfg.FollowRedirects {
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	} else {
		client.CheckRedirect = func(_ *http.Request, via []*http.Request) error {
			redirectCount++
			if len(via) >= 10 {
				return fmt.Errorf("stopped after %d redirects", len(via))
			}
			return nil
		}
	}

	start = time.Now()
	res, err := client.Do(req)
	result.ResponseMs = int(time.Since(start).Milliseconds())

	if err != nil {
		result.Error = err.Error()
		result.Up = false
		return result
	}
	defer res.Body.Close()

	if redirectCount > 0 {
		result.RedirectCount = redirectCount
		result.FinalURL = sanitizeFinalURL(res.Request.URL)
	}

	result.CertExpiresAt = certExpiry(res)
	result.StatusCode = res.StatusCode
	if cfg.ExpectedStatus != 0 {
		result.Up = res.StatusCode == cfg.ExpectedStatus
	} else {
		result.Up = res.StatusCode >= 200 && res.StatusCode < 400
	}
	if isBlockedStatus(res.StatusCode) && cfg.ExpectedStatus == 0 {
		// Rate-limited / blocked: not up, but not a genuine outage either. (If the
		// user explicitly expects this code, it's already counted as up above.)
		result.Up = false
		result.Blocked = true
		result.RetryAfterSecs = parseRetryAfter(res)
		result.Error = fmt.Sprintf("rate-limited (status %d)", res.StatusCode)
	} else if !result.Up {
		if cfg.ExpectedStatus != 0 {
			result.Error = fmt.Sprintf("expected status %d, got %d", cfg.ExpectedStatus, res.StatusCode)
		} else {
			result.Error = fmt.Sprintf("unexpected status code: %d", res.StatusCode)
		}
	}

	// A body assertion can fail an otherwise-healthy response — this catches
	// "200 OK but wrong/error page". Only read the body when the status passed and
	// an assertion is configured (and the method actually returns a body).
	if result.Up && cfg.Keyword != "" && method != "HEAD" {
		body, _ := io.ReadAll(io.LimitReader(res.Body, maxAssertBodyBytes))
		if !assertBody(string(body), cfg.Keyword, cfg.KeywordMode) {
			result.Up = false
			if cfg.KeywordMode == "absent" {
				result.Error = fmt.Sprintf("body assertion failed: response contains %q", cfg.Keyword)
			} else {
				result.Error = fmt.Sprintf("body assertion failed: response missing %q", cfg.Keyword)
			}
		}
	}
	return result
}
