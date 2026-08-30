package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
	"monitors/corelib/utils"
)

const (
	evalInterval         = 10 * time.Second
	consecutiveThreshold = 2
	defaultInterval      = 60
	minFreshWindowSecs   = 30
)

func main() {
	var healthCheck bool
	flag.BoolVar(&healthCheck, "health-check", false, "Flag to check health.")
	flag.Parse()

	config := utils.LoadConfig()

	if healthCheck {
		// Health probe: fail fast, never retry.
		c, err := pb.NewClient(config)
		if err != nil {
			log.Printf("Health check failed: %s", err)
			os.Exit(1)
		}
		if err := c.Ping(); err != nil {
			log.Printf("Health check failed: %s", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	// Retry auth with backoff instead of crash-looping under Docker restart when
	// PocketBase is briefly down or rate-limiting.
	pbClient := pb.NewClientWithRetry(config)

	alertCfg := loadAlertConfig()

	startHealthServer(pbClient, alertCfg.deadman)

	silentZones := map[string]bool{}
	certAlerted := map[string]time.Time{}
	latency := map[string]*latencyState{}
	domainAlerted := map[string]time.Time{}
	// Monitors whose every assigned zone has gone quiet (#328), so the owner is
	// told once rather than on every restart.
	unjudged := map[string]bool{}

	// Alert-transition state persists in PocketBase (#327). Without it every
	// restart — and remote-deploy.sh restarts the evaluator on every deploy —
	// re-fired conditions that were still true and dropped pending recoveries.
	alertState := newPBAlertState(pbClient)
	hydrate(alertState, silentZones, certAlerted, domainAlerted, latency, unjudged)
	var domainRefresh domainRefreshState
	// Transition tracking for the check-in-path hold, so it is announced once
	// rather than every pass.
	var pathState bool
	var rollups rollupState

	// External dead-man's switch (optional). Our own dead-man's switch runs
	// inside this process, so it can never report this process dying.
	pinger := newHealthPinger(healthPingURL())
	if pinger != nil {
		log.Printf("Healthcheck ping enabled (at most every %s)", pingInterval)
	}

	log.Println("Evaluator ready.")
	for {
		now := time.Now().UTC()
		// Liveness heartbeat: the web /api/health reads this to tell whether the
		// evaluator is alive. Written first each tick so a slow evaluation pass
		// doesn't delay the beat.
		if err := pbClient.UpsertZoneStats(pb.EvaluatorZone, config.HostName, 0, 0, 1); err != nil {
			log.Printf("Heartbeat: failed to write evaluator liveness: %s", err)
		}
		// Read once per pass, not per monitor: one row, and every heartbeat
		// monitor in this pass must be judged against the same verdict.
		pathDown := checkInPathState(pbClient, alertCfg, &pathState, now)
		runOnce(pbClient, alertCfg, pathDown, unjudged, alertState)
		processEscalations(pbClient, alertCfg, now)
		notifyRecoveries(pbClient, alertCfg, now)
		processTestAlerts(pbClient, alertCfg)
		deadmanCheck(pbClient, alertCfg, silentZones, alertState, now)
		certExpiryCheck(pbClient, alertCfg, certAlerted, alertState, now)
		domainRefreshCheck(pbClient, &domainRefresh, now)
		domainExpiryCheck(pbClient, alertCfg, domainAlerted, alertState, now)
		latencyCheck(pbClient, alertCfg, latency, alertState, now)
		maybeRollupAndPurge(pbClient, &rollups, now)
		// Last: a ping means a full pass completed, not merely that the process
		// is running.
		pinger.ping(now)
		time.Sleep(evalInterval)
	}
}

// checkInPathState decides whether heartbeat verdicts are trustworthy right now,
// and makes the answer loud when it changes (#339). Silently not-alerting is the
// same failure class as false-alerting, so a transition either way goes to the
// log and the ops webhook, and /api/health carries the `web` row continuously.
func checkInPathState(pbClient *pb.Client, cfg alertConfig, prev *bool, now time.Time) bool {
	zones, err := pbClient.GetZoneStats()
	if err != nil {
		// Cannot tell: trust the path rather than start holding everything on a
		// transient read error.
		return false
	}
	down, age, seen := checkInPathDown(zones, cfg.webBeat, now)
	if !seen {
		return false
	}
	if down != *prev {
		if down {
			log.Printf("ALERT: check-in path looks broken (web liveness %s stale) — HOLDING heartbeat incidents", age.Round(time.Second))
		} else {
			log.Printf("check-in path recovered — heartbeat incidents resume")
		}
		if cfg.opsWebhookURL != "" {
			payload := map[string]interface{}{
				"event": "checkin_path.suppression", "holding": down,
				"web_liveness_age_seconds": int(age.Seconds()),
			}
			if err := sendWebhook(cfg.opsWebhookURL, payload); err != nil {
				log.Printf("check-in path: ops webhook failed: %s", err)
			}
		}
		*prev = down
	}
	return down
}

func runOnce(pbClient *pb.Client, cfg alertConfig, pathDown bool,
	unjudged map[string]bool, store alertStateStore) {
	monitors, err := pbClient.ListMonitorsForEval()
	if err != nil {
		log.Printf("Failed to list monitors: %s", err)
		return
	}
	for _, monitor := range monitors {
		if err := evaluateMonitor(pbClient, cfg, monitor, pathDown, unjudged, store, time.Now().UTC()); err != nil {
			log.Printf("[%s] evaluation failed: %s", monitor.Id, err)
		}
	}
}

func evaluateMonitor(pbClient *pb.Client, cfg alertConfig, monitor models.Monitor, pathDown bool,
	unjudged map[string]bool, store alertStateStore, now time.Time) error {
	// Heartbeat monitors aren't probed — they're judged by their last check-in.
	if monitor.Type == "heartbeat" {
		return evaluateHeartbeat(pbClient, monitor, pathDown, now)
	}

	// Same clamp the worker schedules on (#319). Deriving these windows from the
	// RAW stored interval would judge a clamped legacy monitor against a window
	// narrower than its actual probe cadence — its checks would always read as
	// stale, so it could never reach a verdict.
	interval := models.EffectiveInterval(monitor.Interval)
	freshWindow, lookback := evalWindows(interval)

	checks, err := pbClient.GetChecksSince(monitor.Id, now.Add(-lookback))
	if err != nil {
		return err
	}

	// Group checks by zone, preserving oldest-first order.
	byZone := map[string][]pb.CheckRecord{}
	order := []string{}
	for _, c := range checks {
		if _, seen := byZone[c.Zone]; !seen {
			order = append(order, c.Zone)
		}
		byZone[c.Zone] = append(byZone[c.Zone], c)
	}

	// Participating zones: the monitor's assigned zones, or whichever zones have
	// reported when it runs everywhere (zones == []).
	participating := monitor.Zones
	if len(participating) == 0 {
		participating = order
	}

	zoneEvals := make([]ZoneEval, 0, len(participating))
	downZones := []string{}
	for _, zone := range participating {
		ze := buildZoneEval(byZone[zone], now, freshWindow)
		zoneEvals = append(zoneEvals, ze)
		if ze.Fresh && !ze.Up {
			downZones = append(downZones, zone)
		}
	}

	status := decide(zoneEvals, consecutiveThreshold)

	if string(status) != monitor.Status {
		if err := pbClient.UpdateMonitorStatus(monitor.Id, string(status)); err != nil {
			return err
		}
		log.Printf("[%s] status %q -> %q", monitor.Id, monitor.Status, status)
	}

	// Record what the vote was actually taken on (#328). Only the evaluator knows
	// this: freshness comes from the monitor's effective interval, so a UI that
	// re-derived it would drift from the decision that was really made and end up
	// showing a reassuring number that is wrong.
	freshZones := make([]string, 0, len(participating))
	for i, ze := range zoneEvals {
		if ze.Fresh {
			freshZones = append(freshZones, participating[i])
		}
	}
	consensusUnjudgedCheck(pbClient, cfg, monitor, participating, freshZones, unjudged, store, now)

	zonesCSV, freshCSV := strings.Join(participating, ","), strings.Join(freshZones, ",")
	if zonesCSV != monitor.ConsensusZones || freshCSV != monitor.ConsensusFresh {
		if err := pbClient.UpdateMonitorConsensus(monitor.Id, zonesCSV, freshCSV); err != nil {
			// Never fatal: this is reporting, and losing it must not stop a verdict.
			log.Printf("[%s] could not record consensus zones: %s", monitor.Id, err)
		}
	}

	return reconcileIncident(pbClient, monitor, status, downZones, now)
}

// unjudgedKey namespaces the "not being checked at all" flag in alert_state.
func unjudgedKey(monitorID string) string { return stateKey(stateKindUnjudged, monitorID) }

// consensusUnjudgedCheck alerts the OWNER when every assigned zone has gone
// quiet, so the monitor is not being checked at all and its status is frozen at
// pending (#328).
//
// Deliberately not fired when the count merely drops — 2 zones to 1 fans one zone
// outage out to every monitor pinned to it, which is a notification storm about
// something that is not an outage of the user's service. The status is still
// being computed, just by a weaker rule, and that belongs in the UI. Reaching
// ZERO is different in kind: it is the product silently not doing the one thing
// it was asked to do, and it is rare and bounded, so it cannot spam.
//
// Transition-tracked through the same persisted store as every other alerter
// (#327), so a restart does not re-fire it.
func consensusUnjudgedCheck(pbClient *pb.Client, cfg alertConfig, monitor models.Monitor,
	participating, freshZones []string, unjudged map[string]bool, store alertStateStore, now time.Time) {
	// Only meaningful for a monitor that names its zones. One that runs
	// everywhere has no promise to break: "no zone reported" is indistinguishable
	// from "no zone is assigned yet".
	if len(monitor.Zones) == 0 || inMaintenance(monitor, now) {
		return
	}
	key := unjudgedKey(monitor.Id)
	switch {
	case len(freshZones) == 0 && !unjudged[monitor.Id]:
		unjudged[monitor.Id] = true
		store.Put(key, "1")
		channels, err := pbClient.ChannelsForMonitor(monitor)
		if err != nil {
			log.Printf("Consensus: [%s] cannot load channels, will retry: %s", monitor.Id, err)
			return
		}
		subject := fmt.Sprintf("[nabz] %s is not being checked", monitor.Name)
		body := fmt.Sprintf(
			"%s (%s) is assigned to %s, and none of those zones has reported recently. "+
				"It is not being checked at all and its status is frozen — this is not an "+
				"outage of your service, it is nabz unable to observe it.",
			monitor.Name, monitor.Target, strings.Join(participating, ", "))
		payload := map[string]interface{}{
			"event": "monitor.unjudged", "monitor": monitor.Name, "monitor_id": monitor.Id,
			"assigned_zones": participating,
		}
		results := dispatch(cfg, channels, subject, body, payload)
		sent, _ := summarize(results)
		log.Printf("ALERT: [%s] no assigned zone is reporting — notified %d/%d channel(s)", monitor.Id, sent, len(channels))
	case len(freshZones) > 0 && unjudged[monitor.Id]:
		unjudged[monitor.Id] = false
		store.Delete(key)
		log.Printf("[%s] a zone is reporting again", monitor.Id)
	}
}

// evalWindows derives the two time windows a verdict is computed over from the
// monitor's EFFECTIVE interval (never the raw stored one): how recent a check
// must be to count as fresh, and how far back to read to see a consecutive-
// failure run.
func evalWindows(interval int) (freshWindow, lookback time.Duration) {
	freshWindow = time.Duration(maxInt(interval*3, minFreshWindowSecs)) * time.Second
	lookback = time.Duration(maxInt(interval*(consecutiveThreshold+2), int(freshWindow.Seconds()))) * time.Second
	return freshWindow, lookback
}

// inMaintenance reports whether now falls inside any of the monitor's planned
// maintenance windows. While a window is active, alerts are suppressed (checks
// still run and status is still updated).
func inMaintenance(monitor models.Monitor, now time.Time) bool {
	for _, w := range monitor.Config.MaintenanceWindows {
		start, ok1 := parsePBTime(w.Start)
		end, ok2 := parsePBTime(w.End)
		if ok1 && ok2 && !now.Before(start) && now.Before(end) {
			return true
		}
	}
	return false
}

func buildZoneEval(zoneChecks []pb.CheckRecord, now time.Time, freshWindow time.Duration) ZoneEval {
	if len(zoneChecks) == 0 {
		return ZoneEval{Fresh: false}
	}

	latest := zoneChecks[len(zoneChecks)-1]
	if isBlockedStatus(latest.StatusCode) {
		// Rate-limited / blocked (429/403): the target refused to let us judge
		// it — neither up nor down. Abstain by leaving the zone out of the fresh
		// set, so it can't open an incident, page, or (falsely) resolve one.
		return ZoneEval{Fresh: false}
	}
	checkedAt, ok := parsePBTime(latest.CheckedAt)
	fresh := ok && !checkedAt.Before(now.Add(-freshWindow))

	trailingDown := 0
	for i := len(zoneChecks) - 1; i >= 0; i-- {
		c := zoneChecks[i]
		// A blocked check breaks the consecutive-down streak — a 429/403 must
		// never count toward the single-zone "down" verdict.
		if c.Up || isBlockedStatus(c.StatusCode) {
			break
		}
		trailingDown++
	}

	return ZoneEval{Fresh: fresh, Up: latest.Up, TrailingDown: trailingDown}
}

func reconcileIncident(pbClient *pb.Client, monitor models.Monitor, status Status, downZones []string, now time.Time) error {
	monitorId := monitor.Id
	latest, err := pbClient.GetLatestIncident(monitorId)
	if err != nil {
		return err
	}
	open := latest != nil && latest.IsOpen()

	switch {
	case status == StatusDown && !open:
		// Suppress during planned maintenance: don't open an incident (so no
		// down alert, escalation, or recovery follows) while a window is active.
		if inMaintenance(monitor, now) {
			log.Printf("[%s] down during a maintenance window — incident suppressed", monitorId)
			return nil
		}
		cause := "down"
		if len(downZones) > 0 {
			cause = "down in " + strings.Join(downZones, ", ")
		}
		id, err := pbClient.CreateIncident(monitorId, cause, now)
		if err != nil {
			return err
		}
		log.Printf("[%s] incident opened: %s", monitorId, cause)
		// Timeline: opening event + one per zone that was detected down.
		if err := pbClient.CreateIncidentEvent(id, "opened", "Incident opened — "+cause, "", ""); err != nil {
			log.Printf("[%s] timeline(opened) failed: %s", monitorId, err)
		}
		for _, z := range downZones {
			if err := pbClient.CreateIncidentEvent(id, "zone_down", "Detected down", z, ""); err != nil {
				log.Printf("[%s] timeline(zone_down %s) failed: %s", monitorId, z, err)
			}
		}
	case status == StatusUp && open:
		if err := pbClient.ResolveIncident(latest.Id, now); err != nil {
			return err
		}
		log.Printf("[%s] incident resolved", monitorId)
		if err := pbClient.CreateIncidentEvent(latest.Id, "resolved", "Recovered — monitor is back up", "", ""); err != nil {
			log.Printf("[%s] timeline(resolved) failed: %s", monitorId, err)
		}
	}
	return nil
}

// parsePBTime parses the timestamp formats PocketBase / the worker emit.
func parsePBTime(s string) (time.Time, bool) {
	layouts := []string{
		"2006-01-02 15:04:05.000Z",
		"2006-01-02 15:04:05Z",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
