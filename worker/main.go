package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
	"monitors/corelib/utils"

	"monitors/worker/services"
)

const (
	defaultZone = "default"

	// The deployed timings. Every one of them is also the DEFAULT for its
	// environment variable below, so an unset environment behaves exactly as the
	// fleet does today.
	//
	// defaultReconcileInterval — how often the worker re-syncs its due-set against
	// PocketBase: new and re-enabled monitors in, disabled/deleted/moved-away ones
	// out.
	defaultReconcileInterval = 30 * time.Second
	defaultStatsInterval     = 10 * time.Second
	// defaultHeartbeatInterval — how often this worker records itself as alive in
	// its zone and re-reads the zone's roster.
	defaultHeartbeatInterval = 10 * time.Second
	// defaultRosterTTL — how long a worker counts as alive after its last beat,
	// four missed beats. Takeover after a worker dies is roughly this plus the
	// immediate reconcile a roster change triggers, which is the ~1 minute the
	// design targets. Judged against PocketBase's clock, never a local one.
	defaultRosterTTL = 45 * time.Second

	idlePollBackoff = 1 * time.Second
	defaultInterval = 60
	// defaultConcurrency is how many checks run at once when WORKER_CONCURRENCY
	// is unset. Checks are network-bound and each is capped at checkTimeout, so
	// the useful number is "enough that one slow target cannot stall the zone",
	// not a function of CPU count. Eight keeps a zone responsive while staying
	// far below anything PocketBase would notice.
	defaultConcurrency = 8

	// The anonymous "try it" free zone (#270): a worker with REGION_NAME=free runs
	// the isolated anon_monitors pipeline instead of the real one.
	freeZone            = "free"
	anonMinInterval     = 300 // 5 min floor for anon checks
	anonTTL             = time.Hour
	anonCleanupInterval = 5 * time.Minute
	anonCleanupCap      = 500
)

// The timings in force for this process. Written once by loadTimings before any
// loop starts and only read afterwards, which is what makes plain variables safe
// here.
//
// They exist as variables rather than constants so a test stack can run the same
// code at a tempo a test can actually watch: the multi-worker scenarios spend
// almost all of their time waiting for a 45-second TTL to expire, four times
// over. Production leaves them unset and gets the constants above.
var (
	reconcileInterval = defaultReconcileInterval
	statsInterval     = defaultStatsInterval
	heartbeatInterval = defaultHeartbeatInterval
	rosterTTL         = defaultRosterTTL
	// zoneStatsStaleAfter is when a worker that is NOT the elected stats writer
	// starts publishing anyway: long enough that the elected writer is genuinely
	// absent rather than slow, short enough to stay under the 30s at which the
	// dashboard calls a zone stale.
	zoneStatsStaleAfter = 3 * defaultStatsInterval
)

// loadTimings reads the timing overrides and checks the relationships between
// them, because those relationships are what the design rests on and a plausible
// set of individually-sane numbers can still be wrong together.
//
// It returns an error rather than logging a warning: a worker running with a TTL
// shorter than its own heartbeat would drop itself out of the roster between
// beats and hand its monitors round in a circle, which is far harder to diagnose
// from the outside than a refusal to start.
// canary is built by loadTimings, from WORKER_CANARY_URLS.
var canary *services.Canary

func loadTimings() error {
	var err error
	if heartbeatInterval, err = envDuration("WORKER_HEARTBEAT_INTERVAL", defaultHeartbeatInterval); err != nil {
		return err
	}
	if reconcileInterval, err = envDuration("WORKER_RECONCILE_INTERVAL", defaultReconcileInterval); err != nil {
		return err
	}
	if statsInterval, err = envDuration("WORKER_STATS_INTERVAL", defaultStatsInterval); err != nil {
		return err
	}
	if rosterTTL, err = envDuration("WORKER_ROSTER_TTL", defaultRosterTTL); err != nil {
		return err
	}
	zoneStatsStaleAfter = 3 * statsInterval
	// Is-it-us probes for failed checks (#598). Unset: the defaults; "off": none.
	canary = services.NewCanary(services.ParseCanaryURLs(os.Getenv("WORKER_CANARY_URLS")))

	// A worker must survive missing a beat or two; at less than twice the
	// interval a single slow round trip to PocketBase unschedules it.
	if rosterTTL < 2*heartbeatInterval {
		return fmt.Errorf("WORKER_ROSTER_TTL (%s) must be at least twice WORKER_HEARTBEAT_INTERVAL (%s), or a worker drops out of the roster between its own beats",
			rosterTTL, heartbeatInterval)
	}
	// If the row only goes stale after the writer has already left the roster,
	// the fallback never fires while it is needed and a zone with healthy workers
	// reads as dead.
	if zoneStatsStaleAfter >= rosterTTL {
		return fmt.Errorf("WORKER_STATS_INTERVAL (%s) is too large for WORKER_ROSTER_TTL (%s): the stats row would go stale after %s, by which time the elected writer has already dropped out and the fallback is pointless",
			statsInterval, rosterTTL, zoneStatsStaleAfter)
	}
	return nil
}

// envDuration reads a whole number of SECONDS. Seconds because every one of
// these is an operational tempo, not a latency, and "45" is harder to typo than
// "45s".
func envDuration(name string, def time.Duration) (time.Duration, error) {
	raw := utils.GetEnv(name, "")
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a whole number of seconds, got %q", name, raw)
	}
	if n <= 0 {
		return 0, fmt.Errorf("%s must be greater than zero, got %d", name, n)
	}
	return time.Duration(n) * time.Second, nil
}

func main() {
	var healthCheck bool
	flag.BoolVar(&healthCheck, "health-check", false, "Flag to check health.")
	flag.Parse()

	config := utils.LoadConfig()

	if err := loadTimings(); err != nil {
		log.Fatalf("Worker timings: %s", err)
	}

	zone := defaultZone
	if config.Region != nil && config.Region.Name != "" {
		zone = config.Region.Name
	}

	// Ops identity, distinct from the zone: the zone is the shard key written to
	// checks.zone, while this only ever appears in logs, the health payload and
	// zone_stats.worker. Hostname is already unique per container.
	workerId := config.HostName
	if config.Worker != nil && config.Worker.Id != "" {
		workerId = config.Worker.Id
	}

	concurrency := defaultConcurrency
	if config.Worker != nil && config.Worker.Concurrency > 0 {
		concurrency = config.Worker.Concurrency
	}

	if healthCheck {
		// Health probe: fail fast, never retry. PocketBase is the worker's only
		// dependency now that the schedule lives in the process.
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

	// Normal startup: retry PocketBase with backoff instead of crash-looping under
	// Docker restart when it is briefly unavailable.
	pbClient := pb.NewClientWithRetry(config)

	startHealthServer(pbClient, zone)

	// SIGTERM is how Docker stops a worker on every deploy and node replacement.
	// Without this it took Go's default path, an immediate exit that abandoned the
	// check in flight with its result unwritten (#417). Installed after the
	// PocketBase retry above, so a stop during startup still exits at once.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Printf("Stop signal received")
	}()

	if zone == freeZone {
		// Isolated anonymous "try it" zone (#270): checks anon_monitors only, writes
		// up/down straight to the row, and reaps rows past the 1h TTL. No zone_stats
		// (kept out of the public health aggregate) and no evaluator/alerts/rollups.
		log.Printf("Worker ready (ANONYMOUS free zone). zone=%s concurrency=%d", zone, concurrency)
		sched := newSchedule()
		anonReconcile(pbClient, sched)
		go anonReconcileLoop(pbClient, sched)
		go anonCleanupLoop(pbClient)
		checks := newPool(concurrency)
		dispatch(ctx, sched, checks, func(id string, due float64) {
			processAnonMonitor(pbClient, sched, id, due)
		})
		finishDrain(checks)
		return
	}

	log.Printf("Worker ready. zone=%s worker=%s concurrency=%d", zone, workerId, concurrency)

	// The zone's due-set lives in this process. One worker per zone means the
	// schedule needs no coordination: no shared queue, no leader election, no
	// reservation — see worker/schedule.go.
	sched := newSchedule()
	mem := newMembership()
	// Beat once before the first reconcile so this worker knows its shard rather
	// than seeding the whole zone and pruning most of it 10 seconds later. A
	// failure here is not fatal: membership stays "one worker, index 0", which is
	// the single-worker behaviour, and the next beat corrects it.
	refreshMembership(pbClient, zone, workerId, mem)

	// Buffered by one: a roster change that lands while a reconcile is already
	// running must not block the heartbeat loop, and two changes queued behind one
	// reconcile are the same work as one.
	rosterChanged := make(chan struct{}, 1)
	go heartbeatLoop(pbClient, zone, workerId, mem, rosterChanged)

	// Seed before the first check rather than racing the loop: on a cold start the
	// set is empty, and a check loop polling an empty schedule for 30s is 30s of a
	// zone doing nothing.
	reconcile(pbClient, sched, zone, mem)
	go reconcileLoop(pbClient, sched, zone, mem, rosterChanged)
	go statsLoop(pbClient, sched, zone, workerId, mem)
	checks := newPool(concurrency)
	dispatch(ctx, sched, checks, func(id string, due float64) {
		processMonitor(pbClient, sched, zone, id, due, mem)
	})
	finishDrain(checks)
}

// drainLimit bounds how long a stopping worker waits for its in-flight checks.
// One check is bounded by checkTimeout (20s) plus its two PocketBase writes, so
// 25s covers it; deploy/worker.yml's stop_grace_period (30s) must stay above this
// or Docker's SIGKILL cuts the drain short.
const drainLimit = 25 * time.Second

// finishDrain waits for the checks already running, so each one's result is
// written before the process exits. The schedule itself is in memory and is
// rebuilt by the next start's reconcile, so nothing else needs saving.
func finishDrain(checks *pool) {
	start := time.Now()
	running := checks.busy()
	log.Printf("Draining: stopped taking checks, waiting for %d in flight", running)
	if drainChecks(checks, drainLimit) {
		log.Printf("Drained in %s; exiting", time.Since(start).Round(time.Millisecond))
		return
	}
	log.Printf("Drain gave up after %s with checks still running; exiting anyway", drainLimit)
	os.Exit(1)
}

// drainChecks waits up to limit for every in-flight check to finish and reports
// whether they all did.
func drainChecks(checks *pool, limit time.Duration) bool {
	done := make(chan struct{})
	go func() {
		checks.wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(limit):
		return false
	}
}

// dispatch pops due monitors and hands them to the pool until ctx is cancelled.
// pool.run blocks while all slots are busy, so a zone that cannot keep up builds
// visible schedule lag rather than an unbounded pile of goroutines. It returns as
// soon as the cancel is seen, including mid-backoff; checks already handed over
// keep running.
func dispatch(ctx context.Context, sched *schedule, checks *pool, process func(id string, due float64)) {
	for {
		if ctx.Err() != nil {
			return
		}
		monitorId, scheduledScore, found := sched.PopDue(float64(time.Now().Unix()))
		if !found {
			select {
			case <-ctx.Done():
				return
			case <-time.After(idlePollBackoff):
			}
			continue
		}
		id, due := monitorId, scheduledScore
		checks.run(func() { process(id, due) })
	}
}

// anonReconcileLoop keeps the free zone's due-set in step with anon_monitors.
func anonReconcileLoop(pbClient *pb.Client, sched *schedule) {
	for {
		time.Sleep(reconcileInterval)
		anonReconcile(pbClient, sched)
	}
}

// anonReconcile re-syncs the anon due-set in both directions. Unlike the real
// zone there is no zone filtering — anon monitors all live here — but pruning
// matters more: rows leave constantly, either reaped by the 1h TTL or migrated
// into `monitors` when someone signs up.
func anonReconcile(pbClient *pb.Client, sched *schedule) {
	monitors, err := pbClient.GetAnonMonitors()
	if err != nil {
		log.Printf("Anon reconcile: failed to list anon monitors: %s", err)
		return
	}

	// Same guard as the real zone's reconcile, for the same reason: an expired
	// token makes PocketBase return an empty list rather than a 401, which is
	// indistinguishable from every anon monitor having expired at once. Keeping
	// them costs nothing here — processAnonMonitor drops any that have genuinely
	// gone when it fails to load them.
	if len(monitors) == 0 && sched.Len() > 0 {
		log.Printf("Anon reconcile: PocketBase returned no anon monitors while %d are scheduled — keeping them rather than unscheduling on a possibly unreadable list.",
			sched.Len())
		return
	}

	now := float64(time.Now().Unix())
	live := make(map[string]struct{}, len(monitors))
	added := 0
	for _, m := range monitors {
		live[m.Id] = struct{}{}
		if sched.AddIfAbsent(m.Id, anonFirstDue(m, now)) {
			added++
		}
	}

	pruned := 0
	for _, id := range sched.Ids() {
		if _, ok := live[id]; !ok {
			if sched.Remove(id) {
				pruned++
			}
		}
	}

	log.Printf("Anon reconcile: %d anon monitor(s) scheduled (+%d added, -%d pruned)",
		sched.Len(), added, pruned)
}

// anonFirstDue is when a newly scheduled anon monitor is first checked.
//
// Never checked: now. Someone just typed this URL into "Try it free" and is
// watching the page — staggering it across the 5-minute interval left them on
// "Checking…" for up to five minutes (#522). Already checked (a worker restart):
// the usual stable stagger, so a restart does not check every row at once.
func anonFirstDue(m models.Monitor, now float64) float64 {
	if m.LastChecked == "" {
		return now
	}
	interval := m.Interval
	if interval < anonMinInterval {
		interval = anonMinInterval
	}
	return now + startupOffset(m.Id, interval)
}

func processAnonMonitor(pbClient *pb.Client, sched *schedule, monitorId string, scheduledScore float64) {
	monitor, err := pbClient.GetAnonMonitor(monitorId)
	if err != nil {
		// Gone (TTL cleanup, or migrated into `monitors` on signup). It was popped,
		// so leaving it unscheduled is the drop.
		log.Printf("[anon %s] failed to load, dropping: %s", monitorId, err)
		return
	}

	checkedAt := time.Now().UTC()
	result := services.RunCheck(monitor)
	if err := pbClient.UpdateAnonMonitorAfterCheck(monitorId, anonStatus(result), checkedAt); err != nil {
		log.Printf("[anon %s] failed to update status: %s", monitorId, err)
	}

	interval := monitor.Interval
	if interval < anonMinInterval {
		interval = anonMinInterval
	}
	next := nextDueScore(scheduledScore, float64(interval), float64(time.Now().Unix()))
	if result.Blocked && result.RetryAfterSecs > 0 {
		if earliest := float64(time.Now().Unix() + int64(result.RetryAfterSecs)); earliest > next {
			next = earliest
		}
	}
	sched.Add(monitorId, next)
	log.Printf("[anon %s] up=%v code=%d response_ms=%d next=%d", monitorId, result.Up, result.StatusCode, result.ResponseMs, int64(next))
}

// anonStatus maps a check result to the row status. A blocked (rate-limited)
// response isn't a genuine outage, so it counts as up.
func anonStatus(result models.CheckResult) string {
	if result.Up || result.Blocked {
		return "up"
	}
	return "down"
}

// anonCleanupLoop hard-deletes anon monitors past the 1h TTL — the signup nudge.
func anonCleanupLoop(pbClient *pb.Client) {
	for {
		cutoff := time.Now().Add(-anonTTL)
		if deleted, err := pbClient.DeleteAnonMonitorsOlderThan(cutoff, anonCleanupCap); err != nil {
			log.Printf("Anon cleanup: failed: %s", err)
		} else if deleted > 0 {
			log.Printf("Anon cleanup: deleted %d expired anon monitor(s)", deleted)
		}
		time.Sleep(anonCleanupInterval)
	}
}

// statsLoop periodically publishes per-zone stats (queue depth, schedule lag) to
// PocketBase. The published record's timestamp also serves as this zone's
// heartbeat, which the evaluator's dead-man's switch, /api/health, the monitor
// form's zone picker and the dashboard all read.
//
// Exactly one worker publishes it — see shouldPublishStats. The row is keyed by
// zone and has a unique index on it, so every worker writing would be a fight
// over one row with the `worker` field flapping between whoever wrote last.
func statsLoop(pbClient *pb.Client, sched *schedule, zone, worker string, mem *membership) {
	for {
		if !shouldPublishStats(pbClient, zone, mem) {
			time.Sleep(statsInterval)
			continue
		}

		// queue_depth is how many monitors THIS worker has scheduled. With one
		// worker that is the zone; with several it is the writer's shard, since
		// zone_stats is one row and no worker can see its peers' heaps.
		// Checks in flight have been popped, so they are not counted — at most one
		// pool's worth.
		depth := int64(sched.Len())

		var lag int64
		if due, found := sched.EarliestDue(); found {
			if behind := time.Now().Unix() - int64(due); behind > 0 {
				lag = behind
			}
		}

		_, count := mem.get()
		if err := pbClient.UpsertZoneStats(zone, worker, depth, lag, int64(count)); err != nil {
			log.Printf("Stats: failed to publish zone stats: %s", err)
		}
		time.Sleep(statsInterval)
	}
}

// heartbeatLoop records this worker as alive in its zone and keeps its place in
// the roster up to date. A change in that place is pushed to the reconcile loop
// immediately: waiting up to a full reconcile interval would add 30s to every
// takeover, which is most of the time budget.
func heartbeatLoop(pbClient *pb.Client, zone, workerId string, mem *membership, changed chan<- struct{}) {
	for {
		time.Sleep(heartbeatInterval)
		if refreshMembership(pbClient, zone, workerId, mem) {
			select {
			case changed <- struct{}{}:
			default: // a reconcile is already pending; one covers both
			}
		}
	}
}

// refreshMembership beats, re-reads the zone's roster, and reports whether this
// worker's position changed.
//
// The `updated` PocketBase stamps on our own beat is the clock every staleness
// judgement uses. Reading it back rather than calling time.Now() is what lets a
// worker in Germany and a worker in the Netherlands agree on who is alive.
func refreshMembership(pbClient *pb.Client, zone, workerId string, mem *membership) bool {
	now, err := pbClient.UpsertWorkerHeartbeat(zone, workerId)
	if err != nil {
		// Keep the membership we had. A PocketBase blip is not evidence that the
		// roster changed, and re-sharding on it would move work for no reason.
		log.Printf("Heartbeat: failed to record liveness: %s", err)
		return false
	}

	mem.observeServerTime(now)

	rows, err := pbClient.ListWorkerHeartbeats(zone)
	if err != nil {
		log.Printf("Heartbeat: failed to read the zone roster: %s", err)
		return false
	}

	live := roster(rows, now, rosterTTL)
	index, ok := indexOf(live, workerId)
	if !ok {
		// We beat successfully a moment ago, so our own row must be in this list.
		// If it is not, the read is not trustworthy — and acting on it would mean
		// dropping every monitor we own. Keep what we had and say so loudly.
		log.Printf("Heartbeat: WARNING this worker (%s) is missing from its own zone roster %v — keeping the previous shard", workerId, live)
		return false
	}

	if mem.set(index, len(live)) {
		log.Printf("Roster: %d worker(s) in zone %s, this worker is index %d — %v", len(live), zone, index, live)
		return true
	}
	return false
}

// shouldPublishStats decides whether this worker publishes the zone's stats row
// this tick.
//
// Normally only the elected writer does — the lowest worker id in the roster,
// which is simply index 0, since the roster is sorted by id.
//
// But zone_stats.updated is the zone's heartbeat: the evaluator's dead-man's
// switch, /api/health, the monitor form's zone picker and the dashboard all read
// it, and the dashboard calls a zone stale after 30 seconds. If the elected
// writer dies, nobody publishes until it drops out of the roster 45s later, and
// a zone whose every other worker is perfectly healthy reads as dead. So any live
// worker publishes once the row itself has gone quiet. A zone reads dead only
// when ALL of its workers are dead.
//
// Two workers may briefly both publish during that window. They write the same
// row with the same numbers, so the cost is one redundant request, which is the
// cheaper half of the trade.
func shouldPublishStats(pbClient *pb.Client, zone string, mem *membership) bool {
	if mem.isStatsWriter() {
		return true
	}
	now, ok := mem.serverNow()
	if !ok {
		// No heartbeat has succeeded yet, so we have no trustworthy clock and no
		// evidence anyone else is failing. The elected writer is presumed alive.
		return false
	}
	updated, found, err := pbClient.GetZoneStatUpdated(zone)
	if err != nil {
		log.Printf("Stats: failed to check whether the zone row is current: %s", err)
		return false
	}
	if !found {
		// Nobody has ever written it. Someone must.
		return true
	}
	if zoneStatsIsStale(updated, now, zoneStatsStaleAfter) {
		log.Printf("Stats: the zone row has not moved in over %s — publishing although this worker is not the elected writer", zoneStatsStaleAfter)
		return true
	}
	return false
}

// reconcileLoop keeps the in-process due-set in step with PocketBase, on a timer
// or as soon as the zone's roster changes.
func reconcileLoop(pbClient *pb.Client, sched *schedule, zone string, mem *membership, rosterChanged <-chan struct{}) {
	ticker := time.NewTicker(reconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-rosterChanged:
		}
		reconcile(pbClient, sched, zone, mem)
	}
}

// reconcile re-syncs the due-set against PocketBase in BOTH directions: every
// enabled monitor assigned to this zone is scheduled, and anything tracked that no
// longer qualifies is dropped.
//
// The queue-based seeder this replaced only ever added; removals were lazy,
// noticed when a monitor's turn came round, so a paused monitor could be probed
// one more time up to a full interval later. Pruning here is a map diff, so it
// costs nothing and closes that window to one reconcile pass.
//
// A monitor whose check is in flight is not in Ids() and so cannot be pruned by
// the pass that overlaps its check; it is rescheduled by the check loop and then
// pruned by the next pass. That is the same bound as before, and processMonitor's
// own guards drop it at its next turn regardless.
func reconcile(pbClient *pb.Client, sched *schedule, zone string, mem *membership) {
	monitors, err := pbClient.GetEnabledMonitors()
	if err != nil {
		// Leave the set alone: a PocketBase blip must not unschedule a zone.
		log.Printf("Reconcile: failed to list monitors: %s", err)
		return
	}

	// PocketBase answers a failed LIST rule by filtering everything out: HTTP 200
	// with an empty list, not a 401. A token that has quietly expired therefore
	// looks exactly like a zone whose monitors were all deleted — and the client
	// only re-authenticates on a 401, so nothing corrects it.
	//
	// Unscheduling the zone on that would be the worst failure this system has:
	// no error, zone_stats still published, queue_depth 0, and a fleet that looks
	// idle rather than blind. So an empty answer is never a reason to forget
	// monitors we are already checking.
	//
	// It keys on the RAW list, not on the owned subset. A worker that owns none
	// of a non-empty list has simply been out-voted by the hash and must still
	// prune — that is an ordinary re-shard.
	if len(monitors) == 0 && sched.Len() > 0 {
		log.Printf("Reconcile: PocketBase returned NO monitors at all while %d are scheduled in zone %s — keeping them. An expired token reads exactly like this; check the worker's auth if it persists.",
			sched.Len(), zone)
		return
	}

	// PocketBase answers a failed LIST rule by filtering everything out: HTTP 200
	// with an empty list, not a 401. A token that has quietly expired therefore
	// reads exactly like a zone whose monitors were all deleted — and the client
	// only re-authenticates on a 401, so nothing corrects it.
	//
	// Unscheduling the zone on that would be the worst failure this system has:
	// no error, zone_stats still published, queue_depth 0, and a fleet that looks
	// idle rather than blind. An empty answer is never a reason to forget
	// monitors we are already checking.
	//
	// It keys on the RAW list, not the owned subset: a worker that owns none of a
	// non-empty list has simply been out-voted by the hash, and must still prune.
	// That is an ordinary re-shard.
	if len(monitors) == 0 && sched.Len() > 0 {
		log.Printf("Reconcile: PocketBase returned NO monitors at all while %d are scheduled in zone %s — keeping them. An expired token reads exactly like this; check this worker's auth if it persists.",
			sched.Len(), zone)
		return
	}

	now := float64(time.Now().Unix())
	live := make(map[string]struct{}, len(monitors))
	added := 0
	for _, monitor := range monitors {
		if !shouldSchedule(monitor, zone, mem) {
			continue
		}
		live[monitor.Id] = struct{}{}
		// Spread first checks across the interval instead of firing the whole zone
		// at once on startup. The offset is a hash of the id, so it is the same on
		// every restart.
		due := now + startupOffset(monitor.Id, models.EffectiveInterval(monitor.Interval))
		if sched.AddIfAbsent(monitor.Id, due) {
			added++
		}
	}

	pruned := 0
	for _, id := range sched.Ids() {
		if _, ok := live[id]; !ok {
			if sched.Remove(id) {
				pruned++
			}
		}
	}

	index, count := mem.get()
	log.Printf("Reconcile: %d monitor(s) scheduled in zone %s (+%d added, -%d pruned) [worker %d/%d]",
		sched.Len(), zone, added, pruned, index+1, count)
}

// shouldSchedule reports whether THIS worker should be checking this monitor:
// it must be a probe type, assigned to this zone, and fall in this worker's shard
// of the zone. With a single worker the last condition is always true, so the
// reconcile pass behaves exactly as it did before zones could hold more than one.
func shouldSchedule(monitor models.Monitor, zone string, mem *membership) bool {
	if monitor.Type == "heartbeat" {
		return false // heartbeats check in to /ping/{token}; workers never probe them
	}
	if !monitorInZone(monitor.Zones, zone) {
		return false
	}
	return mem.ownsMonitor(monitor.Id)
}

// monitorInZone reports whether a monitor should run in the given zone. A monitor
// with no zones set runs everywhere (single-zone-friendly default).
func monitorInZone(zones []string, zone string) bool {
	if len(zones) == 0 {
		return true
	}
	for _, z := range zones {
		if z == zone {
			return true
		}
	}
	return false
}

// processMonitor runs one check and puts the monitor back in the schedule.
//
// The monitor has already been POPPED, so every "drop it" path here is simply a
// return without rescheduling — there is nothing to remove.
func processMonitor(pbClient *pb.Client, sched *schedule, zone, monitorId string, scheduledScore float64, mem *membership) {
	monitor, err := pbClient.GetMonitor(monitorId)
	if err != nil {
		// Can't confirm the monitor; leave it unscheduled. The next reconcile pass
		// re-adds it if it still exists and is enabled.
		log.Printf("[%s] failed to load monitor, dropping: %s", monitorId, err)
		return
	}
	if !monitor.Enabled {
		log.Printf("[%s] monitor disabled, dropping from schedule", monitorId)
		return
	}
	if monitor.Type == "heartbeat" {
		log.Printf("[%s] heartbeat monitor, dropping from probe schedule", monitorId)
		return
	}
	// Zones can change after a monitor is scheduled. Reconcile prunes those within
	// a pass, but the monitor is re-read here anyway, so check at process time too
	// and drop it immediately if it no longer belongs.
	if !monitorInZone(monitor.Zones, zone) {
		log.Printf("[%s] no longer assigned to zone %s, dropping from schedule", monitorId, zone)
		return
	}

	checkedAt := time.Now().UTC()
	result := services.RunCheck(monitor)
	// A failure while this worker's own network is down is not the site's (#598).
	canary.Judge(&result)

	if err := pbClient.CreateCheck(monitor.Id, zone, result, checkedAt); err != nil {
		log.Printf("[%s] failed to write check: %s", monitorId, err)
	}
	if err := pbClient.UpdateMonitorAfterCheck(monitor.Id, checkedAt, result.CertExpiresAt); err != nil {
		log.Printf("[%s] failed to update last_checked: %s", monitorId, err)
	}

	// The roster can change while a check is in flight. This monitor was popped
	// when we owned it; if we no longer do, the new owner has it, and putting it
	// back would mean both of us checking it until our next reconcile pruned it —
	// up to a full reconcile interval of duplicate probes.
	if !mem.ownsMonitor(monitorId) {
		log.Printf("[%s] no longer this worker's share of zone %s, dropping from schedule", monitorId, zone)
		return
	}

	interval := models.EffectiveInterval(monitor.Interval)
	next := nextDueScore(scheduledScore, float64(interval), float64(time.Now().Unix()))
	// If the target rate-limited us and asked us to wait (Retry-After), don't
	// re-probe sooner than that — even when the normal interval is shorter.
	if result.Blocked && result.RetryAfterSecs > 0 {
		earliest := float64(time.Now().Unix() + int64(result.RetryAfterSecs))
		if earliest > next {
			next = earliest
		}
	}
	sched.Add(monitorId, next)

	// The error goes in the line: without it, a failed check with code=0 said
	// nothing about why, and #595 could only be diagnosed from its timing.
	log.Printf("[%s] up=%v blocked=%v inconclusive=%v code=%d response_ms=%d next=%d err=%q", monitorId, result.Up, result.Blocked, result.Inconclusive, result.StatusCode, result.ResponseMs, int64(next), result.Error)
}

// nextDueScore computes the next scheduled time from the ORIGINAL scheduled time
// (not from now), so checks don't drift later and later. If the worker fell
// behind by several intervals, missed intervals are skipped to avoid a catch-up
// storm; the result is always strictly in the future.
func nextDueScore(scheduled, interval, now float64) float64 {
	if interval <= 0 {
		interval = defaultInterval
	}
	next := scheduled + interval
	if next <= now {
		missed := math.Ceil((now - scheduled) / interval)
		next = scheduled + missed*interval
		if next <= now {
			next += interval
		}
	}
	return next
}
