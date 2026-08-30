package services

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"monitors/corelib/models"
)

// dnsTimeout bounds a single DNS resolution.
const dnsTimeout = 10 * time.Second

// runDNSCheck resolves host for the configured record type (default A) and reports
// up/down plus the resolution time. Down on error / NXDOMAIN / no records, or when
// an expected value is set but no resolved record contains it. An optional custom
// resolver (host or host:port) is queried instead of the system one.
func runDNSCheck(host string, cfg models.MonitorConfig) models.CheckResult {
	host = strings.TrimSpace(host)
	rtype := strings.ToUpper(strings.TrimSpace(cfg.DNSRecordType))
	if rtype == "" {
		rtype = "A"
	}

	resolver := net.DefaultResolver
	if server := strings.TrimSpace(cfg.DNSResolver); server != "" {
		addr := ensurePort(server, "53")
		resolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
				d := net.Dialer{Timeout: dnsTimeout, Control: dialControl()}
				return d.DialContext(ctx, network, addr)
			},
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), dnsTimeout)
	defer cancel()

	start := time.Now()
	records, err := lookupDNS(ctx, resolver, rtype, host)
	elapsed := int(time.Since(start).Milliseconds())

	switch {
	case err != nil:
		return models.CheckResult{Up: false, ResponseMs: elapsed, Error: err.Error()}
	case len(records) == 0:
		return models.CheckResult{Up: false, ResponseMs: elapsed, Error: fmt.Sprintf("no %s records for %s", rtype, host)}
	}
	if want := strings.TrimSpace(cfg.DNSExpectedValue); want != "" && !dnsRecordsContain(records, want) {
		return models.CheckResult{Up: false, ResponseMs: elapsed, Error: fmt.Sprintf("%s records %v do not contain %q", rtype, records, want)}
	}
	return models.CheckResult{Up: true, ResponseMs: elapsed}
}

// lookupDNS resolves the given record type, returning the records as strings
// (host records are returned without the trailing dot).
func lookupDNS(ctx context.Context, r *net.Resolver, rtype, host string) ([]string, error) {
	switch rtype {
	case "A", "AAAA":
		network := "ip4"
		if rtype == "AAAA" {
			network = "ip6"
		}
		ips, err := r.LookupIP(ctx, network, host)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(ips))
		for _, ip := range ips {
			out = append(out, ip.String())
		}
		return out, nil
	case "CNAME":
		cname, err := r.LookupCNAME(ctx, host)
		if err != nil {
			return nil, err
		}
		return []string{strings.TrimSuffix(cname, ".")}, nil
	case "MX":
		mxs, err := r.LookupMX(ctx, host)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(mxs))
		for _, mx := range mxs {
			out = append(out, strings.TrimSuffix(mx.Host, "."))
		}
		return out, nil
	case "TXT":
		return r.LookupTXT(ctx, host)
	case "NS":
		nss, err := r.LookupNS(ctx, host)
		if err != nil {
			return nil, err
		}
		out := make([]string, 0, len(nss))
		for _, ns := range nss {
			out = append(out, strings.TrimSuffix(ns.Host, "."))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported DNS record type %q", rtype)
	}
}

// dnsRecordsContain reports whether any record equals or contains want
// (case-insensitive; a trailing dot on host records is ignored).
func dnsRecordsContain(records []string, want string) bool {
	want = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(want), "."))
	for _, rec := range records {
		if strings.Contains(strings.ToLower(strings.TrimSuffix(rec, ".")), want) {
			return true
		}
	}
	return false
}
