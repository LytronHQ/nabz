package main

import (
	"context"
	"flag"
	"log"
	"math"
	"os"
	"sync/atomic"
	"time"

	"monitors/corelib/models"
	"monitors/corelib/pb"
	"monitors/corelib/utils"

	"monitors/worker/services"
)

const (
	defaultZone   = "default"
	seedInterval  = 30 * time.Second
	statsInterval = 10 * time.Second

	// Scaling a zone to N workers (#311). The seed lock elects one of them to run
	// seedLoop and publish zone_stats; the heartbeat makes the live count
	// observable. TTL is 3x the renewal interval so a single slow round trip does
	// not drop the lock and cause a needless handover.
	leaderRenewInterval = 10 * time.Second
	leaderLockTTL       = 30 * time.Second
	heartbeatInterval   = 10 * time.Second
	// A worker is counted live for this long after its last beat — 6x the
	// interval, so a worker has to miss five in a row before it stops counting.
	heartbeatTTL    = 60 * time.Second
	idlePollBackoff = 1 * time.Second
	errorBackoff    = 3 * time.Second
	defaultInterval = 60
	// reservationSeconds is how long a reserved monitor is held before it becomes
	// due again if the worker never rescheduled it (i.e. crashed mid-check). Must
	// comfortably exceed a single check's timeout.
	reservationSeconds = 60

	// The anonymous "try it" free zone (#270): a worker with REGION_NAME=free runs
	// the isolated anon_monitors pipeline instead of the real one.
	freeZone            = "free"
	anonMinInterval     = 300 // 5 min floor for anon checks
	anonTTL             = time.Hour
	anonCleanupInterval = 5 * time.Minute
	anonCleanupCap      = 500
)

func main() {
	ctx := context.Background()

	var healthCheck bool
	flag.BoolVar(&healthCheck, "health-check", false, "Flag to check health.")
	flag.Parse()

	config := utils.LoadConfig()

	zone := defaultZone
	if config.Region != nil && config.Region.Name != "" {
		zone = config.Region.Name
	}
	dueKey := "due:" + zone

	// Ops identity, distinct from the zone (#311): the zone is the shard key
	// written to checks.zone, while this only ever appears in logs, the health
	// payload and the heartbeat. Hostname is already unique per container, so
	// scaling with `--scale worker=N` needs no per-replica configuration.
	workerId := config.HostName
	if config.Worker != nil && config.Worker.Id != "" {
		workerId = config.Worker.Id
	}

	if healthCheck {
		// Health probe: fail fast on both deps, never retry.
		cache, err := utils.GetCacheClient(ctx, config)
		if err != nil {
			log.Printf("Health check failed: %s", err)
			os.Exit(1)
		}
		defer cache.Client.Close()
		if err := cache.Ping(ctx); err != nil {
			log.Printf("Health check failed: cannot reach Valkey: %s", err)
			os.Exit(1)
		}
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

	// Normal startup: retry both dependencies with backoff instead of crash-looping
	// under Docker restart when Valkey or PocketBase is briefly unavailable.
	cache := utils.ConnectCacheWithRetry(ctx, config)
	defer cache.Client.Close()
	pbClient := pb.NewClientWithRetry(config)

	startHealthServer(ctx, cache, pbClient, zone)

	if zone == freeZone {
		// Isolated anonymous "try it" zone (#270): checks anon_monitors only, writes
		// up/down straight to the row, and reaps rows past the 1h TTL. No zone_stats
		// (kept out of the public health aggregate) and no evaluator/alerts/rollups.
		log.Printf("Worker ready (ANONYMOUS free zone). zone=%s dueKey=%s", zone, dueKey)
		go anonSeedLoop(ctx, cache, pbClient, dueKey)
		go anonCleanupLoop(pbClient)
		anonCheckLoop(ctx, cache, pbClient, dueKey)
		return
	}

	log.Printf("Worker ready. zone=%s worker=%s dueKey=%s", zone, workerId, dueKey)

	lead := &leadership{}
	go leaderLoop(ctx, cache, zone, workerId, lead)
	go heartbeatLoop(ctx, cache, zone, workerId)
	go seedLoop(ctx, cache, pbClient, zone, dueKey, lead)
	go statsLoop(ctx, cache, pbClient, zone, dueKey, workerId, lead)
	checkLoop(ctx, cache, pbClient, zone, dueKey)
}

// anonSeedLoop keeps every anon monitor present in the free due-set. Unlike the
// real seeder there's no zone/heartbeat filtering — anon monitors all live here.
func anonSeedLoop(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, dueKey string) {
	for {
		monitors, err := pbClient.GetAnonMonitors()
		if err != nil {
			log.Printf("Anon seeder: failed to list anon monitors: %s", err)
			time.Sleep(seedInterval)
			continue
		}
		now := float64(time.Now().Unix())
		seeded := 0
		for _, m := range monitors {
			if err := cache.ScheduleNX(ctx, dueKey, m.Id, now); err != nil {
				log.Printf("Anon seeder: failed to schedule %s: %s", m.Id, err)
				continue
			}
			seeded++
		}
		log.Printf("Anon seeder: ensured %d anon monitor(s) scheduled in %s", seeded, dueKey)
		time.Sleep(seedInterval)
	}
}

func anonCheckLoop(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, dueKey string) {
	for {
		now := float64(time.Now().Unix())
		monitorId, scheduledScore, found, err := cache.ReserveDue(ctx, dueKey, now, now+reservationSeconds)
		if err != nil {
			log.Printf("Anon check loop: reserve failed: %s", err)
			time.Sleep(errorBackoff)
			continue
		}
		if !found {
			time.Sleep(idlePollBackoff)
			continue
		}
		processAnonMonitor(ctx, cache, pbClient, dueKey, monitorId, scheduledScore)
	}
}

func processAnonMonitor(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, dueKey, monitorId string, scheduledScore float64) {
	monitor, err := pbClient.GetAnonMonitor(monitorId)
	if err != nil {
		// Gone (TTL cleanup, or migrated into `monitors` on signup) — drop it.
		log.Printf("[anon %s] failed to load, dropping: %s", monitorId, err)
		removeFromSchedule(ctx, cache, dueKey, monitorId)
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
	if err := cache.Schedule(ctx, dueKey, monitorId, next); err != nil {
		log.Printf("[anon %s] failed to reschedule: %s", monitorId, err)
	}
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

// statsLoop periodically publishes per-zone stats (queue depth, schedule lag)
// to PocketBase. The published record's timestamp also serves as this zone's
// heartbeat, which the dashboard uses to flag a zone that has gone silent.
func statsLoop(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, zone, dueKey, worker string, lead *leadership) {
	for {
		if !lead.held.Load() {
			// zone_stats is keyed by zone, one row. Followers writing it would
			// overwrite each other rather than add anything.
			time.Sleep(statsInterval)
			continue
		}
		depth, err := cache.Zcard(ctx, dueKey)
		if err != nil {
			log.Printf("Stats: failed to read queue depth: %s", err)
			time.Sleep(statsInterval)
			continue
		}

		var lag int64
		if score, found, scoreErr := cache.EarliestScore(ctx, dueKey); scoreErr == nil && found {
			if behind := time.Now().Unix() - int64(score); behind > 0 {
				lag = behind
			}
		}

		// Queue depth and lag are properties of the shared zone queue, so the
		// leader reporting them describes the whole zone, not just itself.
		workers, err := cache.LiveWorkers(ctx, "workers:"+zone, time.Now(), heartbeatTTL)
		if err != nil {
			log.Printf("Stats: failed to count live workers: %s", err)
			workers = 0
		}
		if err := pbClient.UpsertZoneStats(zone, worker, depth, lag, workers); err != nil {
			log.Printf("Stats: failed to publish zone stats: %s", err)
		}
		time.Sleep(statsInterval)
	}
}

// leadership tracks whether this worker currently holds the zone's seed lock.
// Read from the seed and stats loops, written by leaderLoop.
type leadership struct{ held atomic.Bool }

// leaderLoop keeps trying to take (and then renew) the zone's seed lock.
//
// Only the holder seeds the due-set and publishes zone_stats. Without it, N
// workers in a zone each run the full PocketBase monitor scan every 30s, and each
// PATCHes the single zone_stats row for the zone every 10s — N times the PB load
// for exactly one row's worth of information, with the `worker` field flapping
// between whichever container wrote last.
//
// This is an optimisation, not a correctness mechanism. Seeding uses ScheduleNX,
// so if two workers briefly both believe they lead during a handover, the loser's
// pass just re-affirms members that are already scheduled. That is why a plain
// TTL lock is enough here and no fencing token is needed.
func leaderLoop(ctx context.Context, cache *utils.CacheClient, zone, workerId string, lead *leadership) {
	key := "seed:lock:" + zone
	for {
		ok, err := cache.AcquireLock(ctx, key, workerId, leaderLockTTL)
		if err != nil {
			// Treat an unreachable Valkey as "not leader": the checks themselves
			// are already failing, and seeding through a broken cache cannot work.
			log.Printf("Leader: lock error, standing down: %s", err)
			ok = false
		}
		if ok != lead.held.Swap(ok) {
			if ok {
				log.Printf("Leader: acquired seed lock for zone %s", zone)
			} else {
				log.Printf("Leader: lost seed lock for zone %s", zone)
			}
		}
		time.Sleep(leaderRenewInterval)
	}
}

// heartbeatLoop records this worker as alive in its zone every tick, so the live
// worker count is observable without any worker knowing about the others.
func heartbeatLoop(ctx context.Context, cache *utils.CacheClient, zone, workerId string) {
	key := "workers:" + zone
	for {
		if err := cache.Heartbeat(ctx, key, workerId, time.Now(), heartbeatTTL); err != nil {
			log.Printf("Heartbeat: failed to record worker liveness: %s", err)
		}
		time.Sleep(heartbeatInterval)
	}
}

// seedLoop periodically ensures every enabled monitor assigned to this zone is
// present in the due set. ScheduleNX never disturbs an already-scheduled monitor.
func seedLoop(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, zone, dueKey string, lead *leadership) {
	for {
		if !lead.held.Load() {
			// A follower must not scan PocketBase — that scan is the whole cost
			// the lock exists to avoid paying N times.
			time.Sleep(seedInterval)
			continue
		}
		monitors, err := pbClient.GetEnabledMonitors()
		if err != nil {
			log.Printf("Seeder: failed to list monitors: %s", err)
			time.Sleep(seedInterval)
			continue
		}

		now := float64(time.Now().Unix())
		seeded := 0
		for _, monitor := range monitors {
			if monitor.Type == "heartbeat" {
				continue // heartbeats check in to /ping/{token}; workers never probe them
			}
			if !monitorInZone(monitor.Zones, zone) {
				continue
			}
			if err := cache.ScheduleNX(ctx, dueKey, monitor.Id, now); err != nil {
				log.Printf("Seeder: failed to schedule monitor %s: %s", monitor.Id, err)
				continue
			}
			seeded++
		}
		log.Printf("Seeder: ensured %d monitor(s) scheduled in %s", seeded, dueKey)
		time.Sleep(seedInterval)
	}
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

func checkLoop(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, zone, dueKey string) {
	for {
		now := float64(time.Now().Unix())
		monitorId, scheduledScore, found, err := cache.ReserveDue(ctx, dueKey, now, now+reservationSeconds)
		if err != nil {
			log.Printf("Check loop: reserve failed: %s", err)
			time.Sleep(errorBackoff)
			continue
		}
		if !found {
			time.Sleep(idlePollBackoff)
			continue
		}

		processMonitor(ctx, cache, pbClient, zone, dueKey, monitorId, scheduledScore)
	}
}

func removeFromSchedule(ctx context.Context, cache *utils.CacheClient, dueKey, monitorId string) {
	if err := cache.Remove(ctx, dueKey, monitorId); err != nil {
		log.Printf("[%s] failed to remove from schedule: %s", monitorId, err)
	}
}

func processMonitor(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, zone, dueKey, monitorId string, scheduledScore float64) {
	monitor, err := pbClient.GetMonitor(monitorId)
	if err != nil {
		// Can't confirm the monitor; drop it from the set (clearing its
		// reservation). The seeder re-adds it if it still exists and is enabled.
		log.Printf("[%s] failed to load monitor, dropping: %s", monitorId, err)
		removeFromSchedule(ctx, cache, dueKey, monitorId)
		return
	}
	if !monitor.Enabled {
		log.Printf("[%s] monitor disabled, dropping from schedule", monitorId)
		removeFromSchedule(ctx, cache, dueKey, monitorId)
		return
	}
	if monitor.Type == "heartbeat" {
		log.Printf("[%s] heartbeat monitor, dropping from probe schedule", monitorId)
		removeFromSchedule(ctx, cache, dueKey, monitorId)
		return
	}
	// Zones can change after a monitor is scheduled. The seeder only adds
	// (ScheduleNX) and never prunes, so a monitor moved out of this zone would
	// otherwise stay in this zone's due set and keep being checked forever.
	// Re-check assignment at process time and drop it if it no longer belongs.
	if !monitorInZone(monitor.Zones, zone) {
		log.Printf("[%s] no longer assigned to zone %s, dropping from schedule", monitorId, zone)
		removeFromSchedule(ctx, cache, dueKey, monitorId)
		return
	}

	checkedAt := time.Now().UTC()
	result := services.RunCheck(monitor)

	if err := pbClient.CreateCheck(monitor.Id, zone, result, checkedAt); err != nil {
		log.Printf("[%s] failed to write check: %s", monitorId, err)
	}
	if err := pbClient.UpdateMonitorAfterCheck(monitor.Id, checkedAt, result.CertExpiresAt); err != nil {
		log.Printf("[%s] failed to update last_checked: %s", monitorId, err)
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
	if err := cache.Schedule(ctx, dueKey, monitorId, next); err != nil {
		log.Printf("[%s] failed to reschedule: %s", monitorId, err)
	}

	log.Printf("[%s] up=%v blocked=%v code=%d response_ms=%d next=%d", monitorId, result.Up, result.Blocked, result.StatusCode, result.ResponseMs, int64(next))
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
