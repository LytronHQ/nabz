package main

import (
	"log"
	"time"

	"monitors/corelib/health"
	"monitors/corelib/pb"
	"monitors/corelib/utils"
)

// startHealthServer launches the evaluator's two-tier HTTP health surface unless
// HEALTH_ADDR is disabled. /health reports the evaluator's own PocketBase
// reachability; /health/all aggregates every zone's heartbeat freshness (the same
// signal as the dead-man's switch), reduced to generic labels.
func startHealthServer(pbClient *pb.Client, deadman time.Duration) {
	addr := utils.GetEnv("HEALTH_ADDR", ":8080")
	if addr == "" || addr == "off" {
		return
	}
	srv := &health.Server{
		Name:  "evaluator",
		Token: utils.GetEnv("HEALTH_DEBUG_TOKEN", ""),
		Deps: []health.Dependency{
			{Name: "pocketbase", Check: pbClient.Ping},
		},
		Aggregate: func() health.Report {
			return aggregateZones(pbClient, deadman, time.Now().UTC())
		},
	}
	go func() {
		log.Printf("Health server listening on %s %s", addr, health.BuildString())
		if err := srv.Serve(addr); err != nil {
			log.Printf("Health server stopped: %s", err)
		}
	}()
}

// aggregateZones turns each zone's heartbeat into a scrubbed health Item: stale
// past the dead-man threshold ⇒ "stale" with the elapsed duration, otherwise
// "ok". If PocketBase itself can't be read, the evaluator reports itself
// unreachable rather than an empty (falsely healthy) fleet.
func aggregateZones(pbClient *pb.Client, deadman time.Duration, now time.Time) health.Report {
	zones, err := pbClient.GetZoneStats()
	if err != nil {
		return health.Report{
			Node:  "evaluator",
			Items: []health.Item{{Name: "pocketbase", Label: health.LabelUnreachable}},
		}
	}
	items := make([]health.Item, 0, len(zones))
	for _, z := range zones {
		item := health.Item{Name: z.Zone, Label: health.LabelOK}
		if t, ok := parsePBTime(z.Updated); ok {
			if age := now.Sub(t); age > deadman {
				item.Label = health.LabelStale
				item.StaleFor = age
			}
		} else {
			// Unparseable timestamp ⇒ no trustworthy heartbeat; treat as stale.
			item.Label = health.LabelStale
		}
		items = append(items, item)
	}
	return health.Report{Node: "evaluator", Items: items}
}
