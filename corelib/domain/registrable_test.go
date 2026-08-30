package domain

import "testing"

func TestRegistrableDomain(t *testing.T) {
	cases := []struct {
		target string
		want   string
	}{
		// Plain and subdomains reduce to eTLD+1.
		{"example.com", "example.com"},
		{"api.example.com", "example.com"},
		{"a.b.c.example.com", "example.com"},
		// Multi-label public suffixes (the whole reason we use the PSL).
		{"api.example.co.uk", "example.co.uk"},
		{"shop.example.com.au", "example.com.au"},
		// URLs and host:port forms.
		{"https://api.example.co.uk/health?x=1", "example.co.uk"},
		{"http://example.com", "example.com"},
		{"example.com:8443", "example.com"},
		{"db.example.org:5432", "example.org"},
		// Case and trailing dot are normalised.
		{"API.Example.COM.", "example.com"},
	}
	for _, c := range cases {
		got, err := RegistrableDomain(c.target)
		if err != nil {
			t.Errorf("RegistrableDomain(%q) unexpected error: %v", c.target, err)
			continue
		}
		if got != c.want {
			t.Errorf("RegistrableDomain(%q) = %q, want %q", c.target, got, c.want)
		}
	}
}

func TestRegistrableDomainNoDomain(t *testing.T) {
	// Targets with no registrable domain must return ErrNoDomain so callers skip
	// them silently rather than surfacing a false "unknown".
	noDomain := []string{
		"",
		"192.168.1.10",
		"10.0.0.1:8080",
		"http://127.0.0.1:3000/path",
		"[2001:db8::1]:443",
		"localhost",
		"localhost:8080",
	}
	for _, target := range noDomain {
		if got, err := RegistrableDomain(target); err == nil {
			t.Errorf("RegistrableDomain(%q) = %q, want ErrNoDomain", target, got)
		}
	}
}
