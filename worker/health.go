package main

import (
	"context"
	"log"

	"monitors/corelib/health"
	"monitors/corelib/pb"
	"monitors/corelib/utils"
)

// startHealthServer launches the worker's two-tier HTTP health endpoint unless
// HEALTH_ADDR is disabled. It probes the same dependencies as the --health-check
// CLI (Valkey + PocketBase); results are reduced to generic labels, so a response
// can never leak a connection target or credential.
func startHealthServer(ctx context.Context, cache *utils.CacheClient, pbClient *pb.Client, zone string) {
	addr := utils.GetEnv("HEALTH_ADDR", ":8080")
	if addr == "" || addr == "off" {
		return
	}
	srv := &health.Server{
		Name:  "worker-" + zone,
		Token: utils.GetEnv("HEALTH_DEBUG_TOKEN", ""),
		Deps: []health.Dependency{
			{Name: "valkey", Check: func() error { return cache.Ping(ctx) }},
			{Name: "pocketbase", Check: pbClient.Ping},
		},
	}
	go func() {
		log.Printf("Health server listening on %s %s", addr, health.BuildString())
		if err := srv.Serve(addr); err != nil {
			log.Printf("Health server stopped: %s", err)
		}
	}()
}
