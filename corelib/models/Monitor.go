package models

import "time"

// MinIntervalSeconds is the minimum allowed check interval for real monitors
// (#319). Enforced at create/edit by the schema (monitors.interval min) and the
// form; EffectiveInterval clamps to it defensively so a legacy row created
// under the old 5s floor can't probe faster than this. A single knob if we ever
// want per-tier floors. (Anonymous trials floor much higher, at 300s.)
const MinIntervalSeconds = 30

// DefaultIntervalSeconds is the cadence assumed for a monitor with no interval
// stored (the field is optional, so 0 means "unset", not "as fast as possible").
const DefaultIntervalSeconds = 60

// EffectiveInterval is the cadence the system actually runs a monitor at: unset
// falls back to the default, and anything under the floor is clamped up.
//
// Every component that reasons about cadence MUST go through this. The worker
// schedules on it and the evaluator derives its freshness window from it; if
// only one of them clamped, a legacy sub-floor monitor would be probed every 30s
// while being judged against a window built from its raw 5s interval, so its
// checks would read as stale and it could never reach a verdict.
func EffectiveInterval(raw int) int {
	if raw <= 0 {
		return DefaultIntervalSeconds
	}
	if raw < MinIntervalSeconds {
		return MinIntervalSeconds
	}
	return raw
}

// Monitor is a sensor definition as stored in the PocketBase `monitors` collection.
type Monitor struct {
	Id       string   `json:"id"`
	User     string   `json:"user"`
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Target   string   `json:"target"`
	Interval int      `json:"interval"`
	Zones    []string `json:"zones"`
	Enabled  bool     `json:"enabled"`
	Status   string   `json:"status"`
	// ConsensusZones / ConsensusFresh record what the LAST evaluation actually
	// voted with: the zones that took part, and the subset of those that had a
	// fresh check (#328). Comma-separated, written by the evaluator only when they
	// change.
	//
	// They exist because the consequence of a zone going quiet is otherwise
	// invisible: a monitor pinned to two zones silently falls back to the
	// single-zone rule, and the UI cannot re-derive that honestly — freshness is
	// computed from the monitor's effective interval inside the evaluator, so any
	// second guess drifts from the decision that was actually made.
	ConsensusZones string `json:"consensus_zones"`
	ConsensusFresh string `json:"consensus_fresh"`
	// LastChecked is when the monitor was last probed or — for heartbeat monitors
	// — last checked in. Heartbeat evaluation uses it for staleness.
	LastChecked string `json:"last_checked"`
	// Token is the unguessable check-in token for heartbeat monitors (empty for
	// probed types); the public /ping/{token} endpoint records a check-in.
	Token string `json:"token"`
	// CertExpiresAt is when the target's TLS certificate expires (HTTPS website
	// monitors only), captured during the check. Empty if unknown/not HTTPS.
	CertExpiresAt string `json:"cert_expires_at"`
	// DomainExpiresAt is when the target's DOMAIN registration lapses (distinct
	// from the TLS cert above), from an infrequent, cached RDAP/WHOIS lookup the
	// evaluator runs — not the per-check probe. Empty if unknown (no data, a
	// non-domain target, or a rate-limited lookup). DomainCheckedAt is when that
	// lookup last ran, used to keep it infrequent.
	DomainExpiresAt string `json:"domain_expires_at"`
	DomainCheckedAt string `json:"domain_checked_at"`
	// EscalationPolicy is the id of the escalation_policies record to drive
	// paging for this monitor, or "" for the default (all channels, once).
	EscalationPolicy string `json:"escalation_policy"`
	// Config holds optional per-monitor check options (JSON field).
	Config MonitorConfig `json:"config"`
}

// MonitorConfig is the per-monitor `config` JSON blob. Optional check tuning
// that not every monitor sets. Every field has a safe zero-value default so an
// unset config behaves exactly like the original hardcoded check.
type MonitorConfig struct {
	// Keyword + KeywordMode assert on the response body: "contains" requires the
	// keyword to be present, "absent" requires it to be missing. Empty mode =
	// no body assertion.
	Keyword     string `json:"keyword,omitempty"`
	KeywordMode string `json:"keywordMode,omitempty"`
	// Method is the HTTP method (GET/HEAD/POST); empty = GET.
	Method string `json:"method,omitempty"`
	// Headers are extra request headers to send (override our defaults by name).
	Headers map[string]string `json:"headers,omitempty"`
	// ExpectedStatus, when non-zero, requires an exact status code for "up"
	// (otherwise the default 200–399 rule applies).
	ExpectedStatus int `json:"expectedStatus,omitempty"`
	// FollowRedirects toggles 3xx following. nil = default (follow); false = stop
	// at the first response and evaluate it as-is.
	FollowRedirects *bool `json:"followRedirects,omitempty"`
	// TimeoutSecs overrides the per-check timeout in seconds; 0 = default.
	TimeoutSecs int `json:"timeoutSecs,omitempty"`
	// MaintenanceWindows suppress alerts during planned work: while one is active
	// the monitor still runs checks, but no down/recovery alerts fire.
	MaintenanceWindows []MaintenanceWindow `json:"maintenanceWindows,omitempty"`
	// LatencyThresholdMs, when > 0, alerts on slowness: the evaluator warns when
	// the recent p95 response time exceeds this (with flap damping), separately
	// from up/down. 0 = disabled.
	LatencyThresholdMs int `json:"latencyThresholdMs,omitempty"`
	// DNS monitor options. DNSRecordType is A/AAAA/CNAME/MX/TXT/NS (empty = A).
	// DNSExpectedValue, when set, requires a resolved record to contain it.
	// DNSResolver, when set, queries that DNS server (host or host:port) instead
	// of the system resolver.
	DNSRecordType    string `json:"dnsRecordType,omitempty"`
	DNSExpectedValue string `json:"dnsExpectedValue,omitempty"`
	DNSResolver      string `json:"dnsResolver,omitempty"`
}

// MaintenanceWindow is a one-off planned-work interval (RFC3339 timestamps).
// Alerts are suppressed while now is within [Start, End).
type MaintenanceWindow struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// EscalationPolicy is an ordered set of levels that fire over time while an
// incident stays open and unacknowledged.
type EscalationPolicy struct {
	Id    string           `json:"id"`
	Name  string           `json:"name"`
	Steps []EscalationStep `json:"steps"`
}

// EscalationStep is one level: after AfterMinutes since the incident opened,
// notify these channel ids (if still open + unacknowledged).
type EscalationStep struct {
	AfterMinutes int      `json:"after_minutes"`
	Channels     []string `json:"channels"`
}

// CheckResult is the outcome of running a single check against a monitor's target.
type CheckResult struct {
	Up         bool
	StatusCode int
	ResponseMs int
	DnsMs      int
	ConnectMs  int
	TlsMs      int
	TtfbMs     int
	Error      string
	// CertExpiresAt is the target's TLS certificate expiry, captured from the
	// handshake during an HTTPS check. Zero when there's no TLS/cert.
	CertExpiresAt time.Time
	// Blocked marks a result as rate-limited / bot-blocked (e.g. HTTP 429/403):
	// the target refused to let us judge it, which is neither "up" nor a real
	// "down". The evaluator treats it as a neutral abstention (no incident, no
	// alert). Not persisted — derived downstream from StatusCode.
	Blocked bool
	// RetryAfterSecs is the target's requested backoff (from the Retry-After
	// header) when Blocked; 0 if absent. Used to reschedule the next check
	// instead of hammering. Not persisted.
	RetryAfterSecs int
	// RedirectCount is how many redirects were followed to reach the final
	// response (0 when none). FinalURL is the URL of that final response — set
	// only when RedirectCount > 0. Transparency only (#112); the final response
	// still decides up/down.
	RedirectCount int
	FinalURL      string
}
