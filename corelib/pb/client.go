package pb

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/utils"
)

// Client is a stateful PocketBase client. It holds an admin token and refreshes
// it automatically when the server returns 401, so a long-running worker keeps
// working across token expiry instead of silently failing (the old code fetched
// the token once at startup).
type Client struct {
	baseURL    string
	collection string
	identity   string
	password   string

	mu    sync.RWMutex
	token string
}

// NewClient creates a client and performs the initial authentication.
func NewClient(config models.Config) (*Client, error) {
	if config.PB == nil {
		return nil, fmt.Errorf("PB config is missing")
	}
	// Service-account cutover (#70): no silent fall back to _superusers. An unset
	// auth collection is a misconfiguration, not a licence to authenticate with
	// superuser rights — fail loudly so a node never runs privileged by accident.
	// Set PB_AUTH_COLLECTION explicitly (normally "service_accounts").
	collection := config.PB.Admin.Collection
	if collection == "" {
		return nil, fmt.Errorf("PB auth collection is not set: set PB_AUTH_COLLECTION (e.g. \"service_accounts\") — refusing to fall back to _superusers")
	}
	c := &Client{
		baseURL:    strings.TrimRight(config.PB.URL, "/"),
		collection: collection,
		identity:   config.PB.Admin.Username,
		password:   config.PB.Admin.Password,
	}
	if err := c.authenticate(); err != nil {
		return nil, err
	}
	return c, nil
}

// NewClientWithRetry authenticates with PocketBase, retrying on failure with
// exponential backoff + jitter (capped) until it succeeds. This turns a
// transient PB outage or 429 at startup into an in-process wait instead of a
// tight Docker restart loop that hammers PocketBase. It blocks until connected.
func NewClientWithRetry(config models.Config) *Client {
	for attempt := 1; ; attempt++ {
		c, err := NewClient(config)
		if err == nil {
			if attempt > 1 {
				log.Printf("PocketBase: authenticated after %d attempts", attempt)
			}
			return c
		}
		delay := utils.Jitter(utils.Backoff(attempt, utils.RetryBaseDelay, utils.RetryMaxDelay))
		log.Printf("PocketBase: auth attempt %d failed (%s) — retrying in %s", attempt, err, delay.Truncate(time.Millisecond))
		time.Sleep(delay)
	}
}

func (c *Client) authenticate() error {
	body, _ := json.Marshal(map[string]string{
		"identity": c.identity,
		"password": c.password,
	})

	// Auth against the configured collection: "_superusers" (default) or a
	// scoped service-account collection (v0.23+ auth-collection endpoint).
	res, err := utils.DoRequest("POST", c.baseURL+"/api/collections/"+c.collection+"/auth-with-password", body, "")
	if err != nil {
		return fmt.Errorf("authenticating with PocketBase: %w", err)
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("authenticating with PocketBase: status %d: %s", res.StatusCode, string(res.Body))
	}

	var parsed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(res.Body, &parsed); err != nil {
		return fmt.Errorf("parsing PocketBase auth response: %w", err)
	}
	if parsed.Token == "" {
		return fmt.Errorf("PocketBase auth returned an empty token")
	}

	c.mu.Lock()
	c.token = parsed.Token
	c.mu.Unlock()
	return nil
}

func (c *Client) getToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

// request performs an authenticated request, refreshing the token once on a 401.
func (c *Client) request(method, path string, body []byte) (utils.HTTPResult, error) {
	res, err := utils.DoRequest(method, c.baseURL+path, body, c.getToken())
	if err != nil {
		return res, err
	}
	if res.StatusCode == 401 {
		if err := c.authenticate(); err != nil {
			return res, err
		}
		return utils.DoRequest(method, c.baseURL+path, body, c.getToken())
	}
	return res, nil
}

// Ping verifies the client can reach PocketBase and is authenticated.
func (c *Client) Ping() error {
	res, err := c.request("GET", "/api/collections/monitors/records?perPage=1&skipTotal=true", nil)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("PocketBase ping returned status %d", res.StatusCode)
	}
	return nil
}

// listPageSize is the per-request page size for all paginated list reads.
const listPageSize = 500

// monitorWarnBound is a soft ceiling for monitor listings; crossing it logs a
// warning so a scale jump (or a runaway filter) is visible, not silent.
const monitorWarnBound = 5000

// listAll fetches EVERY page of a records listing, following pages until a short
// page (fewer than listPageSize items) comes back — so a large result set is
// never silently truncated at one page. That single-page truncation was the
// 500-monitor ceiling (#313): monitors past the first page were simply never
// scheduled or evaluated, with no error.
//
// `query` is everything after "records?" — filter, fields, sort, skipTotal=true
// — but NOT page/perPage, which listAll owns. When warnOver > 0 and the total
// crosses it, a warning is logged so a future regression is loud.
func listAll[T any](c *Client, collection, query, label string, warnOver int) ([]T, error) {
	var all []T
	for page := 1; ; page++ {
		path := fmt.Sprintf("/api/collections/%s/records?%s&page=%d&perPage=%d", collection, query, page, listPageSize)
		res, err := c.request("GET", path, nil)
		if err != nil {
			return nil, err
		}
		if res.StatusCode != 200 {
			return nil, fmt.Errorf("listing %s returned status %d: %s", label, res.StatusCode, string(res.Body))
		}
		var parsed struct {
			Items []T `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &parsed); err != nil {
			return nil, fmt.Errorf("parsing %s: %w", label, err)
		}
		all = append(all, parsed.Items...)
		// A short page means we've reached the end. (skipTotal=true omits the
		// total, so short-page detection — not totalPages — is what bounds us.)
		if len(parsed.Items) < listPageSize {
			break
		}
	}
	if warnOver > 0 && len(all) > warnOver {
		log.Printf("WARN: %s listing returned %d records (over the expected ~%d) — verify pagination and scale", label, len(all), warnOver)
	}
	return all, nil
}

// GetEnabledMonitors returns all enabled monitors (id, interval, zones, enabled)
// for the scheduler to enqueue.
func (c *Client) GetEnabledMonitors() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape("enabled = true"), "id,type,interval,zones,enabled")
	return listAll[models.Monitor](c, "monitors", query, "enabled monitors", monitorWarnBound)
}

// GetMonitor returns the full monitor definition needed to run a check.
func (c *Client) GetMonitor(id string) (models.Monitor, error) {
	fields := "id,user,name,type,target,interval,enabled,escalation_policy,zones,config"
	path := fmt.Sprintf("/api/collections/monitors/records/%s?fields=%s", id, fields)

	res, err := c.request("GET", path, nil)
	if err != nil {
		return models.Monitor{}, err
	}
	if res.StatusCode != 200 {
		return models.Monitor{}, fmt.Errorf("getting monitor %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}

	var monitor models.Monitor
	if err := json.Unmarshal(res.Body, &monitor); err != nil {
		return models.Monitor{}, fmt.Errorf("parsing monitor %s: %w", id, err)
	}
	return monitor, nil
}

// CreateCheck writes a single check result to the `checks` collection.
func (c *Client) CreateCheck(monitorId, zone string, result models.CheckResult, checkedAt time.Time) error {
	body, _ := json.Marshal(map[string]interface{}{
		"monitor":        monitorId,
		"zone":           zone,
		"up":             result.Up,
		"status_code":    result.StatusCode,
		"response_ms":    result.ResponseMs,
		"dns_ms":         result.DnsMs,
		"connect_ms":     result.ConnectMs,
		"tls_ms":         result.TlsMs,
		"ttfb_ms":        result.TtfbMs,
		"error":          result.Error,
		"redirect_count": result.RedirectCount,
		"final_url":      result.FinalURL,
		"checked_at":     checkedAt.UTC().Format(time.RFC3339),
	})

	res, err := c.request("POST", "/api/collections/checks/records", body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 && res.StatusCode != 201 {
		return fmt.Errorf("creating check returned status %d: %s", res.StatusCode, string(res.Body))
	}
	return nil
}

// ListMonitorsForEval returns all enabled monitors with the fields the evaluator
// needs (id, zones, interval, current status).
func (c *Client) ListMonitorsForEval() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape("enabled = true"), "id,type,zones,interval,status,last_checked,config")
	return listAll[models.Monitor](c, "monitors", query, "monitors for eval", monitorWarnBound)
}

// ListMonitorsWithCert returns enabled monitors that have a captured TLS cert
// expiry, with the fields the cert-expiry alerter needs.
func (c *Client) ListMonitorsWithCert() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape(`enabled = true && cert_expires_at != ""`), "id,name,target,user,cert_expires_at")
	return listAll[models.Monitor](c, "monitors", query, "monitors with cert", monitorWarnBound)
}

// ListMonitorsForLatency returns enabled monitors with the fields the latency
// alerter needs. The threshold lives in `config`, so it's filtered in Go.
func (c *Client) ListMonitorsForLatency() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape("enabled = true"), "id,name,target,user,config")
	return listAll[models.Monitor](c, "monitors", query, "monitors for latency", monitorWarnBound)
}

// ListMonitorsForDomainRefresh returns enabled, non-heartbeat monitors with the
// fields the domain-expiry refresher needs to decide staleness and query. The
// target-has-a-domain and cache-TTL filtering happen in Go (target parsing and
// TTL math don't express well as a PocketBase filter).
func (c *Client) ListMonitorsForDomainRefresh() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape(`enabled = true && type != "heartbeat"`), "id,type,target,domain_expires_at,domain_checked_at")
	return listAll[models.Monitor](c, "monitors", query, "monitors for domain refresh", monitorWarnBound)
}

// ListMonitorsWithDomain returns enabled monitors that have a resolved domain
// expiry, with the fields the domain-expiry alerter needs.
func (c *Client) ListMonitorsWithDomain() ([]models.Monitor, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s&fields=%s",
		url.QueryEscape(`enabled = true && domain_expires_at != ""`), "id,name,target,user,domain_expires_at")
	return listAll[models.Monitor](c, "monitors", query, "monitors with domain", monitorWarnBound)
}

// UpdateMonitorDomainExpiry stamps the domain lookup's outcome: the checked-at
// time always (so the cache TTL advances even when nothing was found), and the
// expiry only when the lookup resolved one (zero = leave the prior value).
func (c *Client) UpdateMonitorDomainExpiry(id string, expiresAt time.Time, checkedAt time.Time) error {
	fields := map[string]interface{}{
		"domain_checked_at": checkedAt.UTC().Format(time.RFC3339),
	}
	if !expiresAt.IsZero() {
		fields["domain_expires_at"] = expiresAt.UTC().Format(time.RFC3339)
	}
	body, _ := json.Marshal(fields)

	res, err := c.request("PATCH", "/api/collections/monitors/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating monitor %s domain expiry returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// CheckRecord is a slim view of a `checks` row used for consensus and rollups.
type CheckRecord struct {
	Zone       string `json:"zone"`
	Up         bool   `json:"up"`
	StatusCode int    `json:"status_code"`
	ResponseMs int    `json:"response_ms"`
	CheckedAt  string `json:"checked_at"`
}

// GetChecksSince returns a monitor's checks since the given time, oldest-first.
func (c *Client) GetChecksSince(monitorId string, since time.Time) ([]CheckRecord, error) {
	// Paginate to completion (#315): the hourly rollup pulls a whole hour through
	// here, and a single 500-row page silently undercounted high-frequency
	// monitors — a permanent error, since rollups outlive the raw checks.
	filter := url.QueryEscape(fmt.Sprintf(`monitor = "%s" && checked_at >= "%s"`, monitorId, since.UTC().Format(pbTimeLayout)))
	query := fmt.Sprintf("skipTotal=true&sort=checked_at&fields=zone,up,status_code,response_ms,checked_at&filter=%s", filter)
	return listAll[CheckRecord](c, "checks", query, "checks", 0)
}

// GetLatestIncident returns the most recent incident for a monitor, or nil if
// there are none.
func (c *Client) GetLatestIncident(monitorId string) (*models.Incident, error) {
	filter := url.QueryEscape(fmt.Sprintf(`monitor = "%s"`, monitorId))
	path := fmt.Sprintf("/api/collections/incidents/records?perPage=1&skipTotal=true&sort=-started_at&filter=%s", filter)

	res, err := c.request("GET", path, nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("listing incidents returned status %d: %s", res.StatusCode, string(res.Body))
	}

	var parsed struct {
		Items []models.Incident `json:"items"`
	}
	if err := json.Unmarshal(res.Body, &parsed); err != nil {
		return nil, fmt.Errorf("parsing incidents: %w", err)
	}
	if len(parsed.Items) == 0 {
		return nil, nil
	}
	return &parsed.Items[0], nil
}

// CreateIncident opens a new incident for a monitor and returns its id.
func (c *Client) CreateIncident(monitorId, cause string, startedAt time.Time) (string, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"monitor":    monitorId,
		"started_at": startedAt.UTC().Format(time.RFC3339),
		"cause":      cause,
		"notified":   false,
	})

	res, err := c.request("POST", "/api/collections/incidents/records", body)
	if err != nil {
		return "", err
	}
	if res.StatusCode != 200 && res.StatusCode != 201 {
		return "", fmt.Errorf("creating incident returned status %d: %s", res.StatusCode, string(res.Body))
	}
	var created struct {
		Id string `json:"id"`
	}
	if err := json.Unmarshal(res.Body, &created); err != nil {
		return "", fmt.Errorf("parsing created incident: %w", err)
	}
	return created.Id, nil
}

// CreateIncidentEvent appends an event to an incident's timeline. `zone` and
// `author` may be empty (author is set for user comments, empty for system events).
func (c *Client) CreateIncidentEvent(incidentId, eventType, message, zone, author string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"incident": incidentId,
		"type":     eventType,
		"message":  message,
		"zone":     zone,
		"author":   author,
	})

	res, err := c.request("POST", "/api/collections/incident_events/records", body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 && res.StatusCode != 201 {
		return fmt.Errorf("creating incident event returned status %d: %s", res.StatusCode, string(res.Body))
	}
	return nil
}

// ResolveIncident stamps an incident's resolved_at time.
func (c *Client) ResolveIncident(id string, resolvedAt time.Time) error {
	body, _ := json.Marshal(map[string]interface{}{
		"resolved_at": resolvedAt.UTC().Format(time.RFC3339),
	})

	res, err := c.request("PATCH", "/api/collections/incidents/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("resolving incident %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// GetUnnotifiedIncidents returns incidents that have not been alerted on yet.
func (c *Client) GetUnnotifiedIncidents() ([]models.Incident, error) {
	query := fmt.Sprintf("skipTotal=true&sort=started_at&filter=%s", url.QueryEscape("notified = false"))
	return listAll[models.Incident](c, "incidents", query, "unnotified incidents", monitorWarnBound)
}

// MarkIncidentNotified flags an incident as alerted-on.
func (c *Client) MarkIncidentNotified(id string) error {
	body, _ := json.Marshal(map[string]interface{}{"notified": true})
	res, err := c.request("PATCH", "/api/collections/incidents/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("marking incident %s notified returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// GetUnrecoveredIncidents returns incidents that have resolved and were
// down-notified but haven't had a recovery ("back up") alert yet. `resolvedSince`
// bounds it to recent resolutions so historical incidents aren't re-announced
// (e.g. when the recovery_notified field is first added).
func (c *Client) GetUnrecoveredIncidents(resolvedSince time.Time) ([]models.Incident, error) {
	filter := url.QueryEscape(fmt.Sprintf(`resolved_at != "" && notified = true && recovery_notified = false && resolved_at >= "%s"`,
		resolvedSince.UTC().Format(pbTimeLayout)))
	query := fmt.Sprintf("skipTotal=true&sort=started_at&filter=%s", filter)
	return listAll[models.Incident](c, "incidents", query, "unrecovered incidents", monitorWarnBound)
}

func (c *Client) MarkIncidentRecoveryNotified(id string) error {
	body, _ := json.Marshal(map[string]interface{}{"recovery_notified": true})
	res, err := c.request("PATCH", "/api/collections/incidents/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("marking incident %s recovery-notified returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// GetOpenUnacknowledgedIncidents returns incidents that are open (unresolved) and
// not yet acknowledged — the set the escalation engine drives.
func (c *Client) GetOpenUnacknowledgedIncidents() ([]models.Incident, error) {
	query := fmt.Sprintf("skipTotal=true&sort=started_at&filter=%s",
		url.QueryEscape(`resolved_at = "" && acknowledged_at = ""`))
	return listAll[models.Incident](c, "incidents", query, "open incidents", monitorWarnBound)
}

// UpdateIncidentEscalation records how many escalation levels have fired (and
// marks the incident notified so recovery alerts still gate on it). When
// clearEscalateNow is set, the manual "escalate now" flag is reset.
func (c *Client) UpdateIncidentEscalation(id string, level int, clearEscalateNow bool) error {
	body := map[string]interface{}{"escalation_level": level, "notified": true}
	if clearEscalateNow {
		body["escalate_now"] = false
	}
	b, _ := json.Marshal(body)
	res, err := c.request("PATCH", "/api/collections/incidents/records/"+id, b)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating incident %s escalation returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// GetEscalationPolicy returns a policy with its ordered steps.
func (c *Client) GetEscalationPolicy(id string) (models.EscalationPolicy, error) {
	path := fmt.Sprintf("/api/collections/escalation_policies/records/%s?fields=id,name,steps", id)
	res, err := c.request("GET", path, nil)
	if err != nil {
		return models.EscalationPolicy{}, err
	}
	if res.StatusCode != 200 {
		return models.EscalationPolicy{}, fmt.Errorf("getting escalation policy %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	var p models.EscalationPolicy
	if err := json.Unmarshal(res.Body, &p); err != nil {
		return models.EscalationPolicy{}, fmt.Errorf("parsing escalation policy %s: %w", id, err)
	}
	return p, nil
}

// GetAlertChannels returns a user's enabled alert channels.
func (c *Client) GetAlertChannels(userId string) ([]models.AlertChannel, error) {
	query := fmt.Sprintf("skipTotal=true&filter=%s",
		url.QueryEscape(fmt.Sprintf(`user = "%s" && enabled = true`, userId)))
	return listAll[models.AlertChannel](c, "alert_channels", query, "alert channels", 0)
}

// ChannelsForMonitor resolves a monitor's alert recipients. Today that's the
// monitor's single owner's channels; routing every monitor→channels lookup
// through this one helper means a future ownership change (e.g. teams) touches
// one place instead of every alerter. GetAlertChannels(userId) stays as the
// underlying primitive (used directly by non-monitor paths like test alerts).
func (c *Client) ChannelsForMonitor(monitor models.Monitor) ([]models.AlertChannel, error) {
	return c.GetAlertChannels(monitor.User)
}

// TestAlert is a pending "send a test" request from the web UI. Channel, when
// set, scopes the test to a single alert channel (else all of the user's).
type TestAlert struct {
	Id      string `json:"id"`
	User    string `json:"user"`
	Channel string `json:"channel"`
}

// GetPendingTestAlerts returns queued test-alert requests awaiting delivery.
func (c *Client) GetPendingTestAlerts() ([]TestAlert, error) {
	query := fmt.Sprintf("skipTotal=true&sort=created&fields=id,user,channel&filter=%s",
		url.QueryEscape(`status = "pending"`))
	return listAll[TestAlert](c, "test_alerts", query, "test alerts", 0)
}

// UpdateTestAlert marks a test-alert request done and records the delivery result.
func (c *Client) UpdateTestAlert(id, status, result string) error {
	body, _ := json.Marshal(map[string]interface{}{"status": status, "result": result})
	res, err := c.request("PATCH", "/api/collections/test_alerts/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating test alert %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// CreateChannelEvent appends a delivery record to a channel's log (kind:
// test|incident|recovery, outcome: delivered|skipped|failed).
func (c *Client) CreateChannelEvent(channelId, kind, outcome, detail string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"channel": channelId,
		"kind":    kind,
		"outcome": outcome,
		"detail":  detail,
	})
	res, err := c.request("POST", "/api/collections/channel_events/records", body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 && res.StatusCode != 201 {
		return fmt.Errorf("creating channel event returned status %d: %s", res.StatusCode, string(res.Body))
	}
	return nil
}

// ZoneStat is a slim view of a zone_stats row for the dead-man's switch.
type ZoneStat struct {
	Zone    string `json:"zone"`
	Updated string `json:"updated"`
}

// GetZoneStats returns the latest per-zone stats (zone + heartbeat time).
func (c *Client) GetZoneStats() ([]ZoneStat, error) {
	return listAll[ZoneStat](c, "zone_stats", "skipTotal=true&fields=zone,updated", "zone stats", 0)
}

const pbTimeLayout = "2006-01-02 15:04:05.000Z"

// CountIncidentsBetween counts incidents for a monitor that started in [from, to).
func (c *Client) CountIncidentsBetween(monitorId string, from, to time.Time) (int, error) {
	filter := url.QueryEscape(fmt.Sprintf(`monitor = "%s" && started_at >= "%s" && started_at < "%s"`,
		monitorId, from.UTC().Format(pbTimeLayout), to.UTC().Format(pbTimeLayout)))
	path := fmt.Sprintf("/api/collections/incidents/records?perPage=1&filter=%s", filter)

	res, err := c.request("GET", path, nil)
	if err != nil {
		return 0, err
	}
	if res.StatusCode != 200 {
		return 0, fmt.Errorf("counting incidents returned status %d: %s", res.StatusCode, string(res.Body))
	}

	var parsed struct {
		TotalItems int `json:"totalItems"`
	}
	if err := json.Unmarshal(res.Body, &parsed); err != nil {
		return 0, fmt.Errorf("parsing incident count: %w", err)
	}
	return parsed.TotalItems, nil
}

// RollupRecord is a summary bucket read back from the `rollups` collection.
type RollupRecord struct {
	Zone          string  `json:"zone"`
	Period        string  `json:"period"`
	BucketStart   string  `json:"bucket_start"`
	UptimePct     float64 `json:"uptime_pct"`
	AvgMs         float64 `json:"avg_ms"`
	MaxMs         float64 `json:"max_ms"`
	MinMs         float64 `json:"min_ms"`
	CheckCount    int     `json:"check_count"`
	IncidentCount int     `json:"incident_count"`
}

// GetRollups returns a monitor's rollup buckets of the given period within
// [from, to), oldest-first. Used to build coarser buckets from finer ones
// (hour -> day -> month) without re-scanning raw checks.
func (c *Client) GetRollups(monitorId, period string, from, to time.Time) ([]RollupRecord, error) {
	filter := url.QueryEscape(fmt.Sprintf(`monitor = "%s" && period = "%s" && bucket_start >= "%s" && bucket_start < "%s"`,
		monitorId, period, from.UTC().Format(pbTimeLayout), to.UTC().Format(pbTimeLayout)))
	query := fmt.Sprintf("skipTotal=true&sort=bucket_start&fields=zone,period,bucket_start,uptime_pct,avg_ms,max_ms,min_ms,check_count,incident_count&filter=%s", filter)
	return listAll[RollupRecord](c, "rollups", query, "rollups", 0)
}

// UpsertRollup writes (creating or updating) a summary bucket for a
// monitor+zone+period+bucket_start.
func (c *Client) UpsertRollup(monitorId, zone, period string, bucketStart time.Time,
	uptimePct, avgMs, maxMs, minMs float64, checkCount, incidentCount int) error {

	body, _ := json.Marshal(map[string]interface{}{
		"monitor":        monitorId,
		"zone":           zone,
		"period":         period,
		"bucket_start":   bucketStart.UTC().Format(time.RFC3339),
		"uptime_pct":     uptimePct,
		"avg_ms":         avgMs,
		"max_ms":         maxMs,
		"min_ms":         minMs,
		"check_count":    checkCount,
		"incident_count": incidentCount,
	})

	filter := url.QueryEscape(fmt.Sprintf(`monitor = "%s" && zone = "%s" && period = "%s" && bucket_start = "%s"`,
		monitorId, zone, period, bucketStart.UTC().Format(pbTimeLayout)))
	res, err := c.request("GET", "/api/collections/rollups/records?perPage=1&skipTotal=true&filter="+filter, nil)
	if err != nil {
		return err
	}
	if res.StatusCode == 200 {
		var list struct {
			Items []struct {
				Id string `json:"id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &list); err == nil && len(list.Items) > 0 {
			upd, err := c.request("PATCH", "/api/collections/rollups/records/"+list.Items[0].Id, body)
			if err != nil {
				return err
			}
			if upd.StatusCode != 200 {
				return fmt.Errorf("updating rollup returned status %d: %s", upd.StatusCode, string(upd.Body))
			}
			return nil
		}
	}

	created, err := c.request("POST", "/api/collections/rollups/records", body)
	if err != nil {
		return err
	}
	if created.StatusCode != 200 && created.StatusCode != 201 {
		return fmt.Errorf("creating rollup returned status %d: %s", created.StatusCode, string(created.Body))
	}
	return nil
}

// --- retention purge (#314) --------------------------------------------------

// PurgeResult reports one purge run for a collection.
type PurgeResult struct {
	Deleted   int // rows deleted this run
	Remaining int // rows still older than the cutoff when we stopped (0 = drained)
}

// deleteConcurrency bounds parallel DELETEs so a purge drains a backlog quickly
// without stampeding PocketBase.
const deleteConcurrency = 8

func purgeClause(timeField, extraFilter string, cutoff time.Time) string {
	clause := fmt.Sprintf(`%s < "%s"`, timeField, cutoff.UTC().Format(pbTimeLayout))
	if extraFilter != "" {
		clause = extraFilter + " && " + clause
	}
	return clause
}

// deleteIDs deletes records by id with bounded concurrency. Best-effort: it
// waits for all in-flight deletes and returns the first error, if any.
func (c *Client) deleteIDs(collection string, ids []string) error {
	sem := make(chan struct{}, deleteConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for _, id := range ids {
		sem <- struct{}{}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			res, err := c.request("DELETE", "/api/collections/"+collection+"/records/"+id, nil)
			if err == nil && res.StatusCode != 200 && res.StatusCode != 204 {
				err = fmt.Errorf("deleting %s/%s returned status %d", collection, id, res.StatusCode)
			}
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	return firstErr
}

// countOlderThan returns how many records still match the cutoff — the retention
// backlog. perPage=1 WITHOUT skipTotal makes PocketBase return totalItems.
func (c *Client) countOlderThan(collection, timeField, extraFilter string, cutoff time.Time) (int, error) {
	filter := url.QueryEscape(purgeClause(timeField, extraFilter, cutoff))
	path := fmt.Sprintf("/api/collections/%s/records?perPage=1&fields=id&filter=%s", collection, filter)
	res, err := c.request("GET", path, nil)
	if err != nil {
		return 0, err
	}
	if res.StatusCode != 200 {
		return 0, fmt.Errorf("counting old %s returned status %d: %s", collection, res.StatusCode, string(res.Body))
	}
	var parsed struct {
		TotalItems int `json:"totalItems"`
	}
	if err := json.Unmarshal(res.Body, &parsed); err != nil {
		return 0, fmt.Errorf("parsing count of old %s: %w", collection, err)
	}
	return parsed.TotalItems, nil
}

// PurgeOlderThan deletes records whose timeField is before cutoff (optionally
// AND extraFilter), oldest-first, in pages of listPageSize deleted concurrently,
// looping until the backlog is drained or `budget` elapses. Returns rows deleted
// and — only if it stopped on the budget — rows still remaining (the alarm
// signal). Unlike the old fixed 1000/run cap, one run keeps going until it's
// caught up (or out of time), so purge can outpace the insert rate.
func (c *Client) PurgeOlderThan(collection, timeField, extraFilter string, cutoff time.Time, budget time.Duration) (PurgeResult, error) {
	deadline := time.Now().Add(budget)
	filter := url.QueryEscape(purgeClause(timeField, extraFilter, cutoff))
	deleted := 0
	drained := false
	for time.Now().Before(deadline) {
		path := fmt.Sprintf("/api/collections/%s/records?perPage=%d&skipTotal=true&sort=%s&fields=id&filter=%s",
			collection, listPageSize, timeField, filter)
		res, err := c.request("GET", path, nil)
		if err != nil {
			return PurgeResult{Deleted: deleted}, err
		}
		if res.StatusCode != 200 {
			return PurgeResult{Deleted: deleted}, fmt.Errorf("listing old %s returned status %d: %s", collection, res.StatusCode, string(res.Body))
		}
		var parsed struct {
			Items []struct {
				Id string `json:"id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &parsed); err != nil {
			return PurgeResult{Deleted: deleted}, fmt.Errorf("parsing old %s: %w", collection, err)
		}
		if len(parsed.Items) == 0 {
			drained = true
			break
		}
		ids := make([]string, len(parsed.Items))
		for i, it := range parsed.Items {
			ids[i] = it.Id
		}
		if err := c.deleteIDs(collection, ids); err != nil {
			return PurgeResult{Deleted: deleted}, err
		}
		deleted += len(ids)
		if len(ids) < listPageSize {
			drained = true
			break
		}
	}
	remaining := 0
	if !drained {
		remaining, _ = c.countOlderThan(collection, timeField, extraFilter, cutoff)
	}
	return PurgeResult{Deleted: deleted, Remaining: remaining}, nil
}

// UpdateMonitorStatus writes the consensus status onto the monitor.
func (c *Client) UpdateMonitorStatus(id, status string) error {
	body, _ := json.Marshal(map[string]interface{}{"status": status})

	res, err := c.request("PATCH", "/api/collections/monitors/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating monitor %s status returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// EvaluatorZone is the reserved zone_stats row the evaluator upserts as its own
// liveness heartbeat (queue/lag are always 0). It is NOT a worker region — the
// web filters it out of the zone pickers — but its `updated` timestamp lets an
// external observer (the web /api/health) detect a dead evaluator, which nothing
// else can (the dead-man switch runs inside the evaluator, so it can't ring for
// its own death). Kept in sync with the web's EVALUATOR_ZONE constant.
const EvaluatorZone = "evaluator"

// WebZone is the reserved zone_stats row the WEB writes on a Cloudflare Cron
// Trigger (#339). Its freshness is evidence that the check-in path — Worker ->
// edge -> Access -> Tunnel -> PocketBase — is intact.
//
// The evaluator needs this because it cannot otherwise tell "this customer's cron
// stopped running" from "no check-in can reach us right now". It sits on the
// private network, so a Cloudflare outage leaves it perfectly healthy while every
// heartbeat monitor goes quiet — and it would page for all of them. Kept in sync
// with the web's WEB_ZONE constant.
const WebZone = "web"

// UpsertZoneStats writes the current per-zone stats (one record per zone),
// creating the record on first run and updating it thereafter. The record's
// `updated` timestamp doubles as the zone heartbeat.
func (c *Client) UpsertZoneStats(zone, worker string, queueDepth, scheduleLagSeconds, workers int64) error {
	body, _ := json.Marshal(map[string]interface{}{
		"zone":                 zone,
		"worker":               worker,
		"queue_depth":          queueDepth,
		"schedule_lag_seconds": scheduleLagSeconds,
		// Live workers in the zone (#311). A count, not a list: which containers
		// answered is ops detail. Published by the leader only — the row is keyed
		// by zone, so every worker writing it would just overwrite the others.
		"workers": workers,
	})

	filter := url.QueryEscape(fmt.Sprintf(`zone = "%s"`, zone))
	res, err := c.request("GET", fmt.Sprintf("/api/collections/zone_stats/records?perPage=1&skipTotal=true&filter=%s", filter), nil)
	if err != nil {
		return err
	}
	if res.StatusCode == 200 {
		var list struct {
			Items []struct {
				Id string `json:"id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &list); err == nil && len(list.Items) > 0 {
			upd, err := c.request("PATCH", "/api/collections/zone_stats/records/"+list.Items[0].Id, body)
			if err != nil {
				return err
			}
			if upd.StatusCode != 200 {
				return fmt.Errorf("updating zone_stats returned status %d: %s", upd.StatusCode, string(upd.Body))
			}
			return nil
		}
	}

	created, err := c.request("POST", "/api/collections/zone_stats/records", body)
	if err != nil {
		return err
	}
	if created.StatusCode != 200 && created.StatusCode != 201 {
		return fmt.Errorf("creating zone_stats returned status %d: %s", created.StatusCode, string(created.Body))
	}
	return nil
}

// UpdateMonitorAfterCheck stamps the monitor's last_checked time (best-effort),
// and its TLS cert expiry when the check captured one (zero = leave untouched).
func (c *Client) UpdateMonitorAfterCheck(id string, checkedAt time.Time, certExpiresAt time.Time) error {
	fields := map[string]interface{}{
		"last_checked": checkedAt.UTC().Format(time.RFC3339),
	}
	if !certExpiresAt.IsZero() {
		fields["cert_expires_at"] = certExpiresAt.UTC().Format(time.RFC3339)
	}
	body, _ := json.Marshal(fields)

	res, err := c.request("PATCH", "/api/collections/monitors/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating monitor %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// --- Anonymous "try it" monitors (#270) ---
// The isolated free-zone worker runs these instead of `monitors`. They reuse the
// Monitor struct (id/type/target/interval/config are the fields a check needs);
// user/name/etc. are simply empty. No checks rows, no incidents/rollups/alerts —
// the worker writes up/down status straight back to the row.

// GetAnonMonitors lists the ids of all anonymous monitors to seed into the free
// queue. They're all active until the TTL cleanup removes them.
func (c *Client) GetAnonMonitors() ([]models.Monitor, error) {
	return listAll[models.Monitor](c, "anon_monitors", "skipTotal=true&fields=id", "anon monitors", monitorWarnBound)
}

// GetAnonMonitor fetches the fields needed to run one anonymous check.
func (c *Client) GetAnonMonitor(id string) (models.Monitor, error) {
	path := "/api/collections/anon_monitors/records/" + id + "?fields=id,type,target,interval,config"

	res, err := c.request("GET", path, nil)
	if err != nil {
		return models.Monitor{}, err
	}
	if res.StatusCode != 200 {
		return models.Monitor{}, fmt.Errorf("getting anon monitor %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}

	var monitor models.Monitor
	if err := json.Unmarshal(res.Body, &monitor); err != nil {
		return models.Monitor{}, fmt.Errorf("parsing anon monitor %s: %w", id, err)
	}
	return monitor, nil
}

// UpdateAnonMonitorAfterCheck writes the single-zone verdict straight onto the row
// (there's no evaluator for anon monitors).
func (c *Client) UpdateAnonMonitorAfterCheck(id, status string, checkedAt time.Time) error {
	body, _ := json.Marshal(map[string]interface{}{
		"status":       status,
		"last_checked": checkedAt.UTC().Format(time.RFC3339),
	})

	res, err := c.request("PATCH", "/api/collections/anon_monitors/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating anon monitor %s returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}

// DeleteAnonMonitorsOlderThan hard-deletes anon monitors created before `before`
// (the 1-hour TTL). Mirrors DeleteChecksOlderThan; oldest-first, capped per run.
func (c *Client) DeleteAnonMonitorsOlderThan(before time.Time, limit int) (int, error) {
	filter := url.QueryEscape(fmt.Sprintf(`created < "%s"`, before.UTC().Format(pbTimeLayout)))
	path := fmt.Sprintf("/api/collections/anon_monitors/records?perPage=%d&skipTotal=true&sort=created&fields=id&filter=%s", limit, filter)

	res, err := c.request("GET", path, nil)
	if err != nil {
		return 0, err
	}
	if res.StatusCode != 200 {
		return 0, fmt.Errorf("listing old anon monitors returned status %d: %s", res.StatusCode, string(res.Body))
	}

	var parsed struct {
		Items []struct {
			Id string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(res.Body, &parsed); err != nil {
		return 0, fmt.Errorf("parsing old anon monitors: %w", err)
	}

	deleted := 0
	for _, item := range parsed.Items {
		del, err := c.request("DELETE", "/api/collections/anon_monitors/records/"+item.Id, nil)
		if err != nil {
			return deleted, err
		}
		if del.StatusCode == 200 || del.StatusCode == 204 {
			deleted++
		}
	}
	return deleted, nil
}

// AlertStateRecord is one persisted alert-transition flag. The evaluator's
// "have I already alerted?" state used to live only in RAM, so every restart
// re-fired still-true conditions and dropped pending recoveries (#327).
type AlertStateRecord struct {
	Id    string `json:"id"`
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ListAlertState returns every persisted alert-transition flag. The evaluator
// reads this once at startup; the set is tiny (one row per alerting condition).
func (c *Client) ListAlertState() ([]AlertStateRecord, error) {
	res, err := c.request("GET", "/api/collections/alert_state/records?perPage=500&skipTotal=true", nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("listing alert_state returned status %d: %s", res.StatusCode, string(res.Body))
	}
	var out struct {
		Items []AlertStateRecord `json:"items"`
	}
	if err := json.Unmarshal(res.Body, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// PutAlertState upserts one flag by key. Keys are namespaced by alerter
// ("cert:<monitorId>", "zone.silent:<zone>"), so one collection serves all of
// them, including the dead-man's switch whose subject is a zone, not a monitor.
func (c *Client) PutAlertState(key, value string) error {
	body, _ := json.Marshal(map[string]interface{}{"key": key, "value": value})

	filter := url.QueryEscape(fmt.Sprintf(`key = "%s"`, key))
	res, err := c.request("GET", fmt.Sprintf("/api/collections/alert_state/records?perPage=1&skipTotal=true&filter=%s", filter), nil)
	if err != nil {
		return err
	}
	if res.StatusCode == 200 {
		var list struct {
			Items []struct {
				Id string `json:"id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(res.Body, &list); err == nil && len(list.Items) > 0 {
			upd, err := c.request("PATCH", "/api/collections/alert_state/records/"+list.Items[0].Id, body)
			if err != nil {
				return err
			}
			if upd.StatusCode != 200 {
				return fmt.Errorf("updating alert_state returned status %d: %s", upd.StatusCode, string(upd.Body))
			}
			return nil
		}
	}

	created, err := c.request("POST", "/api/collections/alert_state/records", body)
	if err != nil {
		return err
	}
	if created.StatusCode != 200 && created.StatusCode != 201 {
		return fmt.Errorf("creating alert_state returned status %d: %s", created.StatusCode, string(created.Body))
	}
	return nil
}

// DeleteAlertState clears one flag. Absent is success: the caller wants the flag
// gone, and a recovery that runs twice must not error the second time.
func (c *Client) DeleteAlertState(key string) error {
	filter := url.QueryEscape(fmt.Sprintf(`key = "%s"`, key))
	res, err := c.request("GET", fmt.Sprintf("/api/collections/alert_state/records?perPage=1&skipTotal=true&filter=%s", filter), nil)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("finding alert_state returned status %d: %s", res.StatusCode, string(res.Body))
	}
	var list struct {
		Items []struct {
			Id string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(res.Body, &list); err != nil || len(list.Items) == 0 {
		return nil
	}
	del, err := c.request("DELETE", "/api/collections/alert_state/records/"+list.Items[0].Id, nil)
	if err != nil {
		return err
	}
	if del.StatusCode != 204 && del.StatusCode != 200 && del.StatusCode != 404 {
		return fmt.Errorf("deleting alert_state returned status %d: %s", del.StatusCode, string(del.Body))
	}
	return nil
}

// UpdateMonitorConsensus records which zones the last evaluation voted with
// (#328). Called only when the value changes: the evaluation loop turns every
// 10s across every monitor, and writing this unconditionally would be a PATCH
// per monitor per tick for a value that changes rarely.
func (c *Client) UpdateMonitorConsensus(id, zones, fresh string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"consensus_zones": zones,
		"consensus_fresh": fresh,
	})
	res, err := c.request("PATCH", "/api/collections/monitors/records/"+id, body)
	if err != nil {
		return err
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("updating monitor %s consensus returned status %d: %s", id, res.StatusCode, string(res.Body))
	}
	return nil
}
