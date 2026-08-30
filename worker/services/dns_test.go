package services

import (
	"testing"

	"monitors/corelib/models"
)

func TestDNSRecordsContain(t *testing.T) {
	recs := []string{"1.2.3.4", "5.6.7.8"}
	if !dnsRecordsContain(recs, "5.6.7.8") {
		t.Error("exact IP should match")
	}
	if !dnsRecordsContain(recs, "1.2.3") {
		t.Error("substring should match")
	}
	if dnsRecordsContain(recs, "9.9.9.9") {
		t.Error("absent value must not match")
	}
	// Host records compare case-insensitively and ignore a trailing dot.
	hosts := []string{"mail.Example.com."}
	if !dnsRecordsContain(hosts, "mail.example.com") {
		t.Error("case/dot-insensitive host match expected")
	}
	if !dnsRecordsContain(hosts, "EXAMPLE.COM") {
		t.Error("case-insensitive substring match expected")
	}
}

func TestRunDNSCheck(t *testing.T) {
	// An IP literal resolves to itself without any network / hosts-file lookup, so
	// these are deterministic.
	if res := runDNSCheck("127.0.0.1", models.MonitorConfig{DNSRecordType: "A"}); !res.Up {
		t.Errorf("127.0.0.1 A should be up, got error: %s", res.Error)
	}
	// default record type (empty) -> A
	if res := runDNSCheck("127.0.0.1", models.MonitorConfig{}); !res.Up {
		t.Errorf("empty record type should default to A, got error: %s", res.Error)
	}
	// expected value present -> up
	if res := runDNSCheck("127.0.0.1", models.MonitorConfig{DNSExpectedValue: "127.0.0.1"}); !res.Up {
		t.Errorf("matching expected value should be up, got: %s", res.Error)
	}
	// expected value absent -> down
	if res := runDNSCheck("127.0.0.1", models.MonitorConfig{DNSExpectedValue: "8.8.8.8"}); res.Up {
		t.Error("non-matching expected value should be down")
	}
	// unsupported record type -> down
	if res := runDNSCheck("127.0.0.1", models.MonitorConfig{DNSRecordType: "BOGUS"}); res.Up {
		t.Error("unsupported record type should be down")
	}
}
