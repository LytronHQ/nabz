package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// Every kind the evaluator logs must be a value channel_events.kind accepts.
// cert, latency and domain were not: PocketBase rejected each row, the evaluator
// only logged "channel_event log failed", and those deliveries never reached the
// channel page (#604).
func TestLoggedChannelEventKindsAreInSchema(t *testing.T) {
	raw, err := os.ReadFile("../infrastructure/pb_schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var cols []struct {
		Name   string `json:"name"`
		Fields []struct {
			Name   string   `json:"name"`
			Values []string `json:"values"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(raw, &cols); err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{}
	for _, c := range cols {
		if c.Name != "channel_events" {
			continue
		}
		for _, f := range c.Fields {
			if f.Name == "kind" {
				for _, v := range f.Values {
					allowed[v] = true
				}
			}
		}
	}
	if len(allowed) == 0 {
		t.Fatal("channel_events.kind not found in pb_schema.json")
	}

	call := regexp.MustCompile(`logChannelEvents\([^)]*"([a-z_]+)"\)`)
	files, _ := filepath.Glob("*.go")
	used := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range call.FindAllStringSubmatch(string(src), -1) {
			used++
			if !allowed[m[1]] {
				t.Errorf("%s logs kind %q, which channel_events.kind does not accept", f, m[1])
			}
		}
	}
	if used == 0 {
		t.Fatal("found no logChannelEvents calls; the pattern no longer matches the code")
	}
}
