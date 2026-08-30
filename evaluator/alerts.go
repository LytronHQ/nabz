package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/smtp"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
	"monitors/corelib/utils"
)

const defaultDeadmanSeconds = 90

// The web liveness beat is a CRON, firing every 2 minutes — so it is judged on a
// different clock from the zone heartbeats, which beat every 10s. Reusing the 90s
// deadman meant a perfectly punctual beat read as stale for the last 30s of every
// cycle, and this gate HOLDS heartbeat incidents while it thinks the check-in path
// is down: heartbeat alerting would have been suppressed roughly a quarter of the
// time, on a healthy system. 5 minutes is the window wrangler.toml already
// documents, and it also survives one missed run.
const defaultWebBeatSeconds = 300
const defaultCertWarnDays = 14

// alertConfig is read from the environment (all optional). Email is enabled when
// SMTP host + from are set; the dead-man's switch fires to opsWebhookURL if set.
type alertConfig struct {
	smtpHost      string
	smtpPort      string
	smtpUser      string
	smtpPass      string
	smtpFrom      string
	opsWebhookURL string
	deadman       time.Duration
	webBeat       time.Duration
	certWarn      time.Duration
	domainWarn    time.Duration
}

func loadAlertConfig() alertConfig {
	deadmanSecs := defaultDeadmanSeconds
	if v := os.Getenv("DEADMAN_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			deadmanSecs = n
		}
	}
	webBeatSecs := defaultWebBeatSeconds
	if v := os.Getenv("WEB_BEAT_STALE_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			webBeatSecs = n
		}
	}
	certWarnDays := defaultCertWarnDays
	if v := os.Getenv("CERT_EXPIRY_WARN_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			certWarnDays = n
		}
	}
	domainWarnDays := defaultDomainWarnDays
	if v := os.Getenv("DOMAIN_EXPIRY_WARN_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			domainWarnDays = n
		}
	}
	return alertConfig{
		smtpHost:      os.Getenv("SMTP_HOST"),
		smtpPort:      os.Getenv("SMTP_PORT"),
		smtpUser:      os.Getenv("SMTP_USERNAME"),
		smtpPass:      os.Getenv("SMTP_PASSWORD"),
		smtpFrom:      os.Getenv("SMTP_FROM"),
		opsWebhookURL: os.Getenv("OPS_WEBHOOK_URL"),
		deadman:       time.Duration(deadmanSecs) * time.Second,
		webBeat:       time.Duration(webBeatSecs) * time.Second,
		certWarn:      time.Duration(certWarnDays) * 24 * time.Hour,
		domainWarn:    time.Duration(domainWarnDays) * 24 * time.Hour,
	}
}

func (a alertConfig) emailEnabled() bool { return a.smtpHost != "" && a.smtpFrom != "" }

// resolvedLevel is one escalation level with its channel records resolved.
type resolvedLevel struct {
	AfterMinutes int
	Channels     []models.AlertChannel
}

// processEscalations drives paging for open, unacknowledged incidents. Each tick
// it fires any escalation level whose timer has elapsed (or the manual
// "escalate now" bump), notifying that level's channels. Acknowledging or
// resolving an incident stops it (acked incidents aren't in the query; resolved
// ones aren't open). Monitors without a policy get the default: all enabled
// channels, once, immediately.
func processEscalations(pbClient *pb.Client, cfg alertConfig, now time.Time) {
	incidents, err := pbClient.GetOpenUnacknowledgedIncidents()
	if err != nil {
		log.Printf("Alerts: failed to list open incidents: %s", err)
		return
	}

	for _, inc := range incidents {
		monitor, err := pbClient.GetMonitor(inc.Monitor)
		if err != nil {
			log.Printf("Alerts: [%s] cannot load monitor, will retry: %s", inc.Monitor, err)
			continue
		}
		if inMaintenance(monitor, now) {
			continue // planned maintenance — don't page while a window is active
		}
		channels, err := pbClient.ChannelsForMonitor(monitor)
		if err != nil {
			log.Printf("Alerts: [%s] cannot load channels, will retry: %s", inc.Monitor, err)
			continue
		}

		levels := escalationLevels(pbClient, monitor, channels)
		if len(levels) == 0 {
			continue
		}

		started, ok := parsePBTime(inc.StartedAt)
		if !ok {
			continue
		}
		elapsedMin := int(now.Sub(started).Minutes())

		fired := inc.EscalationLevel
		for i := inc.EscalationLevel; i < len(levels); i++ {
			due := elapsedMin >= levels[i].AfterMinutes
			// The user's "escalate now" fires just the immediate next level early.
			if i == inc.EscalationLevel && inc.EscalateNow {
				due = true
			}
			if !due {
				break // levels are time-ordered — stop at the first not-yet-due
			}
			fireEscalationLevel(pbClient, cfg, inc, monitor, levels, i)
			fired = i + 1
		}

		// Persist progress, and always clear a one-shot "escalate now" once seen.
		if fired > inc.EscalationLevel || inc.EscalateNow {
			if err := pbClient.UpdateIncidentEscalation(inc.Id, fired, inc.EscalateNow); err != nil {
				log.Printf("Alerts: [%s] failed to update escalation: %s", inc.Id, err)
			}
		}
	}
}

// escalationLevels resolves a monitor's policy (or the default) into ordered
// levels with concrete channel records. Unknown/disabled channel ids are dropped.
func escalationLevels(pbClient *pb.Client, monitor models.Monitor, allChannels []models.AlertChannel) []resolvedLevel {
	if monitor.EscalationPolicy == "" {
		return []resolvedLevel{{AfterMinutes: 0, Channels: allChannels}}
	}
	policy, err := pbClient.GetEscalationPolicy(monitor.EscalationPolicy)
	if err != nil {
		log.Printf("Alerts: [%s] cannot load escalation policy %s, using default: %s", monitor.Id, monitor.EscalationPolicy, err)
		return []resolvedLevel{{AfterMinutes: 0, Channels: allChannels}}
	}
	byId := make(map[string]models.AlertChannel, len(allChannels))
	for _, ch := range allChannels {
		byId[ch.Id] = ch
	}
	levels := make([]resolvedLevel, 0, len(policy.Steps))
	for _, s := range policy.Steps {
		var chans []models.AlertChannel
		for _, id := range s.Channels {
			if ch, ok := byId[id]; ok {
				chans = append(chans, ch)
			}
		}
		levels = append(levels, resolvedLevel{AfterMinutes: s.AfterMinutes, Channels: chans})
	}
	return levels
}

// notifiedChannels returns the channels that were actually paged during an
// incident — the union of channels across the escalation levels that fired — so a
// recovery reaches exactly those, not every channel the user owns. A monitor with
// no policy resolves to a single level containing all channels, so its recovery
// still goes everywhere (unchanged).
func notifiedChannels(pbClient *pb.Client, monitor models.Monitor, allChannels []models.AlertChannel, escalationLevel int) []models.AlertChannel {
	return channelsThroughLevel(escalationLevels(pbClient, monitor, allChannels), escalationLevel)
}

// channelsThroughLevel is the de-duplicated union of channels across the levels
// that fired: levels[0..fired-1], where fired is clamped to at least 1 (level 0
// always fires when an incident opens) and at most len(levels).
func channelsThroughLevel(levels []resolvedLevel, escalationLevel int) []models.AlertChannel {
	if len(levels) == 0 {
		return nil
	}
	fired := escalationLevel
	if fired < 1 {
		fired = 1
	}
	if fired > len(levels) {
		fired = len(levels)
	}
	seen := make(map[string]bool)
	var out []models.AlertChannel
	for i := 0; i < fired; i++ {
		for _, ch := range levels[i].Channels {
			if !seen[ch.Id] {
				seen[ch.Id] = true
				out = append(out, ch)
			}
		}
	}
	return out
}

// fireEscalationLevel dispatches one level and records it on the timeline + the
// per-channel delivery log.
func fireEscalationLevel(pbClient *pb.Client, cfg alertConfig, inc models.Incident, monitor models.Monitor, levels []resolvedLevel, i int) {
	multi := len(levels) > 1
	subject := fmt.Sprintf("[nabz] %s is DOWN", monitor.Name)
	if multi {
		subject = fmt.Sprintf("[nabz] %s is DOWN (escalation L%d)", monitor.Name, i+1)
	}
	bodyText := fmt.Sprintf("%s (%s) is down.\nCause: %s\nStarted: %s", monitor.Name, monitor.Target, inc.Cause, inc.StartedAt)
	payload := map[string]interface{}{
		"event":            "incident.opened",
		"incident_id":      inc.Id,
		"monitor":          monitor.Name,
		"monitor_id":       monitor.Id,
		"cause":            inc.Cause,
		"started_at":       inc.StartedAt,
		"escalation_level": i + 1,
	}

	results := dispatch(cfg, levels[i].Channels, subject, bodyText, payload)
	sent, note := summarize(results)
	evMsg := notifyEventMessage(sent, len(levels[i].Channels), note)
	if multi {
		evMsg = fmt.Sprintf("Escalation L%d — %s", i+1, evMsg)
	}
	if err := pbClient.CreateIncidentEvent(inc.Id, "notified", evMsg, "", ""); err != nil {
		log.Printf("Alerts: [%s] timeline(notified) failed: %s", inc.Id, err)
	}
	logChannelEvents(pbClient, results, "incident")
}

// recoveryWindow bounds which resolved incidents get a recovery alert, so that
// adding this feature (or a brief evaluator outage) doesn't re-announce a backlog
// of already-resolved incidents.
const recoveryWindow = 30 * time.Minute

// notifyRecoveries alerts a monitor's channels when a previously down-notified
// incident resolves, so users learn it's back up. Guarded by recovery_notified
// (fires once) and bounded to recently-resolved incidents.
func notifyRecoveries(pbClient *pb.Client, cfg alertConfig, now time.Time) {
	incidents, err := pbClient.GetUnrecoveredIncidents(now.Add(-recoveryWindow))
	if err != nil {
		log.Printf("Alerts: failed to list unrecovered incidents: %s", err)
		return
	}

	for _, inc := range incidents {
		monitor, err := pbClient.GetMonitor(inc.Monitor)
		if err != nil {
			log.Printf("Alerts: [%s] cannot load monitor, will retry: %s", inc.Monitor, err)
			continue
		}
		if inMaintenance(monitor, now) {
			continue // planned maintenance — hold the recovery alert until the window ends
		}
		channels, err := pbClient.ChannelsForMonitor(monitor)
		if err != nil {
			log.Printf("Alerts: [%s] cannot load channels, will retry: %s", inc.Monitor, err)
			continue
		}

		downtime := humanizeDowntime(inc.StartedAt, inc.ResolvedAt)
		subject := fmt.Sprintf("[nabz] %s is back UP", monitor.Name)
		bodyText := fmt.Sprintf("%s (%s) has recovered.\nDowntime: %s\nStarted: %s\nResolved: %s",
			monitor.Name, monitor.Target, downtime, inc.StartedAt, inc.ResolvedAt)
		payload := map[string]interface{}{
			"event":       "incident.resolved",
			"incident_id": inc.Id,
			"monitor":     monitor.Name,
			"monitor_id":  monitor.Id,
			"started_at":  inc.StartedAt,
			"resolved_at": inc.ResolvedAt,
			"downtime":    downtime,
		}

		// Recovery goes only to the channels that were actually paged for this
		// incident (the policy's fired levels), not every channel the user owns.
		recipients := notifiedChannels(pbClient, monitor, channels, inc.EscalationLevel)
		results := dispatch(cfg, recipients, subject, bodyText, payload)
		sent, note := summarize(results)
		evMsg := "Recovery — " + notifyEventMessage(sent, len(recipients), note)
		if err := pbClient.CreateIncidentEvent(inc.Id, "notified", evMsg, "", ""); err != nil {
			log.Printf("Alerts: [%s] timeline(recovery) failed: %s", inc.Id, err)
		}
		logChannelEvents(pbClient, results, "recovery")

		if err := pbClient.MarkIncidentRecoveryNotified(inc.Id); err != nil {
			log.Printf("Alerts: [%s] failed to mark recovery notified: %s", inc.Id, err)
		}
	}
}

// processTestAlerts drains queued "send test alert" requests from the web UI,
// delivering a clearly-labelled sample notification to the user's channels via
// the same path as real alerts, and records the outcome for the UI to show.
func processTestAlerts(pbClient *pb.Client, cfg alertConfig) {
	reqs, err := pbClient.GetPendingTestAlerts()
	if err != nil {
		log.Printf("Alerts: failed to list test alerts: %s", err)
		return
	}
	for _, r := range reqs {
		channels, err := pbClient.GetAlertChannels(r.User)
		if err != nil {
			log.Printf("Alerts: [test %s] cannot load channels, will retry: %s", r.Id, err)
			continue
		}
		// Scope to a single channel when requested (the per-row "Send test").
		if r.Channel != "" {
			var only []models.AlertChannel
			for _, ch := range channels {
				if ch.Id == r.Channel {
					only = append(only, ch)
					break
				}
			}
			channels = only
		}

		subject := "[nabz] Test alert"
		bodyText := "This is a test alert from nabz — your channel is working. No action needed."
		payload := map[string]interface{}{"event": "test", "test": true}

		results := dispatch(cfg, channels, subject, bodyText, payload)
		sent, note := summarize(results)
		result := notifyEventMessage(sent, len(channels), note)
		if err := pbClient.UpdateTestAlert(r.Id, "done", result); err != nil {
			log.Printf("Alerts: [test %s] failed to record result: %s", r.Id, err)
		}
		logChannelEvents(pbClient, results, "test")
	}
}

// notifyEventMessage renders the timeline "notified" line from a delivery result.
func notifyEventMessage(sent, total int, note string) string {
	var msg string
	switch {
	case total == 0:
		msg = "No alert channels configured"
	case sent == total:
		msg = fmt.Sprintf("Notified %d channel(s)", sent)
	case sent == 0:
		msg = fmt.Sprintf("Notification failed — 0 of %d channel(s) sent", total)
	default:
		msg = fmt.Sprintf("Notified %d of %d channel(s)", sent, total)
	}
	if note != "" {
		msg += " — " + note
	}
	return msg
}

// humanizeDowntime formats the gap between started_at and resolved_at (e.g. "3m12s").
func humanizeDowntime(startedAt, resolvedAt string) string {
	s, ok1 := parsePBTime(startedAt)
	e, ok2 := parsePBTime(resolvedAt)
	if !ok1 || !ok2 || !e.After(s) {
		return "unknown"
	}
	return e.Sub(s).Round(time.Second).String()
}

// deliveryResult is the per-channel outcome of a dispatch, used both to summarize
// for the incident timeline and to write the per-channel delivery log.
type deliveryResult struct {
	Channel models.AlertChannel
	Outcome string // "delivered" | "skipped" | "failed"
	Detail  string // reason (error / skip cause); "" when delivered
}

// dispatch delivers to each channel and returns the per-channel outcome.
func dispatch(cfg alertConfig, channels []models.AlertChannel, subject, body string, payload map[string]interface{}) []deliveryResult {
	results := make([]deliveryResult, 0, len(channels))
	for _, ch := range channels {
		r := deliveryResult{Channel: ch, Outcome: "delivered"}
		switch ch.Type {
		case "webhook":
			if err := sendWebhook(ch.Address(), payload); err != nil {
				log.Printf("Alerts: webhook to %s failed: %s", ch.Address(), err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		case "slack":
			if err := sendSlack(ch.Address(), subject, body); err != nil {
				log.Printf("Alerts: slack to %s failed: %s", ch.Address(), err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		case "discord":
			if err := sendDiscord(ch.Address(), subject, body); err != nil {
				log.Printf("Alerts: discord to %s failed: %s", ch.Address(), err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		case "telegram":
			botToken, chatID := telegramCreds(ch)
			if err := sendTelegram(botToken, chatID, subject, body); err != nil {
				log.Printf("Alerts: telegram to chat %s failed: %s", chatID, err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		case "pagerduty":
			// A resolved incident closes the PagerDuty incident; everything else
			// triggers. The incident id is the dedup key shared by trigger + resolve.
			action := "trigger"
			if payload["event"] == "incident.resolved" {
				action = "resolve"
			}
			dedupKey, _ := payload["incident_id"].(string)
			if err := sendPagerDuty(ch.Address(), subject, body, dedupKey, action); err != nil {
				log.Printf("Alerts: pagerduty failed: %s", err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		case "email":
			if !cfg.emailEnabled() {
				log.Printf("Alerts: email channel %s skipped (SMTP not configured)", ch.Address())
				r.Outcome, r.Detail = "skipped", "SMTP not configured"
			} else if err := sendEmail(cfg, ch.Address(), subject, body); err != nil {
				log.Printf("Alerts: email to %s failed: %s", ch.Address(), err)
				r.Outcome, r.Detail = "failed", err.Error()
			}
		default:
			log.Printf("Alerts: unknown channel type %q", ch.Type)
			r.Outcome, r.Detail = "failed", "unknown channel type"
		}
		results = append(results, r)
	}
	return results
}

// summarize reduces per-channel results to (sent, note) for the incident timeline
// and test-result message.
func summarize(results []deliveryResult) (int, string) {
	sent, smtpSkipped, failed := 0, 0, 0
	for _, r := range results {
		switch r.Outcome {
		case "delivered":
			sent++
		case "skipped":
			smtpSkipped++
		default:
			failed++
		}
	}
	var notes []string
	if smtpSkipped > 0 {
		notes = append(notes, fmt.Sprintf("%d email skipped (SMTP not configured)", smtpSkipped))
	}
	if failed > 0 {
		notes = append(notes, fmt.Sprintf("%d failed to send", failed))
	}
	return sent, strings.Join(notes, ", ")
}

// logChannelEvents writes one delivery-log row per channel result.
func logChannelEvents(pbClient *pb.Client, results []deliveryResult, kind string) {
	for _, r := range results {
		if err := pbClient.CreateChannelEvent(r.Channel.Id, kind, r.Outcome, r.Detail); err != nil {
			log.Printf("Alerts: channel_event log failed for %s: %s", r.Channel.Id, err)
		}
	}
}

// deadmanCheck fires an ops alert the first time a zone's heartbeat goes stale,
// and clears the state when it recovers (so it only alerts on transitions).
func deadmanCheck(pbClient *pb.Client, cfg alertConfig, silent map[string]bool, store alertStateStore, now time.Time) {
	zones, err := pbClient.GetZoneStats()
	if err != nil {
		log.Printf("Dead-man: failed to read zone stats: %s", err)
		return
	}

	for _, z := range zones {
		stale := isHeartbeatStale(z.Updated, now, cfg.deadman)
		switch {
		case stale && !silent[z.Zone]:
			log.Printf("ALERT: zone %q is silent (last heartbeat %s)", z.Zone, z.Updated)
			// Optional, and usually unset: a silent zone also shows as degraded on
			// /api/health, which the external uptime monitor already watches. This
			// path just gets there faster (DEADMAN_SECONDS vs the check interval).
			// Blast radius alongside the event (#328): how many monitors just lost
			// a voting zone, and how many of those are now down to nothing. Without
			// it the operator sees "a zone is quiet" and has to go and work out
			// what that cost, at the moment they least want to.
			weakened, unjudged := zoneBlastRadius(pbClient, z.Zone)
			log.Printf("Dead-man: zone %q outage weakens %d monitor(s); %d now have no reporting zone at all",
				z.Zone, weakened, unjudged)
			if cfg.opsWebhookURL != "" {
				payload := map[string]interface{}{
					"event": "zone.silent", "zone": z.Zone, "last_heartbeat": z.Updated,
					"monitors_weakened": weakened, "monitors_unjudged": unjudged,
				}
				if err := sendWebhook(cfg.opsWebhookURL, payload); err != nil {
					log.Printf("Dead-man: ops webhook failed: %s", err)
				}
			}
			silent[z.Zone] = true
			store.Put(stateKey(stateKindZoneSilent, z.Zone), "1")
		case !stale && silent[z.Zone]:
			log.Printf("Dead-man: zone %q recovered", z.Zone)
			silent[z.Zone] = false
			store.Delete(stateKey(stateKindZoneSilent, z.Zone))
		}
	}
}

// certNeedsAlert reports whether a certificate expiring at expiresAt should warn
// now — i.e. it's within the warning window (including already expired). A zero
// time means unknown/not-HTTPS and never warns.
func certNeedsAlert(expiresAt time.Time, now time.Time, warn time.Duration) bool {
	if expiresAt.IsZero() {
		return false
	}
	return expiresAt.Sub(now) <= warn
}

// certExpiryCheck warns a monitor's channels when its captured TLS cert is within
// the configured expiry window. Dedup is keyed by the expiry we last warned for,
// so a renewed cert (new expiry) can warn again but a still-expiring one won't
// spam every tick. That key is persisted (#327): a cert stays inside the warning
// window for a fortnight, so without it every deploy re-warned.
func certExpiryCheck(pbClient *pb.Client, cfg alertConfig, alerted map[string]time.Time, store alertStateStore, now time.Time) {
	monitors, err := pbClient.ListMonitorsWithCert()
	if err != nil {
		log.Printf("Cert: failed to list monitors with cert: %s", err)
		return
	}
	for _, m := range monitors {
		expiresAt, ok := parsePBTime(m.CertExpiresAt)
		if !ok || !certNeedsAlert(expiresAt, now, cfg.certWarn) {
			continue
		}
		if prev, seen := alerted[m.Id]; seen && prev.Equal(expiresAt) {
			continue // already warned for this exact certificate
		}
		channels, err := pbClient.ChannelsForMonitor(m)
		if err != nil {
			log.Printf("Cert: [%s] cannot load channels, will retry: %s", m.Id, err)
			continue
		}
		days := int(expiresAt.Sub(now).Hours() / 24)
		when := fmt.Sprintf("in %d day(s)", days)
		if days < 0 {
			when = "already (expired)"
		}
		subject := fmt.Sprintf("[nabz] %s TLS certificate expires soon", m.Name)
		body := fmt.Sprintf("%s (%s) TLS certificate expires %s — on %s.", m.Name, m.Target, when, expiresAt.UTC().Format("2006-01-02"))
		payload := map[string]interface{}{
			"event":           "cert.expiring",
			"monitor":         m.Name,
			"monitor_id":      m.Id,
			"cert_expires_at": expiresAt.UTC().Format(time.RFC3339),
			"days_remaining":  days,
		}
		results := dispatch(cfg, channels, subject, body, payload)
		sent, _ := summarize(results)
		log.Printf("[%s] cert-expiry warning to %d/%d channel(s) (expires %s)", m.Id, sent, len(channels), expiresAt.UTC().Format("2006-01-02"))
		logChannelEvents(pbClient, results, "cert")
		alerted[m.Id] = expiresAt
		store.Put(stateKey(stateKindCert, m.Id), expiresAt.UTC().Format(time.RFC3339))
	}
}

func isHeartbeatStale(updated string, now time.Time, threshold time.Duration) bool {
	t, ok := parsePBTime(updated)
	if !ok {
		return true
	}
	return now.Sub(t) > threshold
}

// httpErrDetail builds a concise error for a failed provider API call, pulling the
// human-readable reason out of the response body (where Telegram/Discord/PagerDuty
// put it — e.g. "chat not found") so the delivery log says WHY, not just a
// bare status code.
func httpErrDetail(provider string, res utils.HTTPResult) error {
	reason := strings.TrimSpace(string(res.Body))
	// Common JSON error shapes: Telegram {description}, Discord {message},
	// generic {error}.
	var j map[string]interface{}
	if json.Unmarshal(res.Body, &j) == nil {
		for _, k := range []string{"description", "message", "error"} {
			if v, ok := j[k].(string); ok && strings.TrimSpace(v) != "" {
				reason = strings.TrimSpace(v)
				break
			}
		}
	}
	if len(reason) > 200 {
		reason = reason[:200]
	}
	if reason == "" {
		return fmt.Errorf("%s returned status %d", provider, res.StatusCode)
	}
	return fmt.Errorf("%s returned status %d: %s", provider, res.StatusCode, reason)
}

func sendWebhook(target string, payload map[string]interface{}) error {
	body, _ := json.Marshal(payload)
	res, err := utils.DoRequest("POST", target, body, "")
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return httpErrDetail("webhook", res)
	}
	return nil
}

// sendSlack posts a message to a Slack incoming webhook (the target URL), using
// Slack's { "text": ... } payload with the subject bolded (mrkdwn).
func sendSlack(target, subject, body string) error {
	payload, _ := json.Marshal(map[string]interface{}{
		"text": fmt.Sprintf("*%s*\n%s", subject, body),
	})
	res, err := utils.DoRequest("POST", target, payload, "")
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return httpErrDetail("slack", res)
	}
	return nil
}

// sendDiscord posts to a Discord channel webhook (the target URL) using
// Discord's { "content": ... } payload with the subject bolded (Markdown).
func sendDiscord(target, subject, body string) error {
	payload, _ := json.Marshal(map[string]interface{}{
		"content": fmt.Sprintf("**%s**\n%s", subject, body),
	})
	res, err := utils.DoRequest("POST", target, payload, "")
	if err != nil {
		return err
	}
	// Discord returns 204 No Content on success.
	if res.StatusCode >= 300 {
		return httpErrDetail("discord", res)
	}
	return nil
}

// telegramCreds resolves a Telegram channel's bot token and chat id, preferring
// the structured config and falling back to a legacy "botToken:chatId" target.
func telegramCreds(ch models.AlertChannel) (botToken, chatID string) {
	if ch.Config.BotToken != "" || ch.Config.ChatID != "" {
		return ch.Config.BotToken, ch.Config.ChatID
	}
	botToken, chatID, _ = parseTelegramTarget(ch.Target)
	return botToken, chatID
}

// parseTelegramTarget splits a legacy "botToken:chatId" target into its parts. The
// bot token is "<id>:<hash>" (it contains one colon) and a chat id never contains
// a colon, so the LAST colon is the boundary between the two.
func parseTelegramTarget(target string) (botToken, chatID string, err error) {
	i := strings.LastIndex(target, ":")
	if i <= 0 || i == len(target)-1 {
		return "", "", fmt.Errorf("invalid telegram target, expected botToken:chatId")
	}
	return target[:i], target[i+1:], nil
}

// sendTelegram sends a Bot API message to the given chat.
func sendTelegram(botToken, chatID, subject, body string) error {
	if botToken == "" || chatID == "" {
		return fmt.Errorf("telegram channel missing bot token or chat id")
	}
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", botToken)
	payload, _ := json.Marshal(map[string]interface{}{
		"chat_id": chatID,
		"text":    fmt.Sprintf("%s\n%s", subject, body),
	})
	res, err := utils.DoRequest("POST", url, payload, "")
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return httpErrDetail("telegram", res)
	}
	return nil
}

// pagerDutyEvent builds the Events API v2 body for a trigger or resolve. `action`
// is "trigger" or "resolve"; `dedupKey` ties a resolve back to the trigger for the
// same incident (the incident id), so a recovery closes the PagerDuty incident
// instead of leaving it open, and repeated triggers with the same key (escalation
// levels) update one incident rather than opening a new one each time. A resolve
// carries only routing_key + dedup_key + event_action; the payload block is
// required for a trigger and ignored otherwise, so it's included only then.
func pagerDutyEvent(routingKey, subject, body, dedupKey, action string) map[string]interface{} {
	if action == "" {
		action = "trigger"
	}
	event := map[string]interface{}{
		"routing_key":  routingKey,
		"event_action": action,
	}
	if dedupKey != "" {
		event["dedup_key"] = dedupKey
	}
	if action == "trigger" {
		event["payload"] = map[string]interface{}{
			"summary":        subject,
			"source":         "nabz",
			"severity":       "error",
			"custom_details": map[string]interface{}{"details": body},
		}
	}
	return event
}

// sendPagerDuty sends a trigger or resolve to PagerDuty's Events API v2. The target
// is the integration routing key.
func sendPagerDuty(routingKey, subject, body, dedupKey, action string) error {
	payload, _ := json.Marshal(pagerDutyEvent(routingKey, subject, body, dedupKey, action))
	res, err := utils.DoRequest("POST", "https://events.pagerduty.com/v2/enqueue", payload, "")
	if err != nil {
		return err
	}
	// The Events API returns 202 Accepted on success.
	if res.StatusCode >= 300 {
		return httpErrDetail("pagerduty", res)
	}
	return nil
}

func sendEmail(cfg alertConfig, to, subject, body string) error {
	addr := cfg.smtpHost + ":" + cfg.smtpPort
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s",
		cfg.smtpFrom, to, subject, body)

	var auth smtp.Auth
	if cfg.smtpUser != "" {
		auth = smtp.PlainAuth("", cfg.smtpUser, cfg.smtpPass, cfg.smtpHost)
	}
	return smtp.SendMail(addr, auth, cfg.smtpFrom, []string{to}, []byte(msg))
}

// zoneBlastRadius counts what a zone going quiet costs, from what the evaluator
// last recorded on each monitor (#328): how many monitors had this zone among the
// ones they were voting with, and how many of those are left with none.
//
// Read from the persisted consensus fields rather than recomputed, so the number
// describes the decisions actually made rather than a second, drifting estimate.
func zoneBlastRadius(pbClient *pb.Client, zone string) (weakened, unjudged int) {
	monitors, err := pbClient.ListMonitorsForEval()
	if err != nil {
		return 0, 0
	}
	for _, m := range monitors {
		if !slices.Contains(splitCSV(m.ConsensusZones), zone) {
			continue
		}
		weakened++
		fresh := splitCSV(m.ConsensusFresh)
		if len(fresh) == 0 || (len(fresh) == 1 && fresh[0] == zone) {
			unjudged++
		}
	}
	return weakened, unjudged
}

// splitCSV splits the comma-separated consensus fields, treating empty as none
// (strings.Split would hand back a one-element slice containing "").
func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}
