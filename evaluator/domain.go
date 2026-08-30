package main

import (
	"context"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	domainpkg "monitors/corelib/domain"
	"monitors/corelib/pb"
)

// Domain-expiry lookups are deliberately infrequent: registration dates change
// at most yearly and registries rate-limit hard (RDAP/WHOIS). So a monitor's
// domain is refreshed at most once per domainCacheTTL, sweeps run no more often
// than domainSweepInterval, and each sweep looks up at most maxDomainLookups
// domains spaced by domainLookupSpacing. A stamped domain_checked_at (set even
// when a lookup finds nothing) is what backs off the retry — a rate-limited or
// no-data domain simply stays "unknown" until the TTL lapses; it never reads as
// down. The sweep runs in its own goroutine so slow network never stalls the
// 10s evaluation loop.
const (
	domainSweepInterval   = time.Hour
	domainCacheTTL        = 24 * time.Hour
	maxDomainLookups      = 25
	domainLookupSpacing   = 1500 * time.Millisecond
	domainLookupTimeout   = 12 * time.Second
	defaultDomainWarnDays = 30
)

// domainRefreshState tracks the periodic sweep across ticks. lastSweep is
// written only from the evaluation loop (single goroutine); running guards
// against a second sweep starting while one is still in flight.
type domainRefreshState struct {
	lastSweep time.Time
	running   atomic.Bool
}

// domainRefreshCheck kicks off a background domain-expiry sweep when the
// interval has elapsed and no sweep is already running. It returns immediately.
func domainRefreshCheck(pbClient *pb.Client, st *domainRefreshState, now time.Time) {
	if !st.lastSweep.IsZero() && now.Sub(st.lastSweep) < domainSweepInterval {
		return
	}
	if !st.running.CompareAndSwap(false, true) {
		return // a sweep is still in flight
	}
	st.lastSweep = now
	go func() {
		defer st.running.Store(false)
		runDomainSweep(pbClient, now)
	}()
}

// domainCandidate is one due monitor and the registrable domain to query for it.
type domainCandidate struct {
	id     string
	domain string
}

func runDomainSweep(pbClient *pb.Client, now time.Time) {
	monitors, err := pbClient.ListMonitorsForDomainRefresh()
	if err != nil {
		log.Printf("Domain: failed to list monitors: %s", err)
		return
	}

	var due []domainCandidate
	for _, m := range monitors {
		reg, err := domainpkg.RegistrableDomain(m.Target)
		if err != nil {
			continue // IP literal / non-domain target — nothing to look up
		}
		if !domainRefreshDue(m.DomainCheckedAt, now) {
			continue // still fresh in cache
		}
		due = append(due, domainCandidate{id: m.Id, domain: reg})
	}
	if len(due) == 0 {
		return
	}
	if len(due) > maxDomainLookups {
		log.Printf("Domain: %d monitors due, looking up %d this sweep (rest next sweep)", len(due), maxDomainLookups)
		due = due[:maxDomainLookups]
	}

	for i, c := range due {
		if i > 0 {
			time.Sleep(domainLookupSpacing) // space calls to respect registry limits
		}
		ctx, cancel := context.WithTimeout(context.Background(), domainLookupTimeout)
		res, lookupErr := domainpkg.LookupExpiry(ctx, c.domain)
		cancel()

		// Always stamp checked-at (backs off the retry); expiry only when found.
		if err := pbClient.UpdateMonitorDomainExpiry(c.id, res.ExpiresAt, time.Now().UTC()); err != nil {
			log.Printf("Domain: [%s] failed to store expiry: %s", c.id, err)
		}
		if lookupErr != nil {
			log.Printf("Domain: [%s] %s unknown (kept prior value): %s", c.id, c.domain, lookupErr)
			continue
		}
		log.Printf("Domain: [%s] %s expires %s (via %s)", c.id, c.domain, res.ExpiresAt.Format("2006-01-02"), res.Source)
	}
}

// domainRefreshDue reports whether a monitor's domain is stale enough to
// re-query. An empty/unparseable checked-at means never looked up — always due.
func domainRefreshDue(checkedAt string, now time.Time) bool {
	t, ok := parsePBTime(checkedAt)
	if !ok {
		return true
	}
	return now.Sub(t) >= domainCacheTTL
}

// domainNeedsAlert reports whether a domain expiring at expiresAt should warn
// now — within the warning window (including already lapsed). A zero time means
// unknown and never warns.
func domainNeedsAlert(expiresAt time.Time, now time.Time, warn time.Duration) bool {
	if expiresAt.IsZero() {
		return false
	}
	return expiresAt.Sub(now) <= warn
}

// domainExpiryCheck warns a monitor's channels when its resolved domain
// registration is within the configured window. Dedup mirrors the cert alerter:
// keyed by the expiry we last warned for, so a renewed domain (new expiry) can
// warn again but a still-expiring one won't spam every tick.
func domainExpiryCheck(pbClient *pb.Client, cfg alertConfig, alerted map[string]time.Time, store alertStateStore, now time.Time) {
	monitors, err := pbClient.ListMonitorsWithDomain()
	if err != nil {
		log.Printf("Domain: failed to list monitors with domain: %s", err)
		return
	}
	for _, m := range monitors {
		expiresAt, ok := parsePBTime(m.DomainExpiresAt)
		if !ok || !domainNeedsAlert(expiresAt, now, cfg.domainWarn) {
			continue
		}
		if prev, seen := alerted[m.Id]; seen && prev.Equal(expiresAt) {
			continue // already warned for this exact expiry
		}
		channels, err := pbClient.ChannelsForMonitor(m)
		if err != nil {
			log.Printf("Domain: [%s] cannot load channels, will retry: %s", m.Id, err)
			continue
		}
		days := int(expiresAt.Sub(now).Hours() / 24)
		when := fmt.Sprintf("in %d day(s)", days)
		if days < 0 {
			when = "already (expired)"
		}
		subject := fmt.Sprintf("[nabz] %s domain registration expires soon", m.Name)
		body := fmt.Sprintf("%s (%s) domain registration expires %s — on %s. Renew it before it lapses.", m.Name, m.Target, when, expiresAt.UTC().Format("2006-01-02"))
		payload := map[string]interface{}{
			"event":             "domain.expiring",
			"monitor":           m.Name,
			"monitor_id":        m.Id,
			"domain_expires_at": expiresAt.UTC().Format(time.RFC3339),
			"days_remaining":    days,
		}
		results := dispatch(cfg, channels, subject, body, payload)
		sent, _ := summarize(results)
		log.Printf("[%s] domain-expiry warning to %d/%d channel(s) (expires %s)", m.Id, sent, len(channels), expiresAt.UTC().Format("2006-01-02"))
		logChannelEvents(pbClient, results, "domain")
		alerted[m.Id] = expiresAt
		store.Put(stateKey(stateKindDomain, m.Id), expiresAt.UTC().Format(time.RFC3339))
	}
}
